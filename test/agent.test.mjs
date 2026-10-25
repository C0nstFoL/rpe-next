import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCommands, agentSchema } from '../src/core/agent-commands.mjs';
import { agentChartPatch, agentAt, agentShake, agentCircle } from '../src/core/agent-chart.mjs';
import { createAgentEditorCommands } from '../src/application/agent-editor.mjs';
import { EditorAgent } from '../src/application/agent.mjs';
import { createDeepSeekProvider, AgentProviders } from '../src/platform/agent-provider.mjs';
import { createChart, createLine, createNote } from '../src/core/chart.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { beatValue } from '../src/core/beat.mjs';
import { noiseRuntime } from '../src/core/noise-areas.mjs';
import { analyzeAgentAudio } from '../src/core/agent-audio.mjs';
import { DEFAULT_AGENT_PROMPT } from '../src/core/agent-prompt.mjs';
import { ModRuntime, ModScope } from '../src/ui/mod-runtime.mjs';

function fixture() {
  const session = new EditorSession(), commands = new AgentCommands();
  const editor = { session, get chart() { return session.chart; }, hasDocument: true, currentBeat: () => 0, chartSeconds: () => 0, audio: {}, assets: new Map(), timeline: { layer: 0 }, noiseEditor: { selection: new Set(), selected: -1 }, globalEvents: { document: { types: [] } }, commit: (label, chart) => session.commit(label, chart) };
  const adapter = createAgentEditorCommands(commands, editor, { controls: {}, network: async () => ({ results: [] }), ask: async () => ({ answer: 'yes' }) });
  const execute = (name, args, options = {}) => commands.execute(name, args, { permission: 'full', ...options });
  return { editor, session, commands, adapter, execute };
}

test('三种权限在执行层落实，读取自动，普通编辑与危险操作分别批准；拒绝不执行', async () => {
  for (const permission of ['ask', 'dangerous', 'full']) for (const access of ['read', 'edit', 'dangerous']) {
    const commands = new AgentCommands(); let changes = 0, approvals = 0;
    commands.register({ name: 'test_command', description: 'test', parameters: agentSchema(), access, prepare: () => ({ apply: () => ++changes }) });
    const result = await commands.execute('test_command', {}, { permission, approve: async () => { approvals++; return false; } });
    const requires = access !== 'read' && (permission === 'ask' || permission === 'dangerous' && access === 'dangerous');
    assert.equal(approvals, Number(requires)); assert.equal(changes, Number(!requires)); assert.equal(Boolean(result.denied), requires);
  }
});

