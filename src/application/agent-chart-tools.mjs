import { agentSchema, agentText, agentNumber, agentIndex, checkAgentSignal } from '../core/agent-commands.mjs';
import { agentBeat } from '../core/agent-chart.mjs';
import { fromNumber, beatValue } from '../core/beat.mjs';
import { TempoMap } from '../core/tempo.mjs';
import { CURVE_PRESETS, TRAJECTORY_DEFAULTS, presetOptions, editableTrajectoryOptions } from '../core/curve-trajectory.mjs';
import { generateCurveNotes } from '../core/curve-notes.mjs';
import { trackedNoiseArea, noiseTrackingChart } from '../core/noise-tracking.mjs';
import { NOISE_REVEALS } from '../core/noise-fit.mjs';
import { noiseLayers } from '../core/noise-skin.mjs';
import { validateColumnEvent } from '../core/global-events.mjs';
import { createTrajectoryEvent, trajectoryChart, splitTrajectoryChart } from './trajectory-commands.mjs';
import { fittedNoiseAreas, noiseFitChart } from './noise-fit.mjs';
import { textLinesChart } from './text-lines.mjs';
import { parseLineExpression } from './multi-line-edit.mjs';
import { groupNames } from '../core/line-groups.mjs';
import { rasterizeNoisePattern, rasterizeTextLines, runPatternFit } from '../platform/pattern-raster.mjs';

const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const choice = values => ({ enum: values });
const boolean = { type: 'boolean' };
const beat = { description: '十进制拍数、3:1/2字符串或[整数,分子,分母]' };
const layerNumber = { ...integer(0, 3), description: '界面上显示的基础层编号0/1/2/3，数字原样使用，不减1；未指定才默认0。' };
const time = value => Array.isArray(value) ? [...value] : fromNumber(agentBeat(value));
const splitSchema = agentSchema({ segments: integer(4, 8192), simplify: boolean, tolerance: number(.001, 10000) });
const trajectoryOptions = agentSchema(Object.fromEntries(Object.entries(TRAJECTORY_DEFAULTS).map(([key, value]) => [key, typeof value === 'boolean' ? boolean : typeof value === 'number' ? agentNumber : typeof value === 'string' ? agentText : { type: 'object' }])));
const lineIndices = (input, chart) => {
  const count = chart.judgeLineList.length;
  if (typeof input === 'string') {
    const groups = new Set(groupNames(chart));
    for (const token of input.trim().split(/\s+/)) if (!groups.has(token) && /^[+-]?\d+(?::[+-]?\d+)?$/.test(token) && token.split(':').some(value => !Number.isSafeInteger(Number(value)) || Number(value) < 0 || Number(value) >= count)) throw Error('参与线号超出谱面范围');
  } else if (!Array.isArray(input)) throw Error('参与线号必须为数组或线号/分组表达式');
  const indices = Array.isArray(input) ? [...input] : parseLineExpression(input, count, chart);
  if (indices.some(index => !Number.isInteger(index) || !chart.judgeLineList[index]) || new Set(indices).size !== indices.length) throw Error('参与判定线无效');
  return indices;
};

export const AGENT_CHART_TOOLS = Object.freeze([
  { id: 'metadata', name: '谱面信息', commands: ['chart_read', 'chart_patch', 'assets_list', 'asset_read', 'asset_write'] },
  { id: 'bpm', name: 'BPM列表', commands: ['bpm_set', 'audio_prepend_silence'] },
  { id: 'assets', name: '素材库', commands: ['assets_list', 'asset_read', 'asset_write', 'ui_inspect', 'ui_action'] },
  { id: 'audio-analysis-tool', name: '音频分析', commands: ['audio_sources', 'audio_separate', 'audio_source', 'audio_detector', 'audio_analyze', 'audio_taps', 'audio_view'] },
  { id: 'noise-areas-tool', name: '噪域编辑', commands: ['chart_templates', 'chart_patch', 'chart_generate', 'chart_transform', 'noise_circle'] },
  { id: 'curve-notes', name: '填充曲线音符', commands: ['curve_notes'] },
  { id: 'curve-trajectory', name: '生成曲线轨迹', commands: ['trajectory_presets', 'trajectory_generate', 'trajectory_split'] },
  { id: 'text-lines-tool', name: '文字拼合', commands: ['text_fit'] },
  { id: 'noise-fit-tool', name: '噪域图案', commands: ['noise_fit'] },
  { id: 'noise-tracking-tool', name: '噪域追踪', commands: ['noise_track'] },
  { id: 'multi-line-tool', name: '多线编辑', commands: ['multi_line', 'chart_query', 'chart_transform'] },
  { id: 'global-events-tool', name: '全局事件', commands: ['global_events'] },
  { id: 'diagnose', name: '谱面检查', commands: ['diagnose'] },
  { id: 'history-panel', name: '编辑历史', commands: ['history'] },
  { id: 'version-control-tool', name: '版本控制', commands: ['version_control', 'ui_inspect', 'ui_action'] },
]);

