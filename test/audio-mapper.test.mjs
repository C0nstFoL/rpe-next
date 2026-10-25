import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioMapperService, installAudioMapper } from '../desktop/audio-mapper.mjs';
import { MAPPER_DEFAULTS, MAPPER_MODELS, MAPPER_SOURCE_REVISION, mapperTiming, selectMapperPeaks } from '../src/core/audio-mapper.mjs';
import { AudioOnsets } from '../src/application/audio-onsets.mjs';
import { LocalAudioMapper } from '../src/platform/audio-mapper.mjs';
import { AudioSources } from '../src/application/audio-sources.mjs';
import { createChart } from '../src/core/chart.mjs';
import { AgentCommands } from '../src/core/agent-commands.mjs';
import { createAgentEditorCommands } from '../src/application/agent-editor.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { beatValue } from '../src/core/beat.mjs';

const audio = (duration = 6) => { const samples = new Float32Array(duration * 12000); return { sampleRate: 12000, length: samples.length, duration, numberOfChannels: 1, getChannelData: () => samples }; };

test('节奏草稿仅取实际按下时刻，同刻多键合并，不生成虚构置信度', () => {
  const objects = [{ seconds: 1, type: 'circle' }, { seconds: 1, type: 'hold_note' }, { seconds: 1.01, type: 'circle' }, { seconds: 1.25, type: 'slider_head' }, { seconds: 2, type: 'circle' }];
  const peaks = selectMapperPeaks(objects, { startSeconds: 1, endSeconds: 2 }); assert.deepEqual(peaks.map(peak => peak.seconds), [1, 1.25]); assert.equal(peaks[0].multiplicity, 2); assert.equal('confidence' in peaks[0], false);
  assert.throws(() => selectMapperPeaks([{ seconds: 1, type: 'beat' }], { startSeconds: 0, endSeconds: 2 }), /类型/);
  assert.throws(() => selectMapperPeaks([{ seconds: NaN, type: 'circle' }], { startSeconds: 0, endSeconds: 2 }), /时间/);
});

test('模型节奏上下文使用全局BPM与真实相位，不把判定线倍率重复套入BPM', () => {
  const chart = createChart(); chart.BPMList = [{ startTime: [0, 0, 1], bpm: 120 }, { startTime: [4, 0, 1], bpm: 150 }]; chart.META.offset = 250; chart.judgeLineList[0].bpmfactor = 2;
  assert.deepEqual(mapperTiming(chart, 1), [{ seconds: -.75, bpm: 120 }, { seconds: 1.25, bpm: 150 }]);
});

test('Mapperatorinator独立缓存模型/难度/种子/模式/BPM，间隔重筛选不重跑模型', async () => {
  let runs = 0; const requests = [], buffer = audio(), mapper = { bridge: {}, analyze: async (buffer, options) => { runs++; requests.push(options); return { engine: 'mapper', model: options.mapperModel, objects: [{ seconds: 1, type: 'circle' }, { seconds: 1.1, type: 'circle' }], usedChartTiming: options.timing.length > 0 }; } }, onsets = new AudioOnsets({ mapper, detector: { bridge: null }, getTiming: offset => [{ seconds: -offset, bpm: 150 }] });
  assert.equal(onsets.options.detector, 'mapper'); assert.equal(onsets.options.minGap, .02);
  const args = { startSeconds: 0, endSeconds: 3, sourceOffset: 1 }, first = await onsets.analyze(buffer, args); assert.equal(first.method, 'mapperatorinator-rhythm-draft'); assert.equal(first.peaks.length, 2); assert.deepEqual(requests[0].timing, [{ seconds: -1, bpm: 150 }]);
  const sparse = await onsets.analyze(buffer, { ...args, minGap: .2 }); assert.equal(sparse.peaks.length, 1); assert.equal(sparse.cacheHit, true); assert.equal(runs, 1);
  await onsets.analyze(buffer, { ...args, seed: 2 }); await onsets.analyze(buffer, { ...args, difficulty: 6 }); await onsets.analyze(buffer, { ...args, mapperMode: 0 }); await onsets.analyze(buffer, { ...args, mapperModel: 'v32-mini' }); await onsets.analyze(buffer, { ...args, useChartTiming: false }); assert.equal(runs, 6); assert.deepEqual(requests.at(-1).timing, []);
  await assert.rejects(onsets.analyze(buffer, { ...args, difficulty: 0 }), /参数/); await assert.rejects(onsets.analyze(buffer, { ...args, seed: .5 }), /参数/);
  const unavailable = new AudioOnsets({ mapper: { bridge: {}, analyze: async () => { throw Error('unavailable'); } } }); await assert.rejects(unavailable.analyze(buffer, args), /unavailable/); assert.equal(unavailable.busy, false);
});

test('本机桥接发送完整时间原点与BPM，JSON结果不误作显著性曲线，取消先于上传', async () => {
  const calls = [], buffer = audio(40), response = { engine: 'mapper', objects: [{ seconds: 20, type: 'circle' }] }, mapper = new LocalAudioMapper({ version: 1, call: async (action, ...args) => { calls.push([action, ...args]); return { ok: true, result: action === 'begin' ? 'token' : action === 'execute' ? { cacheId: 'cache' } : action === 'read' ? new TextEncoder().encode(JSON.stringify(response)) : null }; } });
  const result = await mapper.analyze(buffer, { ...MAPPER_DEFAULTS, startSeconds: 20, endSeconds: 21, timing: [{ seconds: 0, bpm: 150 }] }); assert.equal(result.objects[0].seconds, 20);
  const request = calls.find(call => call[0] === 'begin')[1]; assert.equal(request.originSeconds, 4); assert.equal(request.sourceDuration, 40); assert.equal(request.startSeconds, 20); assert.equal(request.endSeconds, 21); assert.equal(request.frames, 33 * 12000);
  assert.equal(calls.filter(call => call[0] === 'write').reduce((total, call) => total + call[3].length, 0), request.frames * 4);
  const controller = new AbortController(); controller.abort(); await assert.rejects(mapper.analyze(buffer, {}, controller.signal), { name: 'AbortError' }); await assert.rejects(new LocalAudioMapper(null).call('probe'), /桌面端/);
});