test('准备失败、非法参数、过期修订、状态变化和停止均不能触发编辑', async () => {
  const { commands, execute, adapter, session } = fixture(), revision = adapter.revision();
  await assert.rejects(execute('chart_patch', { revision, operations: [{ op: 'set', path: '/META/name', value: 'new' }] }, { permission: 'ask', approve: async () => { session.commit('manual', { ...session.chart, META: { ...session.chart.META, name: 'manual' } }); return true; } }), /状态已变化/);
  assert.equal(session.chart.META.name, 'manual');
  await assert.rejects(execute('chart_patch', { revision, operations: [] }), /数组长度无效/);
  await assert.rejects(execute('chart_patch', { revision, operations: [{ op: 'set', path: '/META/name', value: 'new' }] }), /版本已变化/);
  await assert.rejects(commands.execute('editor_context', { injected: 1 }), /未知参数/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(commands.execute('editor_context', {}, { signal: controller.signal }), /停止/);
});

test('任意JSON字段可局部修改并保留未知属性，特殊键是自有数据，失败整体原子回滚', () => {
  const chart = createChart(); chart.extension = JSON.parse('{"__proto__":{"safe":1},"data":[1,2]}');
  const changed = agentChartPatch(chart, [{ op: 'set', path: '/extension/__proto__/safe', value: 2 }, { op: 'insert', path: '/extension/data/-', value: 3 }, { op: 'set', path: '/META/composer', value: 'test' }]);
  assert.equal(agentAt(changed.chart, '/extension/__proto__/safe'), 2); assert.equal(chart.extension.__proto__.safe, 1); assert.equal({}.safe, undefined);
  assert.throws(() => agentAt({}, '/__proto__/polluted'), /不存在路径/);
  assert.throws(() => agentChartPatch(chart, [{ op: 'set', path: '/META/name', value: 'bad' }, { op: 'set', path: '/BPMList/0/bpm', value: 0 }]));
  assert.equal(chart.META.name, '未命名谱面'); assert.deepEqual(changed.chart.extension.data, [1, 2, 3]);
});

test('通用生成与表达式变换能够完成预设之外的音符轨迹、元数据和模组字段任务并撤销', async () => {
  const { execute, adapter, session } = fixture();
  const result = await execute('chart_generate', { revision: adapter.revision(), path: '/judgeLineList/0/notes', count: 16, template: createNote(3, 0, 0), expressions: { '/startTime': '12+i/4', '/endTime': '12+i/4', '/positionX': '300*sin(u*pi*2)' }, label: '弧形红键' });
  assert.equal(result.result.undoable, true); assert.equal(session.notes.length, 16); assert.ok(session.notes.every(note => note.type === 3));
  const before = session.chart;
  await execute('chart_transform', { revision: adapter.revision(), path: '/judgeLineList/0/notes', where: 'beat>=14', expressions: { '/size': '1+u', '/positionX': '-positionX' } });
  assert.equal(session.notes.at(-1).size, 2); session.travel('undo'); assert.equal(session.chart, before);
  await execute('chart_patch', { revision: adapter.revision(), operations: [{ op: 'set', path: '/customModData', value: { semantic: 'any', arbitrary: [1, 2] } }] });
  assert.deepEqual(session.chart.customModData.arbitrary, [1, 2]);
});

test('通用表达式不能执行任意JS，数组读写支持分页和查询，读不产生审批与历史', async () => {
  const { execute, adapter, session } = fixture(); session.chart.judgeLineList[0].notes = [createNote(1, 1, 20), createNote(4, 2, -20)];
  const result = await execute('chart_query', { path: '/judgeLineList/0/notes', where: [{ field: 'type', op: 'eq', value: 4 }], fields: ['type', 'positionX'] });
  assert.equal(result.result.total, 1); assert.equal(result.result.entries[0].index, 1);
  const read = await execute('chart_read', { path: '/judgeLineList/0/notes', offset: 1, limit: 1, fields: ['type'] }); assert.equal(read.result.items[0].value.type, 4);
  await assert.rejects(execute('chart_transform', { revision: adapter.revision(), path: '/judgeLineList/0/notes', expressions: { '/size': 'globalThis.eval(1)' } }));
  assert.equal(session.history.undoStack.length, 0);
});

test('危险删线保持父线引用并要求批准，普通BPM编辑支持分数拍并遵守权限', async () => {
  const { execute, adapter, session } = fixture(); session.chart.judgeLineList.push(createLine()); session.chart.judgeLineList[1].father = 0;
  let asked = 0;
  const denied = await execute('line_manage', { revision: adapter.revision(), action: 'delete', line: 0 }, { permission: 'dangerous', approve: async () => { asked++; return false; } });
  assert.equal(denied.denied, true); assert.equal(session.chart.judgeLineList.length, 2);
  await execute('bpm_set', { revision: adapter.revision(), entries: [{ beat: 0, bpm: 160 }, { beat: '3:1/2', bpm: 170 }] }, { permission: 'dangerous', approve: async () => assert.fail('普通BPM修改不应申请危险审批') });
  assert.equal(beatValue(session.chart.BPMList[1].startTime), 3.5);
  await execute('line_manage', { revision: adapter.revision(), action: 'delete', line: 0 }, { permission: 'dangerous', approve: async () => { asked++; return true; } });
  assert.equal(session.chart.judgeLineList[0].father, -1); assert.equal(asked, 2);
});

test('生成器保持噪域语义：圆周中心轨迹准确，振动精确回基线，跨边界事件不覆盖', () => {
  const chart = createChart(); chart.judgeLineList[0].eventLayers[0].moveXEvents = [];
  const shaken = agentShake(chart, { line: 0, track: 'moveXEvents', start: 4, duration: 8, amplitude: 80, cycles: 4, decayEasing: 4 });
  assert.equal(shaken.chart.judgeLineList[0].eventLayers[0].moveXEvents.at(-1).end, 0);
  assert.throws(() => agentShake(chart, { line: 0, track: 'moveYEvents', start: 0.5, duration: 2, amplitude: 80, cycles: 4, decayEasing: 4, replace: true }), /边界/);
  const circular = agentCircle(chart, { start: 4, duration: 8, centerX: 100, centerY: 200, radius: 80, width: 60, height: 40, samples: 128 });
  const runtime = noiseRuntime(circular.chart.blockAreaList[0], new TempoMap(chart.BPMList));
  const first = runtime.sample(2), quarter = runtime.sample(3);
  assert.ok(Math.abs(first.center.x - 180) < 1e-6); assert.ok(Math.abs(quarter.center.x - 100) < 1e-6); assert.ok(Math.abs(quarter.center.y - 120) < 1e-6);
});

function pulseBuffer() {
  const rate = 10000, data = new Float32Array(rate * 8);
  for (let beat = 0; beat < 14; beat++) for (let index = 0; index < 70; index++) data[Math.round((0.5 + beat * 0.5) * rate) + index] = (index % 2 ? -1 : 1) * (1 - index / 70);
  return { sampleRate: rate, duration: 8, length: data.length, numberOfChannels: 1, getChannelData: () => data };
}
test('本地采音返回真实PCM瞬态，延迟与判定线倍率被考虑，只生成Tap且一次撤销', async () => {
  const buffer = pulseBuffer(); const result = await analyzeAgentAudio(buffer, { startSeconds: 0.2, endSeconds: 4, minGap: 0.1 }); assert.ok(result.peaks.length >= 6);
  const { execute, adapter, session, editor } = fixture(); editor.audio.buffer = buffer; session.chart.META.offset = 500; session.chart.judgeLineList[0].bpmfactor = 2;
  const created = await execute('audio_taps', { revision: adapter.revision(), line: 0, start: 0, end: 4, division: 4 });
  assert.ok(created.result.added >= 3); assert.ok(session.notes.every(note => note.type === 1 && beatValue(note.startTime) < 4));
  session.travel('undo'); assert.equal(session.notes.length, 0);
});

const toolCall = (name, args, id = 'call_1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
test('Agent通用工具循环处理多轮、拒绝、询问和失败，系统提示包含完整专业规则', async () => {
  const { commands, adapter, session } = fixture(), providers = new AgentProviders(); let round = 0;
  const replies = [
    { role: 'assistant', content: null, reasoning_content: 'analysis', tool_calls: [toolCall('editor_context', {})] },
    { role: 'assistant', content: null, tool_calls: [toolCall('chart_patch', { revision: adapter.revision(), operations: [{ op: 'set', path: '/META/name', value: 'blocked' }] })] },
    { role: 'assistant', content: '已保留原样' },
  ];
  providers.register({ id: 'fixture', complete: async request => { assert.match(request.system, /噪域/); assert.ok(request.tools.some(tool => tool.function.name === 'chart_transform')); return replies[round++]; } });
  const agent = new EditorAgent({ commands, providers, context: () => ({ session, summary: {} }), config: () => ({ provider: 'fixture', key: 'secret', permission: 'ask' }), prompt: () => DEFAULT_AGENT_PROMPT, approve: async () => false });
  await agent.run('修改名字'); assert.equal(round, 3); assert.notEqual(session.chart.META.name, 'blocked');
  assert.ok(agent.messages.some(message => message.role === 'tool' && message.content.includes('denied')));
});

test('DeepSeek流式适配重组跨chunk的工具参数、保留推理字段、区分识图能力与停止', async () => {
  let body;
  const request = async (url, options) => {
    body = JSON.parse(options.body);
    const lines = [{ choices: [{ delta: { reasoning_content: 'thinking' } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'editor_context', arguments: '{' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] }];
    const data = lines.map(line => 'data: ' + JSON.stringify(line) + '\n\n').join('') + 'data: [DONE]\n\n';
    return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < data.length; index += 7) controller.enqueue(new TextEncoder().encode(data.slice(index, index + 7))); controller.close(); } }));
  };
  const provider = createDeepSeekProvider(request), assistant = await provider.complete({ config: { key: 'test', model: 'deepseek-flash', thinking: true }, system: 'test', messages: [], tools: [], signal: new AbortController().signal });
  assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(assistant.reasoning_content, 'thinking'); assert.equal(assistant.tool_calls[0].function.arguments, '{}');
  assert.equal(provider.capabilities('deepseek-v4-pro').images, false); assert.equal(provider.capabilities('deepseek-flash').images, true);
});

