import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EditorAgent } from '../src/application/agent.mjs';
import { AgentCommands, agentSchema } from '../src/core/agent-commands.mjs';
import { agentContextPolicy, agentContextUsage, AGENT_COMPACTION_PROMPT } from '../src/core/agent-context.mjs';
import { AgentProviders, createDeepSeekProvider } from '../src/platform/agent-provider.mjs';
import { DEFAULT_AGENT_SETTINGS, agentSettings } from '../src/ui/agent-panel.mjs';
import { agentCaptureRect } from '../src/ui/agent-capture.mjs';

function engine(complete, { config = {}, now, modelInfo } = {}) {
  const commands = new AgentCommands(), providers = new AgentProviders(), session = {};
  commands.register({ name: 'check', description: 'read', access: 'read', parameters: agentSchema(), prepare: () => ({ apply: () => 'done' }) });
  providers.register({ id: 'fixture', capabilities: () => ({ contextWindow: 1048576 }), complete, modelInfo });
  return new EditorAgent({ commands, providers, context: () => ({ session, summary: {} }), config: () => ({ provider: 'fixture', model: 'fixture-model', key: 'test-key', permission: 'full', maxTokens: 1024, ...config }), prompt: () => 'system', now });
}
const tool = () => ({ role: 'assistant', content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name: 'check', arguments: '{}' } }] });

test('默认128轮、自动压缩65%，DeepSeek未知模型长度使用1M；升级保留自定义值', () => {
  assert.equal(DEFAULT_AGENT_SETTINGS.maxRounds, 128); assert.equal(DEFAULT_AGENT_SETTINGS.autoCompact, true); assert.equal(DEFAULT_AGENT_SETTINGS.contextBudget, 0);
  assert.equal(agentContextPolicy({ provider: 'deepseek' }).contextWindow, 1048576);
  assert.equal(agentContextPolicy({ maxTokens: 1024 }, { contextWindow: 2000000 }).threshold, 1300000);
  assert.equal(agentContextPolicy({ maxTokens: 1024, contextBudget: 50000 }, { contextWindow: 100000 }).threshold, 50000);
  assert.equal(agentContextPolicy({ autoCompact: false }).automatic, false);
  const defaults = agentSettings({ uiVersion: 3, maxRounds: 24, contextBudget: 131072 }); assert.equal(defaults.maxRounds, 128); assert.equal(defaults.contextBudget, 0);
  const custom = agentSettings({ uiVersion: 3, maxRounds: 67, contextBudget: 40000 }); assert.equal(custom.maxRounds, 67); assert.equal(custom.contextBudget, 40000);
  assert.deepEqual(agentContextUsage(500, { contextWindow: 1000, threshold: 650 }).ratio, 0.5);
});

test('模型元信息使用GET读取长度并缓存；接口没有长度或不可用时回退1M', async () => {
  let calls = 0;
  const provider = createDeepSeekProvider(async (url, options) => { calls++; assert.equal(url, 'https://api.deepseek.com/models'); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); return Response.json({ data: [{ id: 'deepseek-flash', context_window: 2000000 }] }); });
  const config = { key: 'test-key', model: 'deepseek-flash' };
  assert.equal((await provider.modelInfo(config)).contextWindow, 2000000); await provider.modelInfo(config); assert.equal(calls, 1);
  assert.equal((await createDeepSeekProvider(async () => Response.json({ data: [] })).modelInfo(config)).contextWindow, 1048576);
  assert.equal((await createDeepSeekProvider(async () => { throw Error('offline'); }).modelInfo(config)).source, 'fallback');
  const controller = new AbortController(); controller.abort(); await assert.rejects(provider.modelInfo({ ...config, model: 'another' }, { signal: controller.signal }));
});

test('运行计时和请求用时使用同一单调时钟，不受系统时间变化影响', async () => {
  let clock = 100, ended; const original = Date.now;
  const agent = engine(async () => { clock = 2100; assert.equal(agent.elapsedMs(), 2000); Date.now = () => original() - 900000; clock = 4100; return { role: 'assistant', content: 'done' }; }, { now: () => clock });
  agent.addEventListener('turn-end', event => { ended = event.detail; });
  try { await agent.run('task'); } finally { Date.now = original; }
  assert.equal(ended.statistics.durationMs, 4000); assert.equal(ended.statistics.requestMs, 4000); assert.equal(agent.elapsedMs(), 4000);
});

test('关闭自动压缩后不偷偷压缩，手动压缩仍可使用；用量采用当前请求而非累计token', async () => {
  let compressed = 0, ended; const meters = [];
  const agent = engine(async request => {
    if (request.system === AGENT_COMPACTION_PROMPT) { compressed++; return { role: 'assistant', content: 'summary' }; }
    return { role: 'assistant', content: 'done', usage: { prompt_tokens: 4000, completion_tokens: 100, total_tokens: 4100 } };
  }, { config: { autoCompact: false, contextBudget: 8192 } });
  agent.addEventListener('context-usage', event => meters.push(event.detail)); agent.addEventListener('turn-end', event => { ended = event.detail; });
  const history = Array.from({ length: 20 }, () => ({ role: 'user', content: '字'.repeat(1000) }));
  await agent.run('continue', { history }); assert.equal(compressed, 0); assert.equal(meters.at(-1).tokens, 4100); assert.equal(meters.at(-1).estimated, false);
  await agent.run('', { history, compactOnly: true }); assert.ok(compressed > 0); assert.equal(ended.compacted, true);
});

test('提供商动态上下文参与65%阈值；默认任务可以完成超过100轮', async () => {
  let requests = 0, ended, usage;
  const agent = engine(async () => ++requests <= 105 ? tool() : { role: 'assistant', content: 'done' }, { modelInfo: async () => ({ contextWindow: 2000000 }) });
  agent.addEventListener('context-usage', event => { usage = event.detail; }); agent.addEventListener('turn-end', event => { ended = event.detail; });
  await agent.run('task'); assert.equal(requests, 106); assert.equal(ended.status, 'completed'); assert.equal(usage.threshold, 1300000); assert.equal(usage.contextWindow, 2000000);
});

test('截图裁切到当前可见区域，桌面截图限制本窗口主框架并校验范围', async () => {
  assert.deepEqual(agentCaptureRect({ x: -2, y: 5, width: 30, height: 80 }, { width: 50, height: 60 }), { x: 0, y: 5, width: 28, height: 55 });
  assert.throws(() => agentCaptureRect({ x: 100, y: 5, width: 20, height: 10 }, { width: 50, height: 60 }));
  const { installAgentCapture } = createRequire(import.meta.url)('../desktop/agent-capture.cjs'); let handle, captured;
  const image = { isEmpty: () => false, getSize: () => ({ width: 1000 }), toDataURL: () => 'data:image/png;base64,test' };
  const webContents = { mainFrame: { url: 'rpe://app/' }, getZoomFactor: () => 1.25, capturePage: async rect => { captured = rect; return image; } };
  const window = { webContents, getContentSize: () => [1000, 800] };
  installAgentCapture({ ipcMain: { handle: (name, handler) => { handle = handler; } }, origin: 'rpe://app', window: () => window });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  assert.equal((await handle(event, { x: 10, y: 20, width: 100, height: 80 })).ok, true); assert.deepEqual(captured, { x: 12, y: 25, width: 125, height: 100 });
  assert.equal((await handle({ ...event, senderFrame: { url: 'rpe://app/' } }, { x: 0, y: 0, width: 20, height: 20 })).ok, false);
  assert.equal((await handle(event, { x: 0, y: 0, width: 1200, height: 80 })).ok, false);
});