test('Mapperatorinator生成Tap保留对齐与倍率，写入一次历史并允许撤销重做', async () => {
  const original = audio(), stem = audio(3), transport = { buffer: original, ensureContext: () => ({ decodeAudioData: async () => stem, createBuffer: (channels, length, rate) => audio(length / rate) }) }, sources = new AudioSources(() => transport, { separator: {} }), id = await sources.import(new Uint8Array(4), 'stem.wav'), requests = [];
  const onsets = new AudioOnsets({ mapper: { bridge: {}, analyze: async (buffer, options) => { requests.push(options); return { model: 'v32', objects: [{ seconds: .5, type: 'circle' }, { seconds: 1, type: 'hold_note' }, { seconds: 1.5, type: 'circle' }] }; } } });
  const session = new EditorSession(); session.chart.META.offset = 250; session.chart.judgeLineList[0].bpmfactor = 2;
  const editor = { session, get chart() { return session.chart; }, hasDocument: true, audio: transport, audioSources: sources, audioOnsets: onsets, timeline: { layer: 0 }, currentBeat: () => 0, chartSeconds: () => 0, noiseEditor: { selected: -1, selection: new Set() }, globalEvents: { document: { types: [] } }, assets: new Map(), commit: (label, chart) => session.commit(label, chart) };
  const commands = new AgentCommands(), adapter = createAgentEditorCommands(commands, editor), execute = (name, args, context = {}) => commands.execute(name, args, { permission: 'full', ...context }), args = { line: 0, start: .1, end: 1.7, source: id, detector: 'mapper' };
  const analyzed = (await execute('audio_analyze', args)).result; assert.deepEqual(analyzed.peaks.map(peak => peak.seconds), [.5, 1, 1.5]); assert.deepEqual(analyzed.peaks.map(peak => peak.beat), [.25, .75, 1.25]); assert.equal(requests[0].timing[0].seconds, .25);
  const tapArgs = { ...args, revision: adapter.revision(), division: 4, quantization: 'none' }; assert.equal((await execute('audio_taps', tapArgs)).result.added, 3); assert.deepEqual(session.notes.map(note => beatValue(note.startTime)), [.25, .75, 1.25]); session.travel('undo'); assert.equal(session.notes.length, 0); session.travel('redo'); assert.equal(session.notes.length, 3); session.travel('undo');
  await assert.rejects(execute('audio_taps', { ...tapArgs, revision: adapter.revision() }, { permission: 'ask', approve: async () => { await sources.select(id); return true; } }), /状态已变化/); assert.equal(session.notes.length, 0);
});

test('原生节奏缓存校验、参数隔离和损坏重建；安装只由受控主框架触发', async context => {
  const root = await mkdtemp(join(tmpdir(), 'rpen-mapper-')); context.after(() => rm(root, { recursive: true, force: true })); const service = new AudioMapperService(root, { python: process.execPath, source: root, script: 'fixture' }); let runs = 0;
  service.run = async (python, args) => { runs++; const request = JSON.parse(await readFile(args.at(-1), 'utf8')), result = { engine: 'mapper', sourceRevision: MAPPER_SOURCE_REVISION, model: request.model, modelRevision: MAPPER_MODELS.find(model => model.id === request.model).revision, objects: [{ seconds: .5, type: 'circle' }] }; await writeFile(request.output, JSON.stringify(result)); return { engine: 'mapper' }; };
  const input = async (options = {}) => { const token = await service.begin({ ...MAPPER_DEFAULTS, id: 'test', sampleRate: 12000, frames: 12000, startSeconds: 0, endSeconds: 1, originSeconds: 0, sourceDuration: 1, timing: [{ seconds: 0, bpm: 150 }], ...options }); await service.write(token, 0, new Uint8Array(48000)); return token; };
  const first = await service.execute(await input()), cached = await service.execute(await input()); assert.equal(runs, 1); assert.equal(cached.cacheHit, true); assert.equal(JSON.parse(new TextDecoder().decode(await service.read(first.cacheId))).objects.length, 1);
  await service.execute(await input({ seed: 2 })); assert.equal(runs, 2); await service.execute(await input({ timing: [{ seconds: 0, bpm: 160 }] })); assert.equal(runs, 3);
  const directories = await readdir(join(root, 'cache')); for (const directory of directories) await writeFile(join(root, 'cache', directory, 'rhythm.json'), '{}'); await service.execute(await input()); assert.equal(runs, 4);
  await assert.rejects(service.read('../bad'), /句柄/); await assert.rejects(input({ difficulty: NaN }), /参数/); assert.deepEqual(await readdir(join(root, 'jobs')), []);
  const handlers = new Map(), sender = { mainFrame: { url: 'rpe://app/' } }; installAudioMapper({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, service, origin: 'rpe://app', window: () => ({ webContents: sender }), dialog: {} }); const handle = handlers.get('rpen-audio-mapper');
  assert.equal((await handle({ sender: {}, senderFrame: {} }, { action: 'install' })).ok, false); assert.equal((await handle({ sender, senderFrame: { url: 'rpe://app/' } }, { action: 'install' })).ok, false); assert.equal((await handle({ sender, senderFrame: sender.mainFrame }, { action: 'exec' })).ok, false);
});