test('被卸载的扩展命令和并发调用不能越过审批执行', async () => {
  const commands = new AgentCommands(); let approve, edits = 0;
  const remove = commands.register({ name: 'mod_test', access: 'edit', description: 'test', parameters: agentSchema(), prepare: () => ({ apply: () => edits++ }) }, 'test');
  const pending = commands.execute('mod_test', {}, { permission: 'ask', approve: () => new Promise(resolve => { approve = resolve; }) });
  await new Promise(resolve => setTimeout(resolve, 0)); await assert.rejects(commands.execute('mod_test', {}), /执行中/);
  remove(); approve(true); await assert.rejects(pending, /卸载/); assert.equal(edits, 0);
});

test('历史只读不申请批准，危险命令不能通过计划降级，深层批量删除同样检测危险', async () => {
  const { execute, commands } = fixture();
  await execute('history', { action: 'list' }, { permission: 'ask', approve: async () => assert.fail('读历史不应审批') });
  commands.register({ name: 'danger_test', access: 'dangerous', parameters: agentSchema(), description: 'test', prepare: () => ({ access: 'read', apply: () => assert.fail('未批准') }) });
  const denied = await commands.execute('danger_test', {}, { permission: 'dangerous', approve: async () => false }); assert.equal(denied.denied, true);
  const chart = createChart(); chart.judgeLineList[0].notes = Array.from({ length: 100 }, (unused, index) => createNote(1, index, 0));
  assert.equal(agentChartPatch(chart, Array.from({ length: 60 }, () => ({ op: 'remove', path: '/judgeLineList/0/notes/0' }))).dangerous, true);
});

