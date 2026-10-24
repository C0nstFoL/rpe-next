import { agentSchema, agentNumber, agentText, agentIndex } from '../core/agent-commands.mjs';
import { agentAt, agentPath, agentBeat, agentChartPatch, agentChartSummary, agentCircle, agentShake, agentTapNotes } from '../core/agent-chart.mjs';
import { analyzeAgentAudio, quantizeAgentPeaks } from '../core/agent-audio.mjs';
import { mapperTiming } from '../core/audio-mapper.mjs';
import { assertChart, diagnose, createNote, createEvent, createLine } from '../core/chart.mjs';
import { createNoiseArea, createNoiseEvent } from '../core/noise-areas.mjs';
import { beatValue, fromNumber } from '../core/beat.mjs';
import { deleteLine, duplicateLine, ensureLineCount, reorderLine, setLineParent } from './line-commands.mjs';
import { TempoMap } from '../core/tempo.mjs';
import { compileExpression } from '../core/batch-script.mjs';
import { AgentSourceReader } from '../platform/agent-source.mjs';
import { registerAgentChartTools } from './agent-chart-tools.mjs';
import { registerAgentWorkspaceTools } from './agent-workspace-tools.mjs';
import { registerAgentScriptingTools } from './agent-scripting-tools.mjs';
import { registerAgentFileTools } from './agent-file-tools.mjs';
import { registerAgentComponentTools } from './agent-component-tools.mjs';

const beatSchema = { description: '拍数，十进制数字、"3:1/2"字符串或[整数,分子,分母]' };
const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const enumeration = values => ({ type: 'string', enum: values });
const array = (items, maxItems = 2000) => ({ type: 'array', items, maxItems });
const pathOf = path => { if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => !part || ['.', '..'].includes(part))) throw Error('素材路径必须为项目内的相对路径'); return path; };
const contentBytes = bytes => bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

