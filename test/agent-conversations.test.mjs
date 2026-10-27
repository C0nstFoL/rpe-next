import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentConversations, conversationMessages } from '../src/application/agent-conversations.mjs';
import { AgentCommands } from '../src/core/agent-commands.mjs';
import { AgentProviders } from '../src/platform/agent-provider.mjs';
import { EditorAgent } from '../src/application/agent.mjs';
import { DEFAULT_AGENT_SETTINGS } from '../src/ui/agent-panel.mjs';
import { agentLink } from '../src/ui/agent-markdown.mjs';
import { DEFAULT_AGENT_PROMPT } from '../src/core/agent-prompt.mjs';
import { createAgentEditorCommands } from '../src/application/agent-editor.mjs';
import { AgentDialogues } from '../src/ui/agent-dialogues.mjs';
import { EditorSession } from '../src/application/session.mjs';

test('流式内容只在跟随底部时滚动，手动翻看保留位置，回到底部或发送新消息恢复，后台对话不干扰当前页面', () => {
  const active = {}, other = {}, viewport = { scrollHeight: 1000, clientHeight: 200, top: 0, get scrollTop() { return this.top; }, set scrollTop(value) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); } };
  const dialogues = Object.assign(Object.create(AgentDialogues.prototype), { viewport, visibleId: 'active', scrollStates: new Map(), store: { current: active }, running: { record: active } });
  dialogues.scroll(); assert.equal(viewport.scrollTop, 800);
  viewport.scrollHeight = 1200; dialogues.scroll(); assert.equal(viewport.scrollTop, 1000);
  viewport.scrollTop = 400; dialogues.trackScroll(); assert.equal(dialogues.scrollState().follow, false);
  viewport.scrollHeight = 1500; dialogues.scroll(); assert.equal(viewport.scrollTop, 400); assert.equal(dialogues.scrollState().top, 400);
  viewport.scrollTop = 1300; dialogues.trackScroll(); viewport.scrollHeight = 1700; dialogues.scroll(); assert.equal(viewport.scrollTop, 1500);
  viewport.scrollTop = 400; dialogues.trackScroll(); viewport.scrollTop = 1500; viewport.scrollHeight = 1900; dialogues.scroll(); assert.equal(viewport.scrollTop, 1700); assert.equal(dialogues.scrollState().follow, true);
  viewport.scrollHeight = 2100; dialogues.trackScroll(); assert.equal(dialogues.scrollState().follow, true); dialogues.scroll(); assert.equal(viewport.scrollTop, 1900);
  viewport.scrollTop = 300; dialogues.trackScroll(); dialogues.scroll(true); assert.equal(viewport.scrollTop, 1900); assert.equal(dialogues.scrollState().follow, true);
  dialogues.store.current = other; dialogues.visibleId = 'other'; dialogues.scrollStates.set('other', { top: 1900, bottom: 1900, follow: true, direction: 0 }); viewport.scrollTop = 70; dialogues.trackScroll(); viewport.scrollHeight = 2300; dialogues.scroll(); assert.equal(viewport.scrollTop, 70); assert.equal(dialogues.scrollState().follow, false);
  assert.equal(dialogues.scrollStates.get('active').top, 1900);
});

test('新会话上下文默认全部，独立最近轮次/无历史，按完整用户轮次保留工具配对', () => {
  const store = new AgentConversations(), first = store.current;
  for (let index = 0; index < 3; index++) first.turns.push({ text: 'turn ' + index, messages: [{ role: 'user', content: String(index) }, { role: 'assistant', content: null, tool_calls: [{ id: 'c' + index }] }, { role: 'tool', tool_call_id: 'c' + index, content: '{}' }, { role: 'assistant', content: 'done' }] });
  assert.equal(conversationMessages(first).length, 12);
  store.setContext(first.id, 'last', 1); const messages = conversationMessages(first); assert.equal(messages.length, 4); assert.equal(messages[0].content, '2');
  const second = store.create('second'); assert.equal(second.context.mode, 'all'); assert.equal(conversationMessages(second).length, 0);
  store.setContext(second.id, 'none', 1); assert.equal(first.context.mode, 'last'); store.select(first.id); assert.equal(store.current, first);
  messages[0].content = 'changed'; assert.equal(first.turns[2].messages[0].content, '2');
});

test('显式创建对话分支只复制目标之前的历史；重命名与删除不串上下文', () => {
  const store = new AgentConversations(), source = store.current; source.turns = [0, 1, 2].map(index => ({ id: index, text: String(index), messages: [{ role: 'user', content: String(index) }] }));
  store.setContext(source.id, 'last', 2); const branch = store.branch(source.id, 1); assert.equal(branch.turns.length, 1); assert.equal(source.turns.length, 3);
  branch.turns[0].text = 'other'; assert.equal(source.turns[0].text, '0'); assert.deepEqual(branch.context, { mode: 'last', turns: 2 });
  store.rename(branch.id, '分支'); assert.equal(store.current.title, '分支'); store.remove(branch.id); assert.equal(store.current.id, source.id);
  store.remove(source.id); assert.equal(store.records.size, 1); assert.equal(store.current.turns.length, 0);
});

