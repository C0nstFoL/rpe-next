import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { agentSettings } from '../src/ui/agent-panel.mjs';
import { AGENT_ROUTE_PRESETS, createAgentProfile, agentBaseUrl, agentRequestUrl, agentReasoningParameters, agentReasoningOptions } from '../src/core/agent-routing.mjs';
import { createCompatibleProvider, agentHttp } from '../src/platform/agent-provider.mjs';
import { prepareAgentHistory } from '../src/core/agent-context.mjs';

const response = deltas => new Response(deltas.map(delta => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n').join('') + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
const preset = id => AGENT_ROUTE_PRESETS.find(entry => entry.id === id);

test('旧配置迁移保留DeepSeek凭据标识、自定义模型、思考开关及输出上限；方案配置独立往返', () => {
  const migrated = agentSettings({ provider: 'deepseek', model: 'deepseek-v4-pro', thinking: false, maxTokens: 32768, uiVersion: 4 });
  assert.equal(migrated.activeProfile, 'deepseek'); assert.equal(migrated.profiles[0].model, 'deepseek-v4-pro'); assert.equal(migrated.thinking, false); assert.equal(migrated.maxTokens, 32768);
  const other = { ...createAgentProfile('openrouter', 'profile-router'), model: 'vendor/model', reasoningEffort: 'low', maxTokens: 16384, key: 'must-not-persist' };
  const settings = agentSettings({ ...migrated, profiles: [...migrated.profiles, other], activeProfile: other.id });
  const restored = agentSettings(JSON.parse(JSON.stringify(settings)));
  assert.equal(restored.provider, 'openrouter'); assert.equal(restored.reasoningEffort, 'low'); assert.equal(restored.profiles[0].model, 'deepseek-v4-pro'); assert.equal(restored.profiles[0].maxTokens, 32768);
  assert.equal(JSON.stringify(restored).includes('must-not-persist'), false);
  const back = agentSettings({ ...restored, activeProfile: 'deepseek' }); assert.equal(back.thinking, false); assert.equal(back.maxTokens, 32768);
});

test('DeepSeek使用原生low/high/max，关闭思考不发送effort；其他路由按各自格式请求', () => {
  const config = { ...createAgentProfile('deepseek'), reasoningEffort: 'max' };
  assert.deepEqual(agentReasoningOptions(config), ['auto', 'none', 'low', 'high', 'max']);
  assert.deepEqual(agentReasoningParameters(config), { thinking: { type: 'enabled' }, reasoning_effort: 'max' });
  assert.deepEqual(agentReasoningParameters({ ...config, thinking: false }), { thinking: { type: 'disabled' } });
  assert.deepEqual(agentReasoningParameters({ ...config, model: 'deepseek-reasoner' }), {});
  assert.deepEqual(agentReasoningParameters({ ...createAgentProfile('openrouter'), reasoningEffort: 'high' }), { reasoning: { effort: 'high' } });
  assert.deepEqual(agentReasoningParameters({ ...createAgentProfile('openai'), model: 'gpt-5.2', reasoningEffort: 'xhigh' }), { reasoning_effort: 'xhigh' });
  assert.deepEqual(agentReasoningParameters({ ...createAgentProfile('openai'), model: 'gpt-4.1', thinking: false }), {});
  assert.equal(agentReasoningOptions({ ...createAgentProfile('openai'), model: 'gpt-5-mini' }).includes('none'), false);
  assert.equal(agentReasoningOptions({ ...createAgentProfile('openai'), model: 'gpt-5.1' }).includes('none'), true);
  assert.deepEqual(agentReasoningParameters({ ...createAgentProfile('dashscope'), reasoningEffort: 'none' }), { enable_thinking: false });
  assert.deepEqual(agentReasoningParameters({ ...createAgentProfile('moonshot'), reasoningEffort: 'none' }), { thinking: { type: 'disabled' } });
  assert.deepEqual(agentReasoningParameters({ ...createAgentProfile('moonshot'), model: 'kimi-k3', reasoningEffort: 'max' }), { reasoning_effort: 'max' });
  assert.deepEqual(agentReasoningParameters({ ...createAgentProfile('custom'), reasoningEffort: 'high' }), {});
});

test('OpenRouter模型能力约束强度与禁用选项，不给不支持的模型发送推理参数', () => {
  const config = createAgentProfile('openrouter'), metadata = { reasoning: { supported_efforts: ['high', 'low'], mandatory: true } };
  assert.deepEqual(agentReasoningOptions(config, metadata), ['auto', 'high', 'low']);
  assert.deepEqual(agentReasoningParameters({ ...config, thinking: false }, metadata), {});
  assert.deepEqual(agentReasoningOptions(config, { supportedParameters: ['tools'] }), ['auto']);
  assert.deepEqual(agentReasoningOptions(config, { reasoning: { supported_efforts: null } }).includes('max'), true);
  assert.equal(agentReasoningOptions(config, { reasoning: { supported_efforts: null, mandatory: true } }).includes('none'), false);
});

test('API地址保留路由前缀、拒绝URL凭据与外部明文HTTP；工具不能借其他源转发密钥', () => {
  assert.equal(agentBaseUrl(' https://example.com/custom/v1/ '), 'https://example.com/custom/v1');
  assert.equal(agentRequestUrl('/chat/completions', 'https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(agentRequestUrl('/models', 'http://localhost:1234/v1'), 'http://localhost:1234/v1/models');
  for (const value of ['http://example.com/v1', 'https://user:pass@example.com', 'https://example.com/?key=secret', 'https://example.com/#key', 'file:///tmp', 'data:text/plain,test']) assert.throws(() => agentBaseUrl(value));
  assert.throws(() => agentRequestUrl('/chat/completions/../files', 'https://example.com'));
  assert.throws(() => agentRequestUrl('/v1/tools/search', 'https://example.com'));
  assert.equal(agentRequestUrl('/v1/tools/search', 'https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/tools/search');
});

test('兼容流适配保留OpenRouter文本与加密推理的顺序，工具续接不泄漏其他路由私有字段', async () => {
  const requests = [], details = [{ type: 'reasoning.text', text: '先读取', index: 0 }, { type: 'reasoning.encrypted', data: 'opaque', id: 'secret-block', index: 1 }];
  const provider = createCompatibleProvider(preset('openrouter'), async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response([{ reasoning_details: [details[0]] }, { reasoning_details: [details[1]], tool_calls: [{ index: 0, id: 'call1', function: { name: 'editor_context', arguments: '{}' } }] }]);
  });
  const config = { ...createAgentProfile('openrouter'), key: 'test-key', model: 'test/model', reasoningEffort: 'high' }, thought = [];
  const assistant = await provider.complete({ config, system: 'system', messages: [], tools: [], onReasoning: value => thought.push(value) });
  assert.deepEqual(assistant.reasoning_details, details); assert.equal(thought.join(''), '先读取');
  const messages = prepareAgentHistory([assistant, { role: 'tool', tool_call_id: 'call1', content: '{}' }]);
  await provider.complete({ config, system: 'system', messages, tools: [] });
  assert.deepEqual(requests[1].body.messages[1].reasoning_details, details); assert.equal(requests[1].body.messages[1].rpen_route, undefined);
  assert.deepEqual(requests[0].body.reasoning, { effort: 'high' });
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  await provider.complete({ config: { ...config, model: 'other/model' }, system: 'system', messages, tools: [] });
  assert.equal(requests[2].body.messages[1].reasoning_details, undefined); assert.equal(requests[2].body.messages[1].reasoning, undefined);
});

test('OpenRouter元信息获取长度、图像、模型列表、输出上限及强度，OpenAI使用独立输出参数', async () => {
  let body;
  const provider = createCompatibleProvider(preset('openrouter'), async (url, options) => options.method === 'GET' ? Response.json({ data: [{ id: 'test/model', context_length: 200000, architecture: { input_modalities: ['text', 'image'] }, top_provider: { max_completion_tokens: 8192 }, reasoning: { supported_efforts: ['high', 'low'], mandatory: true }, supported_parameters: ['tools', 'reasoning'] }] }) : (body = JSON.parse(options.body), response([{ content: 'ok' }])));
  const config = { ...createAgentProfile('openrouter'), model: 'test/model', key: 'test-key', reasoningEffort: 'low' }, info = await provider.modelInfo(config);
  assert.equal(info.images, true); assert.equal(info.contextWindow, 200000); assert.deepEqual(info.models, ['test/model']); assert.equal(info.reasoning.mandatory, true);
  await provider.complete({ config, system: '', messages: [], tools: [] }); assert.equal(body.max_tokens, 8192);
  const openai = createCompatibleProvider(preset('openai'), async (url, options) => (body = JSON.parse(options.body), response([{ content: 'ok' }])));
  await openai.complete({ config: { ...createAgentProfile('openai'), key: 'test-key', reasoningEffort: 'high' }, system: '', messages: [], tools: [] });
  assert.equal(body.max_completion_tokens, 65536); assert.equal(body.max_tokens, undefined); assert.equal(body.reasoning_effort, 'high'); assert.equal(body.thinking, undefined);
});

test('浏览器传输禁止重定向，错误响应隐藏密钥', async () => {
  await assert.rejects(agentHttp('/models', 'sensitive', {}, { baseUrl: 'https://example.com/v1', request: async (url, options) => { assert.equal(options.redirect, 'error'); return new Response('sensitive request rejected', { status: 401 }); } }), error => !error.responseBody.includes('sensitive'));
});

test('桌面流式IPC返回早于最后数据时等待收齐，停止时中止等待并释放监听', async () => {
  const original = globalThis.rpenAgentNetwork; let listener, disposed = false, data = '', requested;
  globalThis.rpenAgentNetwork = { onChunk(id, callback) { listener = callback; return () => { disposed = true; }; }, cancel() {}, async request() { requested?.(); return { ok: true, result: { chunks: 2 } }; } };
  try {
    const result = agentHttp('/chat/completions', 'test', { stream: true }, { onChunk: chunk => { data += chunk; } });
    await new Promise(resolve => setTimeout(resolve, 1)); listener('first'); assert.equal(disposed, false); listener('last'); await result;
    assert.equal(data, 'firstlast'); assert.equal(disposed, true);
    const controller = new AbortController(); let start;
    const ready = new Promise(resolve => { start = resolve; }); requested = start; disposed = false;
    const stopped = agentHttp('/chat/completions', 'test', { stream: true }, { signal: controller.signal });
    await ready; controller.abort(); await assert.rejects(stopped); assert.equal(disposed, true);
  } finally { if (original === undefined) delete globalThis.rpenAgentNetwork; else globalThis.rpenAgentNetwork = original; }
});

test('桌面代理沿用旧接口并支持安全自定义路由，拒绝错误框架和并发相同id', async () => {
  const { installAgentNetwork } = createRequire(import.meta.url)('../desktop/agent-network.cjs');
  let handle, release; const requests = [];
  const sender = { mainFrame: { url: 'rpe://app/' }, isDestroyed: () => false, send() {} }, event = { sender, senderFrame: sender.mainFrame };
  const cleanup = installAgentNetwork({ ipcMain: { on() {}, handle(name, callback) { handle = callback; } }, origin: 'rpe://app', window: () => ({ webContents: sender }), net: { fetch: async (url, options) => { requests.push({ url, options }); if (url.includes('wait')) await new Promise(resolve => { release = resolve; }); return Response.json({ data: [] }); } } });
  try {
    assert.equal((await handle(event, { id: 'legacy', path: '/models', key: 'test' })).ok, true); assert.equal(requests[0].url, 'https://api.deepseek.com/models');
    assert.equal((await handle(event, { id: 'router', path: '/models', baseUrl: 'https://openrouter.ai/api/v1', key: 'test' })).ok, true); assert.equal(requests[1].url, 'https://openrouter.ai/api/v1/models'); assert.equal(requests[1].options.redirect, 'error');
    assert.equal((await handle(event, { id: 'bad', path: '/models', baseUrl: 'http://example.com', key: 'test' })).ok, false);
    assert.equal((await handle({ ...event, senderFrame: { url: 'rpe://app/' } }, { id: 'frame', path: '/models', key: 'test' })).ok, false);
    const pending = handle(event, { id: 'same', path: '/models', baseUrl: 'https://wait.example.com', key: 'test' });
    assert.equal((await handle(event, { id: 'same', path: '/models', key: 'test' })).ok, false);
    while (!release) await new Promise(resolve => setTimeout(resolve, 1)); release(); assert.equal((await pending).ok, true);
    assert.equal(requests.length, 3);
  } finally { cleanup(); }
});
