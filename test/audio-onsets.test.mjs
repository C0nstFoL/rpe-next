import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioOnsetService, installAudioOnsets } from '../desktop/audio-onsets.mjs';
import { LocalOnsetDetector, onsetAudioWindow } from '../src/platform/audio-onsets.mjs';
import { selectOnsetPeaks, estimateOnsetBpms } from '../src/core/audio-onsets.mjs';
import { AudioOnsets } from '../src/application/audio-onsets.mjs';
import { AudioSources } from '../src/application/audio-sources.mjs';
import { AgentCommands } from '../src/core/agent-commands.mjs';
import { createAgentEditorCommands } from '../src/application/agent-editor.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { beatValue } from '../src/core/beat.mjs';

const audio = (samples, sampleRate = 12000) => { const channels = Array.isArray(samples) ? samples : [samples]; return { sampleRate, numberOfChannels: channels.length, length: channels[0].length, duration: channels[0].length / sampleRate, getChannelData: index => channels[index] }; };

test('模型候选按显著性、边界与间隔筛选，不重复添加平顶峰；弱音阈值可调整', () => {
  const salience = new Float32Array(300); salience[20] = .8; salience[24] = .9; salience[60] = .1; salience[100] = salience[101] = .7; salience[200] = .9;
  const raw = { salience, startSeconds: 1, frameRate: 100 }, options = { startSeconds: 1.2, endSeconds: 3, minGap: .08, minConfidence: .15 };
  assert.deepEqual(selectOnsetPeaks(raw, options).map(entry => entry.seconds), [1.24, 2]);
  assert.deepEqual(selectOnsetPeaks(raw, { ...options, minConfidence: .05 }).map(entry => entry.seconds), [1.24, 1.6, 2]);
  assert.throws(() => selectOnsetPeaks(raw, { ...options, minConfidence: NaN }), /无效/);
  assert.equal(selectOnsetPeaks({ ...raw, salience: new Float32Array(300) }, options).length, 0); assert.deepEqual(estimateOnsetBpms(new Float32Array(300), 100), []);
});

test('输入只包含所需上下文，反相立体声不相消，时间原点保留，取消先于上传', async () => {
  const samples = new Float32Array(60000).fill(.4), buffer = audio([samples, Float32Array.from(samples, value => -value)]), result = await onsetAudioWindow(buffer, 2, 3);
  assert.equal(result.startSeconds, 1); assert.equal(result.samples.length, 36000); assert.equal(result.channelMode, 'strongest-channel'); assert.ok(result.samples[0] > .39);
  const controller = new AbortController(); controller.abort(); await assert.rejects(onsetAudioWindow(buffer, 2, 3, controller.signal), { name: 'AbortError' });
  await assert.rejects(onsetAudioWindow(buffer, -1, 2), /区间/); await assert.rejects(new LocalOnsetDetector(null).call('probe'), /桌面端/);
});

test('模型推理缓存和门限筛选分离，失败不静默回退，已有请求可取消', async () => {
  const buffer = audio(new Float32Array(36000)), raw = { salience: new Float32Array(300), frameRate: 100, startSeconds: 0, device: 'cpu', version: '.1' }; raw.salience[100] = .6; raw.salience[150] = .12;
  let runs = 0; const detector = { bridge: {}, analyze: async () => { runs++; return raw; } }, onsets = new AudioOnsets({ detector });
  const first = await onsets.analyze(buffer, { startSeconds: 0, endSeconds: 3 }); assert.equal(first.peaks.length, 1);
  const second = await onsets.analyze(buffer, { startSeconds: 0, endSeconds: 3, minConfidence: .1 }); assert.equal(second.peaks.length, 2); assert.equal(second.cacheHit, true); assert.equal(runs, 1);
  await assert.rejects(onsets.analyze(buffer, { startSeconds: 0, endSeconds: 3, focus: 'melody' }), /完整频谱/);
  const failing = new AudioOnsets({ detector: { bridge: {}, analyze: async () => { throw Error('model unavailable'); } } }); await assert.rejects(failing.analyze(buffer, { startSeconds: 0, endSeconds: 3 }), /model unavailable/); assert.equal(failing.busy, false);
  const controller = new AbortController(); controller.abort(); await assert.rejects(onsets.analyze(buffer, { startSeconds: 0, endSeconds: 3 }, controller.signal), { name: 'AbortError' });
  onsets.configure({ detector: 'flux' }); assert.equal(onsets.options.minConfidence, .35); onsets.configure({ detector: 'ddc' }); assert.equal(onsets.options.minConfidence, .15);
});