test('重发截断原对话，保留标识、名称、上下文与早期工具轮次，清除覆盖后续消息的摘要和用量', () => {
  const store = new AgentConversations(), record = store.current; record.title = '保留名称';
  record.turns = Array.from({ length: 4 }, (_, index) => ({ id: 'turn-' + index, messages: [{ role: 'user', content: String(index) }, { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + index }] }, { role: 'tool', tool_call_id: 'call-' + index, content: '{}' }, { role: 'assistant', content: 'done' }] }));
  record.memory = { through: 'turn-3', messages: [{ role: 'user', content: '已丢弃的后续消息摘要' }] }; record.contextUsage = { tokens: 4000 };
  const other = store.create('另一对话'); other.draft = '另一份草稿'; const before = structuredClone(other), original = record.turns[0];
  const removed = store.truncate(record.id, 2);
  assert.equal(store.records.size, 2); assert.equal(store.current, record); assert.equal(record.title, '保留名称'); assert.equal(record.turns[0], original);
  assert.deepEqual(record.turns.map(turn => turn.id), ['turn-0', 'turn-1']); assert.deepEqual(removed.map(turn => turn.id), ['turn-2', 'turn-3']);
  assert.equal(record.memory, undefined); assert.equal(record.contextUsage, undefined); assert.deepEqual(record.context, { mode: 'all', turns: 6 }); assert.deepEqual(other, before);
  const messages = conversationMessages(record); assert.equal(messages.length, 8); assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages.some(message => message.content?.includes('后续消息')), false);
});

test('截断不会丢弃只涵盖保留轮次的压缩摘要，最近N轮设置不变，非法位置不修改历史', () => {
  const store = new AgentConversations(), record = store.current;
  record.turns = [0, 1, 2].map(index => ({ id: 'turn-' + index, messages: [{ role: 'user', content: 'task-' + index }] }));
  record.memory = { through: 'turn-0', messages: [{ role: 'user', content: 'safe summary' }] };
  store.truncate(record.id, 2); assert.deepEqual(conversationMessages(record).map(message => message.content), ['safe summary', 'task-1']);
  store.setContext(record.id, 'last', 1); const before = store.snapshot();
  for (const position of [-1, 0.5, 2, NaN]) assert.throws(() => store.truncate(record.id, position)); assert.deepEqual(store.snapshot(), before);
  store.truncate(record.id, 1); assert.deepEqual(record.context, { mode: 'last', turns: 1 }); assert.deepEqual(conversationMessages(record).map(message => message.content), ['task-0']);
});

test('原对话重发清理后续视图、队列与旧请求缓存，压缩重试也从原位置重新开始', async () => {
  const store = new AgentConversations(), record = store.current; record.turns = [0, 1, 2].map(index => ({ id: 'turn-' + index, text: 'task-' + index, status: index === 2 ? 'queued' : 'completed', exchanges: [{ id: 'trace-' + index }], messages: [{ role: 'user', content: 'task-' + index }] }));
  record.memory = { through: 'turn-2', messages: [] }; const discarded = record.turns.slice(1), activeExchanges = new Map(record.turns.map(turn => [turn.exchanges[0].id, {}])), turns = new WeakMap(); let removed = 0, sent;
  for (const turn of record.turns) turns.set(turn, { root: { remove() { removed++; } } });
  const dialogues = Object.assign(Object.create(AgentDialogues.prototype), { store, generation: 1, ready: Promise.resolve(), panel: { agent: { busy: false }, key: 'test-key', credentialsReady: Promise.resolve(), input: { value: '' } }, dirtyTurns: new Set(record.turns), dirtyMemories: new Set([record]), turnViews: turns, activeExchanges, scrollStates: new Map(),
    show: id => store.select(id), save() {}, send: (source, instruction, options) => { sent = { source, instruction, options, history: conversationMessages(record) }; } });
  await dialogues.resend(record, record.turns[1], '改后的消息', { compactOnly: true });
  assert.equal(store.records.size, 1); assert.equal(store.current, record); assert.equal(record.turns.length, 1); assert.equal(removed, 2); assert.equal(dialogues.dirtyMemories.size, 0);
  assert.equal(sent.source, '改后的消息'); assert.equal(sent.options.compactOnly, true); assert.deepEqual(sent.history.map(message => message.content), ['task-0']);
  for (const turn of discarded) { assert.equal(turns.has(turn), false); assert.equal(dialogues.dirtyTurns.has(turn), false); assert.equal(activeExchanges.has(turn.exchanges[0].id), false); }
});