export function createAgentEditorCommands(commands, editor, { controls, network, ask, capture, captureEditor, prependSilence, patterns = {}, source = new AgentSourceReader(), workspace } = {}) {
  const revisions = new WeakMap(); let serial = 0;
  const revision = chart => { if (!revisions.has(chart)) revisions.set(chart, 'chart_' + ++serial); return revisions.get(chart); };
  const current = () => { if (!editor.hasDocument) throw Error('请先打开谱面'); return editor.chart; };
  const check = args => { const chart = current(); if (args.revision !== revision(chart)) throw Error('谱面版本已变化，请重新读取 editor_context 后重试'); return chart; };
  const prepareChart = (args, chart, next, summary, result = {}, dangerous = false) => {
    assertChart(next); const session = editor.session;
    return { summary, access: dangerous ? 'dangerous' : 'edit', details: { before: agentChartSummary(chart), after: agentChartSummary(next), ...result }, valid: () => editor.session === session && editor.chart === chart,
      apply: () => { editor.commit('AI · ' + summary, next); if (editor.chart === chart) throw Error('修改被编辑器或模组取消'); return { ...result, revision: revision(editor.chart), undoable: true }; } };
  };
  const register = (name, description, parameters, access, prepare) => commands.register({ name, description, parameters, access, prepare });
  register('editor_source', '只读浏览当前编辑器版本的源码、协议、控件和内置模组实现。不确定语义、格式、坐标或工具行为时先查证。action=list按path前缀/query文件名列目录；search按query字面关键词搜索并返回行号；read按path/startLine/startColumn/lineCount读取，可用next续读。不访问任意本机文件，不执行或修改源码。', agentSchema({ action: enumeration(['list', 'search', 'read']), path: agentText, query: { type: 'string', maxLength: 200 }, offset: agentIndex, limit: integer(1, 100), startLine: integer(1, Number.MAX_SAFE_INTEGER), startColumn: integer(1, Number.MAX_SAFE_INTEGER), lineCount: integer(1, 200), caseSensitive: { type: 'boolean' } }), 'read', (args, { signal }) => ({ apply: () => source.query(args, signal) }));
  register('chart_templates', '获取谱面格式、音符/事件/判定线/噪域的有效基础模板，以及所有命令的参数说明；可基于这些模板自由组合生成复杂效果。', agentSchema({ command: agentText }), 'read', args => ({ apply: () => args.command ? commands.tools().find(tool => tool.function.name === args.command)?.function ?? { error: '命令不存在' } : {
    note: createNote(1, 0, 0), hold: createNote(2, 0, 0, 1), event: createEvent(0, 0, 0, 1), line: createLine(), noiseArea: createNoiseArea(0, 4), noiseTransform: createNoiseEvent(0, 0, 0, 1, { x: 0, y: 0 }),
    scriptApi: { createNote: '(type,beat,positionX,endBeat=beat+1)，仅Hold使用endBeat', createEvent: '(start,end,startBeat,endBeat)', createLine: '(name?)', createNoiseArea: '(startBeat,endBeat)', createNoiseEvent: '(start,end,startBeat,endBeat,anchor?)', fromNumber: '数字拍→拍数组', beatValue: '拍数组→数字拍', parseBeat: '字符串拍→拍数组', easing: '(progress,id)' },
    guide: '用chart_generate或chart_transform的表达式写入数值，时间字段会转为拍数组。复杂JSON用chart_patch。非示例任务也使用这些通用工具。' } }));
  register('editor_context', '读取当前谱面、选择、拍数、播放、可用功能、全局事件注册种类与修订号。每项任务先调用。', agentSchema(), 'read', () => ({ apply: () => {
    const chart = current(); return { ...agentChartSummary(chart), revision: revision(chart), currentLine: editor.session.lineIndex, layer: editor.timeline.layer, beat: editor.currentBeat(), chartSeconds: editor.chartSeconds(), audioSeconds: editor.audio.time,
      audio: { name: chart.META.song, duration: editor.audio.duration, decoded: Boolean(editor.audio.buffer), sampleRate: editor.audio.buffer?.sampleRate },
      selection: { notes: [...editor.session.selection], events: [...editor.session.eventSelection], noise: [...editor.noiseEditor.selection], noiseOwner: editor.noiseEditor.selected },
      pane: editor.activePane, playing: editor.audio.playing, timeBases: { chartSeconds: editor.chartSeconds(), musicSeconds: editor.audio.time, offsetMilliseconds: chart.META.offset ?? 0, globalBeat: new TempoMap(chart.BPMList).beat(editor.chartSeconds()), lineBeat: new TempoMap(chart.BPMList).beat(editor.chartSeconds(), chart.judgeLineList[editor.session.lineIndex]?.bpmfactor ?? 1) },
      markers: (chart.markers ?? []).slice(0, 100).map((marker, index) => ({ index, name: marker.name, chartSeconds: marker.time, musicSeconds: Number(marker.time) + Number(chart.META.offset ?? 0) / 1000 })),
      registeredGlobalEvents: editor.globalEvents.document.types.map(type => ({ id: type.id, name: type.name, source: type.source, columns: type.columns.map(column => ({ id: column.id, name: column.name })) })),
      features: commands.tools().map(tool => tool.function.name) };
  } }));
  const entities = chart => [
    ...(chart.markers ?? []).map((entry, index) => ({ kind: 'marker', index, name: String(entry.name), chartSeconds: Number(entry.time) })),
    ...(chart.judgeLineList ?? []).map((entry, index) => ({ kind: 'line', index, name: entry.Name || `Line ${index}` })),
    ...(chart.judgeLineGroup ?? []).map((name, index) => ({ kind: 'line_group', index, name: String(name) })),
    ...(chart.blockAreaList ?? []).map((entry, index) => ({ kind: 'noise', index, name: entry.Name || `噪域 ${index}`, appearTime: entry.appearTime })),
    ...(chart.noiseAreaLayers ?? []).map((entry, index) => ({ kind: 'noise_layer', index, name: entry.name, id: entry.id })),
    ...[...editor.assets.keys()].map(name => ({ kind: 'asset', name })),
  ];
  register('editor_entities', '检索编辑器内命名实体：时间标记、判定线、分组、噪域、层和素材。名字可以是数字字符串；定位/修改前先分清对象，不把名称当拍数。', agentSchema({ kind: enumeration(['marker', 'line', 'line_group', 'noise', 'noise_layer', 'asset']), query: agentText, offset: agentIndex, limit: integer(1, 200) }), 'read', args => ({ apply: () => {
    const entries = entities(current()).filter(entry => (!args.kind || entry.kind === args.kind) && (!args.query || entry.name.toLowerCase().includes(args.query.toLowerCase())));
    return { total: entries.length, entries: entries.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100)) };
  } }));
  register('editor_navigate', '只改变播放头/工作区定位，不修改任何物件时间。target区分命名标记、命名判定线/噪域、全局谱面秒、音乐秒、全局拍、局部线拍；名字用name，数值用value。', agentSchema({ target: enumeration(['marker', 'line', 'noise', 'chart_seconds', 'music_seconds', 'global_beat', 'line_beat']), name: agentText, index: agentIndex, value: beatSchema, line: agentIndex }, ['target']), 'edit', args => {
    const chart = current(), session = editor.session, tempo = new TempoMap(chart.BPMList); let destination, selected;
    if (['marker', 'line', 'noise'].includes(args.target)) {
      const matches = entities(chart).filter(entry => entry.kind === args.target && (args.index !== undefined ? entry.index === args.index : entry.name.trim() === String(args.name ?? '').trim()));
      if (matches.length !== 1) throw Error(matches.length ? '存在同名目标，请查询实体并指定index' : '没有找到命名目标，请查询实体名称，不要将名称当数值处理');
      selected = matches[0]; if (selected.kind === 'marker') destination = selected.chartSeconds;
      else if (selected.kind === 'noise') destination = tempo.seconds(selected.appearTime);
    } else {
      const value = agentBeat(args.value);
      destination = args.target === 'music_seconds' ? value - Number(chart.META.offset ?? 0) / 1000 : args.target === 'global_beat' ? tempo.seconds(value) : args.target === 'line_beat' ? tempo.seconds(value, chart.judgeLineList[args.line ?? session.lineIndex]?.bpmfactor ?? 1) : value;
    }
    if (destination !== undefined && !Number.isFinite(destination)) throw Error('目标时间无效');
    return { summary: '定位编辑器工作区', details: { target: args.target, name: selected?.name, index: selected?.index, chartSeconds: destination, changesChart: false }, valid: () => editor.session === session && editor.chart === chart,
      apply: () => {
        if (selected?.kind === 'line') editor.selectLine(selected.index);
        if (selected?.kind === 'noise') { editor.noiseEditor.open(); editor.noiseEditor.select(selected.index); }
        if (destination !== undefined) editor.seek(destination); editor.invalidate();
        return { chartSeconds: destination ?? editor.chartSeconds(), selected, changesChart: false };
      } };
  });
  register('chart_read', '按 JSON Pointer 查看任意谱面字段；数组分页，root 返回摘要和字段名。fields 可缩减数组各项字段。含 revision。', agentSchema({ path: agentText, offset: agentIndex, limit: integer(1, 200), fields: array(agentText, 30) }), 'read', args => ({ apply: () => {
    const chart = current(), value = agentAt(chart, args.path ?? '');
    if (!args.path) return { revision: revision(chart), summary: agentChartSummary(chart), fields: Object.keys(chart) };
    const offset = args.offset ?? 0, limit = args.limit ?? 50;
    const items = Array.isArray(value) ? value.slice(offset, offset + limit).map((entry, index) => ({ index: offset + index, value: args.fields && entry && typeof entry === 'object' ? Object.fromEntries(args.fields.filter(key => Object.hasOwn(entry, key)).map(key => [key, entry[key]])) : entry })) : value;
    if (JSON.stringify(items).length > 50000) throw Error('该节点内容过大，请缩小 limit/fields 或读取更深的路径');
    return { revision: revision(chart), path: args.path, total: Array.isArray(value) ? value.length : undefined, items: structuredClone(items) };
  } }));
  register('chart_query', '按任意物件集合路径查询、时间范围/字段条件/排序/投影筛选，返回原始下标。读取音符、事件、噪域和模组数据的通用接口。', agentSchema({ path: agentText, start: beatSchema, end: beatSchema, startField: agentText, endField: agentText,
    where: array(agentSchema({ field: agentText, op: enumeration(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains']), value: {} }, ['field', 'op', 'value']), 20), sort: agentText, offset: agentIndex, limit: integer(1, 200), fields: array(agentText, 30) }, ['path']), 'read', args => ({ apply: () => {
    const chart = current(), source = agentAt(chart, args.path); if (!Array.isArray(source)) throw Error('查询路径需要是数组');
    const field = (entry, key) => agentAt(entry, '/' + key.replaceAll('.', '/'));
    let entries = source.map((value, index) => ({ index, value })).filter(({ value }) => {
      for (const condition of args.where ?? []) {
        let actual; try { actual = field(value, condition.field); } catch { return false; }
        const expected = condition.value;
        if (!(condition.op === 'eq' ? JSON.stringify(actual) === JSON.stringify(expected) : condition.op === 'ne' ? JSON.stringify(actual) !== JSON.stringify(expected) : condition.op === 'lt' ? actual < expected : condition.op === 'lte' ? actual <= expected : condition.op === 'gt' ? actual > expected : condition.op === 'gte' ? actual >= expected : String(actual).includes(String(expected)))) return false;
      }
      if (args.start !== undefined || args.end !== undefined) {
        const start = agentBeat(field(value, args.startField ?? 'startTime')), end = agentBeat(field(value, args.endField ?? 'endTime'));
        if (args.start !== undefined && end < agentBeat(args.start) || args.end !== undefined && start >= agentBeat(args.end)) return false;
      }
      return true;
    });
    if (args.sort) entries.sort((left, right) => { const first = field(left.value, args.sort), last = field(right.value, args.sort); return (Array.isArray(first) ? beatValue(first) : first) - (Array.isArray(last) ? beatValue(last) : last); });
    const total = entries.length; entries = entries.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50));
    if (args.fields) entries = entries.map(entry => ({ index: entry.index, value: Object.fromEntries(args.fields.map(key => { let value; try { value = field(entry.value, key); } catch {} return [key, value]; })) }));
    return { revision: revision(chart), total, entries: structuredClone(entries) };
  } }));
  register('chart_patch', '原子编辑任意谱面字段，包括音符、所有事件、噪域、层/皮肤、META、BPM和模组结构。op=set/remove/insert/append，JSON Pointer路径；append的value为待加入数组。保留其余字段，一次撤销。判定线删除优先line_manage。', agentSchema({ revision: agentText, label: agentText,
    operations: { type: 'array', minItems: 1, maxItems: 2000, items: agentSchema({ op: enumeration(['set', 'remove', 'insert', 'append']), path: agentText, value: {} }, ['op', 'path']) } }, ['revision', 'operations']), 'edit', args => {
    const chart = check(args); const next = agentChartPatch(chart, args.operations);
    const plan = prepareChart(args, chart, next.chart, args.label ?? '修改谱面', { paths: args.operations.map(operation => ({ op: operation.op, path: operation.path, value: operation.value })) }, next.dangerous); return plan;
  });
  register('bpm_set', '应用完整BPM列表，起始拍可用十进制或分数；不要把推测当成搜索所得。可记录真实来源供审批查看。', agentSchema({ revision: agentText, entries: { type: 'array', minItems: 1, maxItems: 1000, items: agentSchema({ beat: beatSchema, bpm: number(0.001, 100000) }, ['beat', 'bpm']) }, source: agentText }, ['revision', 'entries']), 'edit', args => {
    const chart = check(args), entries = args.entries.map(entry => ({ startTime: fromNumber(agentBeat(entry.beat)), bpm: entry.bpm })).sort((left, right) => beatValue(left.startTime) - beatValue(right.startTime));
    if (entries.some((entry, index) => index && beatValue(entry.startTime) === beatValue(entries[index - 1].startTime))) throw Error('同拍 BPM 重复');
    return prepareChart(args, chart, { ...chart, BPMList: entries }, '设置 BPM 列表', { entries, source: args.source ?? '' });
  });
  const numericScope = (value, index, count) => Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === 'number')), { i: index, N: count, u: count <= 1 ? 0 : index / (count - 1), beat: value.startTime ? beatValue(value.startTime) : value.appearTime ? beatValue(value.appearTime) : 0 });
  const compileFields = expressions => {
    const entries = Object.entries(expressions); if (entries.length > 64) throw Error('每次最多修改64个表达式字段');
    return entries.map(([path, source]) => { if (typeof source !== 'string') throw Error('表达式必须为字符串'); const parts = agentPath(path); if (!parts.length) throw Error('表达式不能替换整个物件'); return { path, parts, evaluate: compileExpression(source) }; });
  };
  const calculate = (item, expressions, scope) => {
    const operations = expressions.map(({ path, parts, evaluate }) => {
      const value = evaluate(scope); if (!Number.isFinite(value)) throw Error('表达式结果必须为有限数值');
      return { parts, value: /\/(?:startTime|endTime|appearTime|disappearTime)$/.test(path) ? fromNumber(value) : value };
    });
    let result = structuredClone(item);
    for (const operation of operations) {
      const parts = operation.parts;
      let parent = result;
      for (const key of parts.slice(0, -1)) { if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw Error('表达式目标父路径不存在'); parent = parent[key]; }
      if (!parent || typeof parent !== 'object') throw Error('表达式目标不是对象');
      Object.defineProperty(parent, parts.at(-1), { value: operation.value, enumerable: true, writable: true, configurable: true });
    }
    return result;
  };
  const expressionsSchema = { type: 'object', additionalProperties: true, description: '键为相对物件的JSON Pointer，值为安全算术表达式。i从0开始，N为数量，u为0–1，beat为原起拍；原顶层数值属性可直接引用。支持sin/cos/ease/lerp/clamp/pi/四则/条件式；时间字段自动转拍数组。' };
  register('chart_transform', '按安全表达式批量变换任意物件集合，可按indices或where选择、删除或改值。适用于时间偏移、镜像、速度/大小调整、任意事件/噪域/模组字段等。一组修改一次撤销。', agentSchema({ revision: agentText, path: agentText, indices: array(agentIndex, 10000), where: agentText, expressions: expressionsSchema, remove: { type: 'boolean' }, label: agentText }, ['revision', 'path']), 'edit', args => {
    const chart = check(args), source = agentAt(chart, args.path); if (!Array.isArray(source)) throw Error('目标必须为数组');
    const indices = args.indices ? new Set(args.indices) : null, filter = args.where ? compileExpression(args.where) : () => true;
    const chosen = source.map((value, index) => ({ value, index })).filter(({ value, index }) => (!indices || indices.has(index)) && filter(numericScope(value, index, source.length)));
    if (!chosen.length) throw Error('没有匹配的物件，未生成修改');
    const expressions = compileFields(args.expressions ?? {});
    const targets = new Map(chosen.map(({ value, index }, offset) => [index, args.remove ? null : calculate(value, expressions, numericScope(value, offset, chosen.length))]));
    const changed = source.flatMap((value, index) => targets.has(index) ? args.remove ? [] : [targets.get(index)] : [value]);
    const next = agentChartPatch(chart, [{ op: 'set', path: args.path, value: changed }]);
    return prepareChart(args, chart, next.chart, args.label ?? '批量变换物件', { path: args.path, count: chosen.length, indices: chosen.map(entry => entry.index).slice(0, 200), expressions: args.expressions, remove: Boolean(args.remove) }, Boolean(args.remove && chosen.length > 50) || args.path === '/judgeLineList');
  });
  register('chart_generate', '通过模板和安全表达式通用生成任意JSON物件，append至任意数组；不限于内置示例。可生成音符/事件/噪域/激活段/模组数据，模板需完整结构。i/N/u控制序列，count最大10000。', agentSchema({ revision: agentText, path: agentText, count: integer(1, 10000), template: { type: 'object' }, expressions: expressionsSchema, label: agentText }, ['revision', 'path', 'count', 'template']), 'edit', args => {
    const chart = check(args), expressions = compileFields(args.expressions ?? {}); const entries = Array.from({ length: args.count }, (unused, index) => calculate(args.template, expressions, numericScope(args.template, index, args.count)));
    const next = agentChartPatch(chart, [{ op: 'append', path: args.path, value: entries }]);
    return prepareChart(args, chart, next.chart, args.label ?? '生成物件序列', { path: args.path, count: args.count, template: args.template, expressions: args.expressions }, args.path === '/judgeLineList');
  });
  register('line_manage', '增加至指定条数、复制、删除、重排或设置父线，维护引用。删除整条线为危险操作。', agentSchema({ revision: agentText, action: enumeration(['ensure', 'duplicate', 'delete', 'reorder', 'parent']), line: agentIndex, target: agentIndex, count: integer(1, 10000), parent: integer(-1, 10000) }, ['revision', 'action']), 'edit', args => {
    const chart = check(args); let next;
    if (args.action === 'ensure') next = ensureLineCount(chart, args.count);
    else if (args.action === 'duplicate') next = duplicateLine(chart, args.line);
    else if (args.action === 'delete') { if (chart.judgeLineList.length <= 1) throw Error('至少保留一条判定线'); next = deleteLine(chart, args.line); }
    else if (args.action === 'reorder') next = reorderLine(chart, args.line, args.target);
    else next = setLineParent(chart, args.line, args.parent);
    return prepareChart(args, chart, next, '判定线 ' + args.action, { line: args.line, target: args.target, count: args.count, parent: args.parent }, args.action === 'delete');
  });
  register('event_shake', '按正弦×衰减包络生成振动，末端精确回到baseline。先询问必要参数并检查目标区间。replace允许替换区间内现有事件，但不吞掉跨边界事件。', agentSchema({ revision: agentText, line: agentIndex, track: enumeration(['moveXEvents', 'moveYEvents', 'rotateEvents']), layer: integer(0, 3), start: beatSchema, duration: beatSchema, amplitude: number(0, 100000), cycles: number(0.01, 1000), segmentsPerCycle: integer(4, 128), decayEasing: integer(1, 29), baseline: agentNumber, replace: { type: 'boolean' } }, ['revision', 'line', 'track', 'start', 'duration', 'amplitude', 'cycles', 'decayEasing']), 'edit', args => {
    const chart = check(args), result = agentShake(chart, args); return prepareChart(args, chart, result.chart, '生成衰减振动', { ...args, events: result.count }, Boolean(args.replace));
  });
  register('noise_circle', '生成中心沿圆周运动的矩形噪域，只创建X/Y移动事件，不改变噪域变换语义。其他视觉图案可用通用chart_patch自由生成。', agentSchema({ revision: agentText, start: beatSchema, duration: beatSchema, centerX: agentNumber, centerY: agentNumber, radius: number(0.01, 100000), width: number(0.01, 100000), height: number(0.01, 100000), turns: number(0.01, 100), phase: agentNumber, clockwise: { type: 'boolean' }, samples: integer(8, 512), active: { type: 'boolean' }, invert: { type: 'boolean' }, layerId: agentText, name: agentText }, ['revision', 'start', 'duration', 'centerX', 'centerY', 'radius', 'width', 'height']), 'edit', args => {
    const chart = check(args), result = agentCircle(chart, args); return prepareChart(args, chart, result.chart, '生成圆周运动噪域', { ...args, index: result.index, events: result.count });
  });
  const audioAnalysis = async (args, signal) => {
    const chart = current(), line = chart.judgeLineList[args.line ?? editor.session.lineIndex]; if (!line) throw Error('判定线不存在');
    const tempo = new TempoMap(chart.BPMList), offset = Number(chart.META.offset ?? 0) / 1000, start = agentBeat(args.start), end = agentBeat(args.end), factor = line.bpmfactor ?? 1;
    const source = editor.audioSources ? await editor.audioSources.resolveForAnalysis(args.source, signal) : { id: 'original', name: '原音频', buffer: editor.audio.buffer, offsetSeconds: 0 };
    if (!editor.audioSources && args.source && args.source !== 'original') throw Error('当前环境没有此分析声部，请先查询audio_sources');
    const sourceOffset = Number(source.offsetSeconds ?? 0), startSeconds = tempo.seconds(start, factor) + offset, endSeconds = tempo.seconds(end, factor) + offset;
    const range = editor.audioSources ? editor.audioSources.range(source, startSeconds, endSeconds) : { startSeconds, endSeconds };
    const options = { startSeconds: range.startSeconds, endSeconds: range.endSeconds, detector: args.detector, sensitivity: args.sensitivity, minGap: args.minGap, focus: args.focus, minConfidence: args.minConfidence, mapperModel: args.mapperModel, mapperMode: args.mapperMode, difficulty: args.difficulty, seed: args.seed, useChartTiming: args.useChartTiming, timing: mapperTiming(chart, sourceOffset) };
    if (!editor.audioOnsets && args.detector && args.detector !== 'flux') throw Error('此环境没有学习型起音检测器');
    const result = editor.audioOnsets ? await editor.audioOnsets.analyze(source.buffer, options, signal) : await analyzeAgentAudio(source.buffer, { ...options, signal });
    return { ...result, startSeconds, endSeconds, sourceStartSeconds: result.startSeconds, sourceEndSeconds: result.endSeconds, source: { id: source.id, ids: source.ids ?? [source.id], name: source.name, offsetSeconds: 0 }, peaks: result.peaks.map(peak => ({ ...peak, seconds: peak.seconds, beat: tempo.beat(peak.seconds - offset, factor) })), start, end };
  };
  const audioSchema = { line: agentIndex, start: beatSchema, end: beatSchema, source: { ...agentText, description: '音源id；不填使用面板选择，original为原音乐。Mapperatorinator通常先用original混音；指定配器时再选声部。' }, detector: { ...enumeration(['mapper', 'ddc', 'flux']), description: 'mapper为Mapperatorinator节奏草稿，ddc为学习型起音，flux为频谱算法；不填用面板选择。mapper按难度选择音符，不输出起音概率。' }, mapperModel: enumeration(['v32', 'v32-mini']), mapperMode: { type: 'integer', enum: [0, 3], description: '仅mapper：0为点击节奏，3为四键节奏；只提取按下时刻，不照搬osu位置或键数。' }, difficulty: { ...number(.1, 15), description: '仅mapper，参考osu星级控制节奏密度，非Phigros定数；默认5。' }, seed: integer(0, 0xffffffff), useChartTiming: { type: 'boolean', description: 'mapper是否参考当前谱面BPM/相位，默认true；BPM未经确认时可false让模型自行推断，但不会修改谱面BPM。' }, sensitivity: { ...number(0.1, 10), description: '仅flux的局部门限倍率。' }, minGap: number(0.02, 2), focus: { ...enumeration(['all', 'percussion', 'low', 'melody']), description: '仅flux的频带权重；学习型模型应省略或设all。' }, minConfidence: { ...number(0, 1), description: '仅ddc/flux的起音门限，mapper不用此项；DDC默认0.15，flux默认0.35。' } };
  register('audio_sources', '列出原音乐、分离与导入声部的id、名称、颜色和勾选状态。selection给出当前同时播放/分析的音源id；至少勾选一项，均从原音乐零点开始，共用谱面延迟。status同时检测Demucs环境。', agentSchema({ status: { type: 'boolean' } }), 'read', args => ({ apply: async () => ({ sources: editor.audioSources?.list() ?? [{ id: 'original', name: '原音频' }], selection: editor.audioSources?.selectedIds ?? ['original'], separation: args.status ? editor.audioSources?.separator.bridge ? await editor.audioSources.separator.call('probe') : { ready: false, message: '网页端请导入外部工具分离出的声部' } : undefined }) }));
  register('audio_separate', '用桌面端本机Demucs先分离当前音乐，再用audio_analyze/audio_taps的source指定声部。htdemucs为人声/鼓/贝斯/其他，htdemucs_6s另含吉他/钢琴（实验效果，可能串音）。首次下载模型，音频不上传，结果独立缓存不改谱面或替换原音乐；需要已配置分离环境，安装只能由用户在声部分离设置确认。', agentSchema({ model: enumeration(['htdemucs', 'htdemucs_6s']), device: enumeration(['auto', 'cpu', 'cuda']), shifts: integer(0, 4) }), 'read', (args, { signal }) => ({ apply: async () => { if (!editor.audioSources) throw Error('当前环境没有声部分离'); return editor.audioSources.separate(args, signal); } }));
  register('audio_source', '临时切换编辑器播放及分析音源，select用source选择单个，或sources数组同时选择多个（至少一项）；remove用source移除声部。暂停/继续、倍速、保调都应用到勾选音源的混合，关闭谱面后恢复原音乐。不改素材、谱面延迟与文件，不支持声部独立偏移。', agentSchema({ action: enumeration(['select', 'remove']), source: agentText, sources: array(agentText) }, ['action']), 'edit', args => {
    const sources = editor.audioSources; if (!sources) throw Error('当前环境没有分析音源管理'); const revision = sources.revision, original = editor.audio.buffer;
    if (args.action === 'remove' ? !args.source || args.sources : Boolean(args.source) === Boolean(args.sources?.length)) throw Error('选择音源请提供source或非空sources，移除仅提供source');
    for (const id of args.sources ?? [args.source]) sources.entry(id);
    return { summary: '调整播放与分析音源：' + args.action, details: args, valid: () => sources.revision === revision && editor.audio.buffer === original, apply: async () => { if (args.action === 'select') await sources.select(args.sources ?? args.source); else await sources.remove(args.source); return { sources: sources.list(), selection: sources.selectedIds, chartUnchanged: true }; } };
  });
  register('audio_detector', '查询采音方式、模型、难度、随机种子及门限。status检测当前所选本机模型环境；detector可指定要检测的mapper/ddc/flux。安装须用户在波形/频谱确认，失败不会静默换算法。', agentSchema({ status: { type: 'boolean' }, detector: enumeration(['mapper', 'ddc', 'flux']) }), 'read', args => ({ apply: async () => { const onsets = editor.audioOnsets, selected = args.detector ?? onsets?.options.detector, backend = selected === 'mapper' ? onsets?.mapper : selected === 'ddc' ? onsets?.detector : null; return { options: onsets?.options ?? { detector: 'flux' }, detectors: [{ id: 'mapper', available: Boolean(onsets?.mapper.bridge) }, { id: 'ddc', available: Boolean(onsets?.detector.bridge) }, { id: 'flux', available: true }], environment: args.status && backend?.bridge ? await backend.call('probe') : undefined }; } }));
  register('audio_analyze', '在本机分析指定线拍数区间，返回候选音符时间。mapper用Mapperatorinator按音乐和难度生成节奏草稿，通常先用original混音，不能按置信度门限筛选；ddc/flux用于起音对比。可预先分离配器。考虑谱面BPM、相位、声部对齐和线倍率，最长180秒，不上传PCM。', agentSchema(audioSchema, ['start', 'end']), 'read', async (args, { signal }) => {
    const result = await audioAnalysis(args, signal); return { apply: () => result };
  });
  register('audio_taps', '从Mapperatorinator节奏草稿或DDC/flux起音候选生成Tap。mapper通过difficulty/mode/seed控制，不使用minConfidence；优先以original混音分析。默认自适应量化，none保留模型时刻，nearest严格网格。声部共用原音乐起点和延迟，线倍率处理一次，跳过重复及Hold占用，一次撤销。', agentSchema({ ...audioSchema, revision: agentText, division: integer(1, 192), positionX: agentNumber, quantization: enumeration(['adaptive', 'nearest', 'none']), quantizeTolerance: number(0, .5) }, ['revision', 'line', 'start', 'end', 'division']), 'edit', async (args, { signal }) => {
    const chart = check(args), originalAudio = editor.audio.buffer, sourcesRevision = editor.audioSources?.revision, result = await audioAnalysis(args, signal); const division = args.division;
    const selected = quantizeAgentPeaks(result.peaks, { division, start: result.start, end: result.end, mode: args.quantization ?? 'adaptive', tolerance: args.quantizeTolerance ?? .2 });
    const beats = selected.map(peak => peak.beat);
    const next = agentTapNotes(chart, args.line, beats, args.positionX ?? 0);
    if (!next.count) throw Error(result.detector === 'mapper' ? '节奏草稿没有可新增的落点；可调整范围、参考难度或量化，谱面保持原样' : '没有适合新增的瞬态拍点；可调整范围、灵敏度或细分，谱面保持原样');
    const plan = prepareChart(args, chart, next.chart, '采音生成 Tap', { line: args.line, source: result.source, start: result.start, end: result.end, beats, added: next.count, skipped: beats.length - next.count, method: result.method, model: result.model, statistics: result.statistics, focus: result.focus, quantization: args.quantization ?? 'adaptive', candidates: selected }), valid = plan.valid;
    return { ...plan, valid: () => valid() && editor.audio.buffer === originalAudio && editor.audioSources?.revision === sourcesRevision };
  });
  register('diagnose', '运行编辑器的真实谱面检查，包括错误、重叠与超界警告；可分页。', agentSchema({ offset: agentIndex, limit: integer(1, 200) }), 'read', args => ({ apply: () => { const issues = diagnose(current()); return { total: issues.length, issues: issues.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50)) }; } }));
  register('editor_view', '切换判定线/事件层/面板、预览、播放暂停、选中物件；切线保持播放头位置。本命令不接受时间，时间定位请用editor_navigate明确单位。无持久谱面修改。', agentSchema({ line: agentIndex, layer: integer(0, 3), pane: agentText, playback: enumeration(['play', 'pause']), preview: { type: 'boolean' }, notes: array(agentIndex), events: array(agentText), noise: agentIndex }), 'edit', args => {
    const session = editor.session;
    return { summary: '调整编辑器视图和选择', details: args, valid: () => editor.session === session, apply: async () => {
      if (args.line !== undefined) { if (!editor.chart.judgeLineList[args.line]) throw Error('判定线不存在'); editor.selectLine(args.line); }
      if (args.layer !== undefined) editor.timeline.layer = session.eventLayer = args.layer;
      if (args.notes) { session.selection = new Set(args.notes); session.focus = 'notes'; }
      if (args.events) { session.eventSelection = new Set(args.events); session.focus = 'events'; }
      if (args.noise !== undefined) { if (!editor.chart.blockAreaList?.[args.noise]) throw Error('噪域不存在'); editor.noiseEditor.open(); editor.noiseEditor.select(args.noise); }
      if (args.pane !== undefined) { if (args.pane === 'ai' || !editor.agent.allowedPanes().includes(args.pane)) throw Error('面板名无效'); editor.activatePane(args.pane); }
      if (args.preview !== undefined) editor.setPreview(args.preview);
      if (args.playback === 'play') await editor.play(); else if (args.playback === 'pause') editor.pause();
      session.notify(); editor.invalidate(); return { applied: args };
    } };
  });
  register('history', '查看编辑历史或撤销/重做；undo/redo进入与普通编辑相同的历史流程。', agentSchema({ action: enumeration(['list', 'undo', 'redo']) }, ['action']), 'read', args => { const session = editor.session, chart = editor.chart; return { summary: '编辑历史：' + args.action, access: args.action === 'list' ? 'read' : 'edit', valid: () => editor.session === session && editor.chart === chart, apply: () => {
    if (args.action !== 'list') editor.session.travel(args.action);
    return { revision: revision(editor.chart), undo: editor.session.history.undoStack.map(entry => entry.label).slice(-30), redo: editor.session.history.redoStack.map(entry => entry.label).slice(-30) };
  } }; });
  register('assets_list', '列出谱面内所有素材文件及大小，可按路径筛选。不会读取任意磁盘。', agentSchema({ query: agentText, offset: agentIndex, limit: integer(1, 200) }), 'read', args => ({ apply: () => { const files = [...editor.assets].filter(([path]) => !args.query || path.includes(args.query)); return { total: files.length, files: files.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100)).map(([path, bytes]) => ({ path, bytes: bytes.byteLength })) }; } }));
  register('asset_read', '读取项目内素材：text用于JSON/GLSL/SVG等文本；image供支持识图的模型查看；info仅返回大小。二进制可base64读取小文件。', agentSchema({ path: agentText, format: enumeration(['text', 'image', 'base64', 'info']), offset: agentIndex, limit: integer(1, 40000) }, ['path', 'format']), 'read', args => ({ apply: async () => {
    const source = editor.assets.get(pathOf(args.path)); if (!source) throw Error('素材不存在'); const bytes = contentBytes(source);
    if (args.format === 'info') return { path: args.path, bytes: bytes.length };
    if (args.format === 'image') {
      if (!editor.agent.capabilities().images) throw Error('当前模型不支持识图；请选用支持识图的模型或读取几何信息');
      if (!/\.(png|jpe?g|webp|gif)$/i.test(args.path) || bytes.length > 5 * 1024 * 1024) throw Error('仅支持5MiB以内的PNG/JPEG/WebP/GIF图像');
      const mime = /\.png$/i.test(args.path) ? 'image/png' : /\.webp$/i.test(args.path) ? 'image/webp' : /\.gif$/i.test(args.path) ? 'image/gif' : 'image/jpeg';
      const image = await editor.agent.dataUrl(new Blob([bytes], { type: mime })); return { path: args.path, image };
    }
    if (args.format === 'text') { if (bytes.length > 4 * 1024 * 1024) throw Error('文本素材过大'); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return { total: text.length, offset: args.offset ?? 0, text: text.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 20000)) }; }
    if (bytes.length > 24000) throw Error('二进制内容过大，请使用info或本地分析');
    return { base64: btoa(String.fromCharCode(...bytes)) };
  } }));
  register('asset_write', '写入/替换或删除谱面素材，binding可绑定音乐或封面；不上传原始音频。素材变更需要保存且不能通过普通撤销恢复，属于危险操作。', agentSchema({ path: agentText, action: enumeration(['write', 'delete']), text: agentText, base64: { type: 'string', maxLength: 1500000 }, binding: enumeration(['song', 'background']) }, ['path', 'action']), 'dangerous', args => {
    const path = pathOf(args.path), session = editor.session, previous = editor.assets.get(path);
    let bytes;
    if (args.action === 'write') {
      if ((args.text !== undefined) === (args.base64 !== undefined)) throw Error('text和base64必须且只能提供一个');
      bytes = args.text !== undefined ? new TextEncoder().encode(args.text) : Uint8Array.from(atob(args.base64), value => value.charCodeAt(0));
    }
    return { summary: `${args.action === 'delete' ? '删除' : previous ? '替换' : '新增'}素材 ${path}`, details: { path, bytes: bytes?.length, binding: args.binding, undoable: false, needsSave: true }, valid: () => editor.session === session && editor.assets.get(path) === previous,
      apply: () => editor.agent.writeAsset(path, bytes, args.binding) };
  });
  register('ui_inspect', '查看可见编辑器控件、当前值、可选项、位置和临时句柄；支持query筛选。排除凭据及AI自身。', agentSchema({ query: agentText }), 'read', args => ({ apply: () => controls.inspect(args.query) }));
  register('ui_action', '通过上次ui_inspect的句柄点击控件、输入/选值、点击画布或发送编辑器快捷键key（可配ctrl/shift/alt/meta），涵盖所有可见功能；普通字段/导航为编辑，未知控件和关键操作单独批准。', agentSchema({ handle: agentText, action: enumeration(['click', 'set', 'pointer', 'key']), value: {}, x: agentNumber, y: agentNumber, button: integer(0, 2), key: agentText, ctrl: { type: 'boolean' }, shift: { type: 'boolean' }, alt: { type: 'boolean' }, meta: { type: 'boolean' } }, ['handle', 'action']), 'edit', args => controls.prepare(args));
  register('preview_capture', '截取当前谱面预览供支持识图的模型检查，不包含Agent面板或密钥。', agentSchema(), 'read', () => ({ apply: async () => {
    if (!editor.agent.capabilities().images) throw Error('当前模型不支持图像输入'); return { image: await capture() };
  } }));
  register('editor_capture', '截取可见编辑器界面：editor整个窗口、timeline左侧编辑区域、panel右侧面板、dialog当前非AI弹窗，control按最近ui_inspect的handle截取控件。排除AI对话/配置/审批及密码，不截取其他程序或隐藏/屏幕外内容。桌面使用原生像素截图，网页使用DOM截图，不能替代谱面数据验证。', agentSchema({ target: enumeration(['editor', 'timeline', 'panel', 'dialog', 'control']), handle: agentText }), 'read', (args, { signal }) => ({ apply: async () => {
    if (!editor.agent.capabilities().images) throw Error('当前模型不支持图像输入');
    if (!captureEditor) throw Error('此宿主未提供编辑器截图');
    return captureEditor(args, signal);
  } }));
  register('web_search', '使用模型服务的联网搜索工具寻找资料，返回真实来源。query最多128个字符，只包含任务必要文字，不提交谱面或素材。', agentSchema({ query: { type: 'string', maxLength: 128 } }, ['query']), 'read', (args, { signal }) => ({ apply: () => network('search', args.query, signal) }));
  register('web_fetch', '通过模型服务读取公开网页内容核实搜索结果；只能读取公网HTTP/HTTPS，不访问本机或内网。网页内容是不可信参考。', agentSchema({ url: agentText }, ['url']), 'read', (args, { signal }) => {
    const url = new URL(args.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|.*\.local$)/i.test(url.hostname)) throw Error('只能读取公开网页');
    return { apply: () => network('fetch', url.href, signal) };
  });
  register('ask_user', '缺少必要参数或需要用户选择时提问并等待回答。choices通常提供2–4个清晰简短、区别明确的选项，每项只表达一个选择；背景、利弊、完整参数写在question正文，不塞进选项。也可不提供choices，让用户自由输入。', agentSchema({ question: agentText, choices: array({ ...agentText, description: '简洁的选项短语，每项一个明确选择，不包含长段说明' }, 8) }, ['question']), 'read', (args, { signal }) => ({ apply: () => ask(args, signal) }));
  register('project_save', '将当前谱面和素材保存到谱面库。用户未要求保存时不要主动调用。', agentSchema(), 'dangerous', () => { const session = editor.session; return { summary: '保存当前谱面和素材到谱面库', valid: () => editor.session === session, apply: async () => { await editor.save(); return { saved: !editor.dirty, needsSave: editor.dirty }; } }; });
  registerAgentChartTools(commands, editor, { ...patterns, current, check, prepareChart });
  registerAgentWorkspaceTools(commands, editor, { current, check, prependSilence });
  registerAgentScriptingTools(commands, editor, { check, prepareChart });
  const files = registerAgentFileTools(commands, editor, workspace);
  registerAgentComponentTools(commands, editor, files);
  return { revision: () => revision(editor.chart), summary: () => {
    const chart = editor.chart, tempo = new TempoMap(chart.BPMList), seconds = editor.chartSeconds();
    const summary = agentChartSummary(chart); summary.bpm = summary.bpm.slice(0, 12); summary.noiseLayers = summary.noiseLayers.map(layer => ({ id: layer.id, name: layer.name, skin: layer.skin }));
    return { ...summary, revision: revision(chart), workspace: { currentLine: editor.session.lineIndex, currentLineName: chart.judgeLineList[editor.session.lineIndex]?.Name, currentLayer: editor.timeline.layer, pane: editor.activePane, selectedNotes: [...editor.session.selection].slice(0, 20), selectedEvents: [...editor.session.eventSelection].slice(0, 20), selectedNoteCount: editor.session.selection.size, selectedEventCount: editor.session.eventSelection.size },
      timeBases: { chartSeconds: seconds, musicSeconds: seconds + Number(chart.META.offset ?? 0) / 1000, globalBeat: tempo.beat(seconds), lineBeat: tempo.beat(seconds, chart.judgeLineList[editor.session.lineIndex]?.bpmfactor ?? 1) },
      namedEntities: { markers: (chart.markers ?? []).slice(0, 20).map((marker, index) => ({ kind: 'marker', index, name: String(marker.name), chartSeconds: Number(marker.time) })), lines: chart.judgeLineList.slice(0, 20).map((line, index) => ({ kind: 'line', index, name: line.Name })), groups: (chart.judgeLineGroup ?? []).slice(0, 20), noiseLayers: summary.noiseLayers.slice(0, 20) },
      semantics: 'workspace/timeBases表示工作区定位，不是物件时间字段。namedEntities的name是标识符，即使看起来像数字也须先解析实体；单位或目标有歧义时先询问。命名对象不在摘要中时用editor_entities查询。' };
  } };
}