export function registerAgentChartTools(commands, editor, { current, check, prepareChart, fit = runPatternFit, textRaster = rasterizeTextLines, noiseRaster = rasterizeNoisePattern }) {
  const register = (name, description, parameters, access, prepare) => commands.register({ name, description, parameters, access, prepare });
  const presets = () => [...CURVE_PRESETS, ...(editor.trajectoryPanel?.custom ?? [])];
  register('chart_tools', '查询全部谱面工具与可直接调用的命令映射。生成曲线轨迹、曲线音符、文字拼合、噪域图案/追踪等优先调用原生计算命令，不要仅打开面板或误称无法生成。具体参数可用chart_templates(command)查看。', agentSchema(), 'read', () => ({ apply: () => AGENT_CHART_TOOLS.map(tool => ({ ...tool, commands: tool.commands.filter(name => commands.entries.has(name)) })) }));
  register('trajectory_presets', '列出原生曲线轨迹的全部内置与用户自定义预设、表达式和参数，可按名字或id筛选；也支持完全自定义参数方程/极坐标。', agentSchema({ query: agentText }), 'read', args => ({ apply: () => presets().filter(entry => !args.query || [entry.name, entry.id, entry.category].some(value => value?.toLowerCase().includes(args.query.toLowerCase()))).map(entry => ({ ...entry, options: presetOptions(entry) })) }));
  register('trajectory_generate', '直接调用原生曲线轨迹生成器：预设/参数方程/极坐标、参数字典、截取、旋转、缩放、起点对齐、独立XY缓动、切线旋转。output=trajectory保存整体轨迹，events生成普通事件；eventIndex可更新已有整体轨迹，replace替换冲突需关键批准。时间为目标线局部拍，一次撤销。', agentSchema({ revision: agentText, line: agentIndex, layer: layerNumber, start: beat, end: beat, preset: agentText, options: trajectoryOptions, segments: integer(4, 8192), split: splitSchema, output: choice(['trajectory', 'events']), eventIndex: agentIndex, replace: boolean }, ['revision', 'line', 'start', 'end']), 'edit', args => {
    const chart = check(args), layer = args.layer ?? 0, entries = chart.judgeLineList[args.line]?.eventLayers?.[layer]?.moveXEvents ?? [], editing = args.eventIndex === undefined ? null : entries[args.eventIndex];
    if (args.eventIndex !== undefined && !editing?.trajectory) throw Error('指定的事件不是整体曲线轨迹');
    let base = editing?.trajectory?.options ?? TRAJECTORY_DEFAULTS;
    if (args.preset) { const matches = presets().filter(entry => entry.id === args.preset || entry.name === args.preset); if (matches.length !== 1) throw Error('预设不存在或重名，请先查询trajectory_presets'); base = presetOptions(matches[0]); }
    const options = editableTrajectoryOptions({ ...base, ...args.options, parameters: { ...base.parameters, ...args.options?.parameters } });
    const event = createTrajectoryEvent(options, time(args.start), time(args.end), args.segments ?? editing?.trajectory.segments ?? 128, args.split ?? editing?.trajectory.split);
    let next = trajectoryChart(chart, args.line, layer, event, editing, args.replace === true);
    if (args.output === 'events') next = splitTrajectoryChart(next, args.line, layer, event, args.split);
    return prepareChart(args, chart, next, '生成曲线轨迹', { line: args.line, layer, output: args.output ?? 'trajectory', start: event.startTime, end: event.endTime, options, eventCount: Object.values(next.judgeLineList[args.line].eventLayers[layer]).reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0) }, args.replace === true);
  });
  register('trajectory_split', '将指定整体曲线轨迹拆为普通X/Y移动和可选旋转事件，沿用原生段数、简化和容忍度，一次撤销。', agentSchema({ revision: agentText, line: agentIndex, layer: layerNumber, eventIndex: agentIndex, settings: splitSchema }, ['revision', 'line', 'eventIndex']), 'edit', args => {
    const chart = check(args), layer = args.layer ?? 0, event = chart.judgeLineList[args.line]?.eventLayers?.[layer]?.moveXEvents?.[args.eventIndex];
    if (!event?.trajectory) throw Error('指定的事件不是整体曲线轨迹');
    return prepareChart(args, chart, splitTrajectoryChart(chart, args.line, layer, event, args.settings), '拆分曲线轨迹', { line: args.line, layer });
  });
  register('curve_notes', '调用原生填充曲线音符：按首尾拍/X坐标、横线分格×密度、缓动生成Tap/Drag/Flick，中间音符不重复生成首尾端点。同拍可生成横向音符，时间为该线局部拍，一次撤销。', agentSchema({ revision: agentText, line: agentIndex, start: beat, end: beat, startX: agentNumber, endX: agentNumber, type: choice([1, 3, 4]), division: integer(1, 100), density: number(.001, 1000), easingType: integer(1, 29) }, ['revision', 'line', 'start', 'end', 'startX', 'endX']), 'edit', args => {
    const chart = check(args), line = chart.judgeLineList[args.line]; if (!line) throw Error('目标判定线不存在');
    const notes = generateCurveNotes({ startTime: time(args.start), endTime: time(args.end), startX: args.startX, endX: args.endX, type: args.type ?? 4, division: args.division ?? editor.timeline.division ?? 4, density: args.density ?? 1, easingType: args.easingType ?? 1 });
    if (!notes.length) throw Error('当前参数不会生成中间音符，请调整区间或密度');
    const next = { ...chart, judgeLineList: chart.judgeLineList.map((entry, index) => index === args.line ? { ...entry, notes: [...(entry.notes ?? []), ...notes].sort((left, right) => beatValue(left.startTime) - beatValue(right.startTime)), numOfNotes: (entry.notes?.length ?? 0) + notes.length } : entry) };
    return prepareChart(args, chart, next, '填充曲线音符', { line: args.line, count: notes.length });
  });
  register('noise_track', '调用原生噪域追踪：target为判定线或其音符，考虑父线、叠层、倍率、下落与跳变，生成全局起止拍内跟随目标位置和角度的噪域。源对象后续修改需重新追踪，一次撤销。', agentSchema({ revision: agentText, start: beat, end: beat, target: agentSchema({ mode: choice(['line', 'note']), lineIndex: agentIndex, noteIndex: agentIndex }, ['mode', 'lineIndex']), width: number(.001, 100000), height: number(.001, 100000), layerId: agentText, invert: boolean, active: boolean, sampleRate: choice([60, 120, 240]), name: agentText }, ['revision', 'start', 'end', 'target', 'width', 'height']), 'edit', args => {
    const chart = check(args), area = trackedNoiseArea(chart, new TempoMap(chart.BPMList), { ...args, start: time(args.start), end: time(args.end) });
    return prepareChart(args, chart, noiseTrackingChart(chart, area), '噪域追踪', { count: 1, index: chart.blockAreaList?.length ?? 0, target: args.target, segments: area.moveXEvents.length });
  });
  register('noise_fit', '原生噪域图案：文字+字体或谱面图片素材，支持二值化、精度、矩形合并、布局、浮现顺序、出现缓动和激活。图片用image素材路径，或图案面板已选的本地图片。analyzeOnly=true只返回数量不生成；生成一次撤销。', agentSchema({ revision: agentText, mode: choice(['text', 'image']), text: { type: 'string', maxLength: 1000 }, font: { type: 'string', maxLength: 200 }, image: agentText, precision: integer(16, 512), spacing: number(.5, 4), threshold: integer(1, 254), polarity: choice(['dark', 'light', 'alpha']), invertImage: boolean, merge: boolean, maxSpan: integer(1, 512), trim: boolean,
    first: beat, last: beat, duration: beat, width: number(1, 20000), x: agentNumber, y: agentNumber, rotation: agentNumber, layerId: agentText, invert: boolean, name: agentText, active: boolean, activeStart: beat, activeEnd: beat, readyFlash: number(0, 600), reveal: choice(NOISE_REVEALS.map(entry => entry[0])), easingType: integer(1, 29), seed: integer(0, 4294967295), analyzeOnly: boolean }, ['revision', 'mode', 'first', 'duration', 'width']), 'edit', async (args, { signal }) => {
    const chart = check(args), options = { text: '', font: 'sans-serif', spacing: 1.2, precision: 128, threshold: 128, polarity: 'dark', merge: true, maxSpan: 12, trim: true, x: 0, y: 0, ...args,
      first: agentBeat(args.first), last: agentBeat(args.last ?? args.first), duration: agentBeat(args.duration), layerId: args.layerId ?? noiseLayers(chart)[0].id };
    if (args.activeStart !== undefined) options.activeStart = agentBeat(args.activeStart); if (args.activeEnd !== undefined) options.activeEnd = agentBeat(args.activeEnd);
    const sourceImage = args.image ? editor.assets.get(args.image) : editor.noiseFitPanel?.bitmap;
    let bitmap = editor.noiseFitPanel?.bitmap, owned = false, raster;
    try {
      if (args.mode === 'image' && args.image) { const bytes = editor.assets.get(args.image); if (!bytes) throw Error('图片素材不存在'); bitmap = await createImageBitmap(new Blob([bytes])); owned = true; if (bitmap.width * bitmap.height > 64000000) throw Error('图片超过6400万像素'); }
      checkAgentSignal(signal); raster = await noiseRaster(options, bitmap);
    } finally { if (owned) bitmap?.close(); }
    checkAgentSignal(signal);
    const result = await fit('noise', { ...raster, options: { threshold: options.threshold, polarity: options.mode === 'text' ? 'alpha' : options.polarity, invert: options.mode === 'image' && options.invertImage, maxSpan: options.merge ? options.maxSpan : 1, merge: options.merge, trim: options.trim } }, signal);
    const areas = fittedNoiseAreas(result, options), next = noiseFitChart(chart, areas), summary = { count: areas.length, width: result.width, height: result.height, layerId: options.layerId, first: options.first, last: options.last, duration: options.duration };
    if (args.analyzeOnly) return { access: 'read', apply: () => ({ ...summary, generated: false }) };
    const plan = prepareChart(args, chart, next, '生成噪域图案', summary), valid = plan.valid;
    return { ...plan, valid: () => valid() && (args.mode !== 'image' || sourceImage === (args.image ? editor.assets.get(args.image) : editor.noiseFitPanel?.bitmap)) };
  });
  register('text_fit', '原生文字拼合：指定字体骨架与现有判定线+零速Tap/Drag/Flick拼字，优先水平/竖直/45度并补偿父线/叠层。未达容忍度或覆盖下限不生成并返回原因。analyzeOnly只分析；replace覆盖冲突需关键批准，一次撤销。', agentSchema({ revision: agentText, text: { type: 'string', maxLength: 1000 }, font: { type: 'string', maxLength: 200 }, lines: { anyOf: [{ type: 'string' }, { type: 'array', items: agentIndex, maxItems: 5000 }] }, beat, width: number(10, 10000), x: agentNumber, y: agentNumber, spacing: number(.5, 4), size: number(.05, 4), noteType: choice([1, 3, 4]), tolerance: number(0, 90), coverage: number(0, 100), replace: boolean, addNotes: boolean, analyzeOnly: boolean }, ['revision', 'text', 'lines', 'beat']), 'edit', async (args, { signal }) => {
    const chart = check(args), options = { font: 'sans-serif', width: 900, x: 0, y: 0, spacing: 1.2, size: .4, noteType: 4, tolerance: 30, coverage: 95, ...args };
    const indices = lineIndices(args.lines, chart);
    if (!indices.length || indices.length > 5000 || new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index) || !chart.judgeLineList[index])) throw Error('参与判定线无效');
    const noteSize = editor.preview?.noteSize ?? 175, texture = () => editor.skin?.noteImage?.(options.noteType) ?? editor.skin?.images?.get({ 4: 'Drag2', 1: 'Tap2', 3: 'Flick2' }[options.noteType]), sourceTexture = texture();
    const raster = await textRaster(options, editor.skin, noteSize); checkAgentSignal(signal);
    const result = await fit('text', { mask: raster.mask, width: raster.width, height: raster.height, length: raster.length, thickness: raster.thickness, limit: indices.length, tolerance: options.tolerance / 100, requiredCoverage: options.coverage / 100 }, signal);
    const summary = { count: result.strokes.length, available: indices.length, error: result.error, skeletonCoverage: result.skeletonCoverage, passed: result.passed };
    if (args.analyzeOnly || !result.passed) return { access: 'read', apply: () => ({ ...summary, generated: false, reason: result.passed ? '仅分析，未生成' : '拟合误差或骨架覆盖未达标，请增加可用判定线或调整参数' }) };
    const strokes = result.strokes.map(stroke => ({ x: options.x + (stroke.x - raster.width / 2) / raster.scale, y: options.y - (stroke.y - raster.height / 2) / raster.scale, angle: stroke.angle }));
    const beatTime = time(args.beat), next = textLinesChart(chart, { ...options, strokes, indices, beatTime, beat: beatValue(beatTime) });
    const plan = prepareChart(args, chart, next, '文字拼合', summary, args.replace === true), valid = plan.valid;
    return { ...plan, valid: () => valid() && noteSize === (editor.preview?.noteSize ?? 175) && sourceTexture === texture() };
  });
  register('multi_line', '读取/设置多线编辑的线号或分组、启用、音符/事件模式、音符合并、单线宽度；只改工作区，不改谱面或播放头。lines为线号数组或0 2:8 组名表达式。', agentSchema({ lines: { anyOf: [{ type: 'string' }, { type: 'array', items: agentIndex, maxItems: 10000 }] }, enabled: boolean, mode: choice(['notes', 'events']), merge: boolean, width: number(30, 2400) }), 'read', args => {
    const chart = current(), session = editor.session, changing = Object.keys(args).length > 0;
    const indices = args.lines === undefined ? [...session.multiLineIndices] : lineIndices(args.lines, chart);
    if (indices.some(index => !Number.isInteger(index) || !chart.judgeLineList[index]) || new Set(indices).size !== indices.length || changing && (args.enabled ?? true) && !indices.length) throw Error('参与判定线无效');
    return { access: changing ? 'edit' : 'read', valid: () => editor.session === session && editor.chart === chart, apply: () => {
      if (changing) {
        session.multiLineIndices = indices; session.setMultiLineEnabled(args.enabled ?? true, args.mode ?? session.multiLineMode);
        if (args.merge !== undefined) session.setMultiLineMerge(args.merge);
        if (args.width !== undefined) { const events = session.multiLineMode === 'events'; editor.timeline[events ? 'multiLineEventWidth' : 'multiLineWidth'] = args.width; editor.timeline[events ? 'multiLineEventWidthExplicit' : 'multiLineWidthExplicit'] = true; editor.raw?.persistEditor?.(); }
        session.notify(); editor.render?.();
      }
      return { enabled: session.multiLineEnabled, mode: session.multiLineMode, lines: [...session.multiLineIndices], merge: session.multiLineMerge };
    } };
  });
  register('global_events', '列出加载的全局事件类型/列/来源/默认值，分页读取或替换列事件；沿用原生校验、模组来源与撤销，支持临时占位类型，未知类型只读。', agentSchema({ action: choice(['list', 'read', 'replace']), revision: agentText, type: agentText, column: agentText, offset: agentIndex, limit: integer(1, 200), events: { type: 'array', maxItems: 10000, items: { type: 'object' } } }, ['action']), 'read', args => {
    const document = editor.globalEvents.document;
    if (args.action === 'list') return { apply: () => document.types.map(type => ({ id: type.id, name: type.name, source: type.source, readonly: type.readonly, persistent: type.persistent, columns: type.columns.map(({ id, name, valueType, defaultValue, min, max, step, overlap }) => ({ id, name, valueType, defaultValue, min, max, step, overlap })) })) };
    const entry = document.columns.find(entry => entry.type.id === args.type && entry.column.id === args.column); if (!entry) throw Error('全局事件类型或列不存在');
    if (args.action === 'read') return { apply: () => { const events = document.read(args.type, args.column), offset = args.offset ?? 0, limit = args.limit ?? 100; return { type: args.type, column: args.column, total: events.length, events: events.slice(offset, offset + limit), nextOffset: offset + limit < events.length ? offset + limit : null }; } };
    const chart = check(args), session = editor.session, original = JSON.stringify(entry.events), registryRevision = document.registry.revision;
    if (entry.type.readonly || !Array.isArray(args.events)) throw Error('该全局事件不可编辑，或缺少events');
    args.events.forEach(event => { validateColumnEvent(entry.column, event); const result = entry.type.validate?.(event, entry.column); if (result === false || typeof result === 'string') throw Error(typeof result === 'string' ? result : '全局事件校验失败'); });
    return { access: entry.events.length > 100 ? 'dangerous' : 'edit', summary: `修改全局事件：${entry.type.name} / ${entry.column.name}`, details: { before: entry.events, after: args.events }, valid: () => editor.session === session && editor.chart === chart && document.registry.revision === registryRevision && JSON.stringify(document.read(args.type, args.column)) === original, apply: () => {
      if (!document.apply([{ type: args.type, column: args.column, events: args.events }], 'AI · 编辑全局事件')) throw Error('全局事件修改未应用'); return { count: args.events.length, undoable: true, persistent: entry.type.persistent };
    } };
  });
}