test('重发等待凭据时换谱面或缺少Key，不会提前丢弃原对话', async () => {
  const store = new AgentConversations(), record = store.current; record.turns = [{ id: 'first', text: 'task', messages: [] }]; let release, configured = 0;
  const dialogues = Object.assign(Object.create(AgentDialogues.prototype), { store, generation: 1, ready: Promise.resolve(), panel: { agent: { busy: false }, key: 'test', credentialsReady: new Promise(resolve => { release = resolve; }), configuration() { configured++; } } });
  const pending = dialogues.resend(record, record.turns[0], 'retry'); dialogues.generation++; release(); await pending; assert.equal(record.turns.length, 1);
  dialogues.panel.key = ''; await dialogues.resend(record, record.turns[0], 'retry'); assert.equal(configured, 1); assert.equal(record.turns.length, 1);
});

test('默认输出65536；Markdown链接不允许脚本与本地文件，提示词包含广义概念分类', () => {
  assert.equal(DEFAULT_AGENT_SETTINGS.maxTokens, 65536);
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///secret', 'relative/path']) assert.equal(agentLink(url), null);
  assert.equal(agentLink('https://example.com/a'), 'https://example.com/a'); assert.ok(DEFAULT_AGENT_PROMPT.includes('工作区状态')); assert.ok(DEFAULT_AGENT_PROMPT.includes('命名实体')); assert.ok(!DEFAULT_AGENT_PROMPT.includes('111'));
});

test('每轮统计汇总实际返回用量、模型和请求时间；仅回传当前轮消息，不泄漏统计字段到模型', async () => {
  let count = 0; const commands = new AgentCommands(), providers = new AgentProviders(), session = {};
  commands.register({ name: 'probe', access: 'read', description: 'test', parameters: { type: 'object' }, prepare: () => ({ apply: () => 1 }) });
  providers.register({ id: 'fixture', complete: async request => {
    assert.ok(!request.messages.some(message => message.usage || message.model)); count++;
    if (count === 1) { request.onReasoning('返回的思考'); return { role: 'assistant', content: null, reasoning_content: '返回的思考', tool_calls: [{ id: 'a', type: 'function', function: { name: 'probe', arguments: '{}' } }], model: 'model-a', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 } } }; }
    return { role: 'assistant', content: 'done', model: 'model-a', usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 } };
  } });
  const agent = new EditorAgent({ commands, providers, context: () => ({ session, summary: {} }), config: () => ({ provider: 'fixture', model: 'model', key: 'test', permission: 'full' }), prompt: () => '' });
  let ended, thought; agent.addEventListener('turn-end', event => { ended = event.detail; }); agent.addEventListener('reasoning', event => { thought = event.detail.delta; });
  await agent.run('test', { history: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }] });
  assert.equal(ended.status, 'completed'); assert.equal(ended.statistics.model, 'model-a'); assert.equal(ended.statistics.requests, 2); assert.equal(ended.statistics.promptTokens, 30); assert.equal(ended.statistics.totalTokens, 42); assert.equal(ended.statistics.reasoningTokens, 3); assert.equal(thought, '返回的思考'); assert.equal(ended.messages[0].content, 'test');
});

test('工作区命名导航和时间单位不修改谱面；切线工具不接受偷偷附带的时间字段', async () => {
  const session = new EditorSession(); session.chart.markers = [{ name: '24', time: 7.5 }, { name: 'same', time: 2 }, { name: 'same', time: 3 }]; session.chart.META.offset = 500; session.line.bpmfactor = 2;
  let seconds = 0; const editor = { hasDocument: true, session, get chart() { return session.chart; }, timeline: { layer: 0 }, assets: new Map(), currentBeat: () => seconds, chartSeconds: () => seconds, seek: value => { seconds = value; }, invalidate() {} };
  const commands = new AgentCommands(), adapter = createAgentEditorCommands(commands, editor);
  assert.equal(adapter.summary().namedEntities.markers[0].name, '24');
  const before = JSON.stringify(session.chart);
  const execute = args => commands.execute('editor_navigate', args, { permission: 'full' });
  await execute({ target: 'marker', name: '24' }); assert.equal(seconds, 7.5);
  await execute({ target: 'global_beat', value: 10 }); assert.equal(seconds, 5);
  await execute({ target: 'line_beat', value: 10 }); assert.equal(seconds, 10);
  await execute({ target: 'music_seconds', value: 10 }); assert.equal(seconds, 9.5);
  await assert.rejects(execute({ target: 'marker', name: 'same' }), /同名/); assert.equal(seconds, 9.5);
  await assert.rejects(commands.execute('editor_view', { line: 0, beat: 10 }, { permission: 'full' }), /未知参数/);
  assert.equal(JSON.stringify(session.chart), before); assert.equal(session.history.undoStack.length, 0);
});
