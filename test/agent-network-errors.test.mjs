import test from 'node:test';
import assert from 'node:assert/strict';
import { agentApiError, agentConnectionError, agentResponseText } from '../src/core/agent-network-errors.mjs';
import { createCompatibleProvider } from '../src/platform/agent-provider.mjs';
import { agentRoutePreset, createAgentProfile } from '../src/core/agent-routing.mjs';
import { agentModelLabel } from '../src/ui/agent-routing-controls.mjs';

test('OpenRouter的HTTP错误保留状态、具体原因、上游详情与请求标识，不再误标为DeepSeek', () => {
  const error = agentApiError({ url: 'https://openrouter.ai/api/v1/chat/completions', status: 400, key: 'sensitive', requestId: 'request-123', body: JSON.stringify({ error: { code: 'invalid_request_error', message: 'Provider returned error', metadata: { provider_name: 'Test Provider', raw: JSON.stringify({ error: { message: 'Unsupported tool schema; key=sensitive, Bearer other-secret' } }) } } }) });
  assert.match(error.message, /openrouter.ai HTTP 400/); assert.match(error.message, /Unsupported tool schema/); assert.match(error.message, /invalid_request_error/); assert.match(error.message, /Test Provider/);
  assert.doesNotMatch(error.message, /DeepSeek|sensitive|other-secret/); assert.doesNotMatch(error.responseBody, /sensitive|other-secret/); assert.equal(error.requestId, 'request-123');
});

test('HTML网关错误不会将整张页面塞进对话，连接失败保留原始原因并区分超时和浏览器限制', () => {
  const html = agentApiError({ url: 'https://router.example/api/v1', status: 502, body: '<!doctype html><html><script>bad</script></html>' });
  assert.match(html.message, /502.*HTML/); assert.doesNotMatch(html.message, /<script>/);
  const network = agentConnectionError(TypeError('Failed to fetch'), { url: 'https://openrouter.ai', browser: true });
  assert.match(network.message, /openrouter.ai.*Failed to fetch/); assert.match(network.message, /代理.*CORS/); assert.equal(network.status, undefined);
  const timeout = agentConnectionError(Error('aborted'), { url: 'https://openrouter.ai', timedOut: true, browser: true });
  assert.match(timeout.message, /超时/); assert.doesNotMatch(timeout.message, /CORS/);
});

test('手动获取模型不会吞掉已缓存的网络错误，自动能力探测仍可回退', async () => {
  let calls = 0;
  const provider = createCompatibleProvider(agentRoutePreset('openrouter'), async () => { calls++; return Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }); });
  const config = { ...createAgentProfile('openrouter'), key: 'test' };
  assert.equal((await provider.modelInfo(config)).source, 'fallback'); assert.equal(calls, 1);
  await assert.rejects(provider.modelInfo(config, { strict: true }), /openrouter.ai HTTP 401: Invalid API key/); assert.equal(calls, 2);
});

test('SSE和HTTP200内嵌错误都保留实际服务消息并记录原响应', async () => {
  const error = { error: { code: 429, message: 'Rate limit exceeded', metadata: { raw: 'Upstream capacity exhausted' } } };
  for (const raw of ['data: ' + JSON.stringify(error) + '\n\n', JSON.stringify(error)]) {
    let trace;
    const provider = createCompatibleProvider(agentRoutePreset('openrouter'), async () => new Response(raw));
    await assert.rejects(provider.complete({ config: { ...createAgentProfile('openrouter'), key: 'test' }, system: '', messages: [], tools: [], onTrace: value => { if (value.response) trace = value.response; } }), /Rate limit exceeded.*Upstream capacity exhausted/);
    assert.equal(trace.body, raw);
  }
});

test('读取错误正文按字节限制，超限会取消流，模型短名不包含路由前缀', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('错误信息过长')); }, cancel() { cancelled = true; } }));
  await assert.rejects(agentResponseText(response, 8), /过大/); assert.equal(cancelled, true);
  assert.equal(agentModelLabel('anthropic/claude-sonnet-4.5'), 'claude-sonnet-4.5'); assert.equal(agentModelLabel('~openai/gpt-5'), 'gpt-5'); assert.equal(agentModelLabel('deepseek-flash'), 'deepseek-flash');
});