test('学习型采音共用谱面延迟与线倍率，切换音源使审批失效且一次撤销重做', async () => {
  const original = audio(new Float32Array(60000)), stem = audio(new Float32Array(24000)), transport = { buffer: original, ensureContext: () => ({ decodeAudioData: async () => stem, createBuffer: (channels, length, rate) => audio(new Float32Array(length), rate) }) }, sources = new AudioSources(() => transport, { separator: {} }), id = await sources.import(new Uint8Array(4), 'drums.wav');
  const raw = { salience: new Float32Array(200), frameRate: 100, startSeconds: 0, device: 'cpu' }; for (const index of [50, 100, 150]) raw.salience[index] = .8;
  const onsets = new AudioOnsets({ detector: { bridge: {}, analyze: async () => raw } }), session = new EditorSession(); session.chart.META.offset = 250; session.chart.judgeLineList[0].bpmfactor = 2;
  const editor = { session, get chart() { return session.chart; }, hasDocument: true, audio: transport, audioSources: sources, audioOnsets: onsets, timeline: { layer: 0 }, currentBeat: () => 0, chartSeconds: () => 0, noiseEditor: { selected: -1, selection: new Set() }, globalEvents: { document: { types: [] } }, assets: new Map(), commit: (label, chart) => session.commit(label, chart) };
  const commands = new AgentCommands(), adapter = createAgentEditorCommands(commands, editor), execute = (name, args, context = {}) => commands.execute(name, args, { permission: 'full', ...context });
  assert.equal((await execute('audio_detector', {})).result.options.detector, 'ddc');
  const analysisArgs = { line: 0, start: .1, end: 1.7, source: id, detector: 'ddc' }, args = { ...analysisArgs, division: 4, quantization: 'none' }, analyzed = (await execute('audio_analyze', analysisArgs)).result;
  assert.deepEqual(analyzed.peaks.map(peak => peak.seconds), [.5, 1, 1.5]); assert.deepEqual(analyzed.peaks.map(peak => peak.beat), [.25, .75, 1.25]);
  const result = await execute('audio_taps', { ...args, revision: adapter.revision() }); assert.equal(result.result.added, 3); assert.deepEqual(session.notes.map(note => beatValue(note.startTime)), [.25, .75, 1.25]); session.travel('undo'); assert.equal(session.notes.length, 0); session.travel('redo'); assert.equal(session.notes.length, 3); session.travel('undo');
  await assert.rejects(execute('audio_taps', { ...args, revision: adapter.revision() }, { permission: 'ask', approve: async () => { await sources.select(id); return true; } }), /状态已变化/); assert.equal(session.notes.length, 0);
});

test('原生模型只在完整上传后运行，复用并验证磁盘缓存，取消清理上传且IPC拒绝越权', async context => {
  const root = await mkdtemp(join(tmpdir(), 'rpen-onset-')); context.after(() => rm(root, { recursive: true, force: true }));
  const service = new AudioOnsetService(root, { python: process.execPath, script: 'fixture' }); let runs = 0;
  service.run = async (python, args) => { runs++; const request = JSON.parse(await readFile(args.at(-1), 'utf8')); await writeFile(request.output, new Uint8Array(new Float32Array(100).fill(.25).buffer)); return { engine: 'ddc', version: '.1', frames: 100, frameRate: 100 }; };
  const input = async () => { const token = await service.begin({ id: 'onset-test', sampleRate: 12000, frames: 12000, device: 'cpu' }); await service.write(token, 0, new Uint8Array(48000)); return token; };
  await assert.rejects(service.begin({ id: '../bad', frames: 10, sampleRate: 12000 }), /参数/);
  const token = await service.begin({ id: 'cancel', frames: 12000, sampleRate: 12000 }); await assert.rejects(service.execute(token), /完整/); await assert.rejects(service.write(token, 1, new Uint8Array(4)), /分片/); await service.cancel(token); assert.equal(service.jobs.size, 0);
  const first = await service.execute(await input()), second = await service.execute(await input()); assert.equal(runs, 1); assert.equal(second.cacheHit, true); assert.equal((await service.read(first.cacheId)).length, 400);
  const directory = join(root, 'cache', (await readdir(join(root, 'cache')))[0]); await writeFile(join(directory, 'salience.f32'), new Uint8Array(new Float32Array(100).fill(NaN).buffer)); const repaired = await service.execute(await input()); assert.equal(repaired.cacheHit, false); assert.equal(runs, 2); assert.deepEqual(await readdir(join(root, 'jobs')), []);
  await assert.rejects(service.read('../bad'), /句柄/);
  const handlers = new Map(), sender = { mainFrame: { url: 'rpe://app/' } }; installAudioOnsets({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, service, origin: 'rpe://app', window: () => ({ webContents: sender }), dialog: {} }); const handle = handlers.get('rpen-audio-onsets');
  assert.equal((await handle({ sender: {}, senderFrame: {} }, { action: 'clear' })).ok, false); assert.equal((await handle({ sender, senderFrame: { url: 'rpe://app/' } }, { action: 'read', args: [first.cacheId] })).ok, false); assert.equal((await handle({ sender, senderFrame: sender.mainFrame }, { action: 'exec' })).ok, false);
});