test('DeepSeek网络工具使用独立官方参数，API错误不会输出Authorization，流式中断不返回半个工具调用', async () => {
  const calls = [];
  const provider = createDeepSeekProvider(async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return new Response('{"results":[]}'); });
  await provider.search({ key: 'sensitive' }, '音乐 BPM'); await provider.fetch({ key: 'sensitive' }, 'https://example.com/');
  assert.deepEqual(calls[0], { url: 'https://api.deepseek.com/v1/tools/search', body: { query: '音乐 BPM', count: 5, need_content: false } });
  assert.deepEqual(calls[1].body, { url: 'https://example.com/' }); assert.ok(!JSON.stringify(calls).includes('sensitive'));
  const invalid = createDeepSeekProvider(async () => new Response('sensitive', { status: 401 }));
  await assert.rejects(invalid.search({ key: 'sensitive' }, 'query'), error => /401/.test(error.message) && !error.message.includes('sensitive'));
  const interrupted = createDeepSeekProvider(async () => new Response('data: {"choices":[{"delta":{"tool_calls":[{"id":"c","index":0,"function":{"name":"chart_patch","arguments":"{}"}}]}}]}\n\n'));
  await assert.rejects(interrupted.complete({ config: { key: 'test', model: 'deepseek-flash' }, system: '', messages: [], tools: [] }), /中断/);
});

test('停止含多个工具的轮次不会留下无法续接的孤立工具消息', async () => {
  const commands = new AgentCommands(), providers = new AgentProviders(); let pending;
  commands.register({ name: 'wait', description: 'wait', access: 'edit', parameters: agentSchema(), prepare: () => ({ apply: () => null }) });
  providers.register({ id: 'fixture', complete: async () => ({ role: 'assistant', content: null, tool_calls: [toolCall('wait', {}, 'a'), toolCall('wait', {}, 'b')] }) });
  const session = {}, agent = new EditorAgent({ commands, providers, context: () => ({ session, summary: {} }), config: () => ({ provider: 'fixture', key: 'test', permission: 'ask' }), prompt: () => '', approve: (plan, signal) => new Promise(resolve => { pending = resolve; signal.addEventListener('abort', () => resolve(false), { once: true }); }) });
  const run = agent.run('test'); while (!pending) await new Promise(resolve => setTimeout(resolve, 0)); agent.stop(); await run;
  assert.ok(!agent.messages.some(message => message.tool_calls)); assert.equal(agent.busy, false);
});

test('模组可注册任意领域的Agent命令，命名隔离、权限一致且随作用域卸载', async () => {
  const commands = new AgentCommands(), scope = new ModScope(assert.fail), runtime = new ModRuntime({ editor: { agent: { commands } } });
  const api = runtime.createApi({ id: 'palette-test', scope, record: { manifest: { id: 'palette-test' } } });
  api.agent.register({ name: 'palette', description: '自定义领域', access: 'edit', parameters: agentSchema(), prepare: () => ({ apply: () => ({ palette: [1, 2] }) }) });
  assert.equal(api.agent.list()[0].function.name, 'mod_palette_test_palette');
  const denied = await commands.execute('mod_palette_test_palette', {}, { permission: 'ask', approve: async () => false }); assert.equal(denied.denied, true);
  const result = await commands.execute('mod_palette_test_palette', {}, { permission: 'full' }); assert.deepEqual(result.result.palette, [1, 2]);
  scope.dispose(); assert.equal(commands.tools().length, 0);
});

test('多工具轮次先返回全部工具结果再追加图像，图像不破坏工具消息配对', async () => {
  const commands = new AgentCommands(), providers = new AgentProviders(); let requests = 0;
  commands.register({ name: 'image', access: 'read', description: 'image', parameters: agentSchema(), prepare: () => ({ apply: () => ({ image: 'data:image/png;base64,AAAA' }) }) });
  commands.register({ name: 'read', access: 'read', description: 'read', parameters: agentSchema(), prepare: () => ({ apply: () => 1 }) });
  providers.register({ id: 'fixture', capabilities: () => ({ images: true }), complete: async request => {
    requests++;
    if (requests === 1) return { role: 'assistant', content: null, tool_calls: [toolCall('image', {}, 'a'), toolCall('read', {}, 'b')] };
    assert.deepEqual(request.messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'user']);
    assert.equal(request.messages.at(-1).content[1].type, 'image_url'); return { role: 'assistant', content: 'done' };
  } });
  const session = {}, agent = new EditorAgent({ commands, providers, context: () => ({ session, summary: {} }), config: () => ({ provider: 'fixture', key: 'test', permission: 'full' }), prompt: () => '' });
  await agent.run('test'); assert.equal(requests, 2);
});
