import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createChart, createNote } from '../src/core/chart.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { HitSounds } from '../src/platform/hitsounds.mjs';

function setup(notes, rate = 1, testContext) {
  const chart = createChart(); chart.judgeLineList[0].notes = notes; const sources = [], mixers = [], generators = [];
  const context = { currentTime: 0, sampleRate: 8000, createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: channel => data[channel] };
  }, createConvolver() { const mixer = { connect() {}, disconnect() { this.disconnected = true; } }; mixers.push(mixer); return mixer; },
  createBufferSource() { const source = { connect(destination) { this.destination = destination; }, disconnect() { this.disconnected = true; }, start(time) { this.at = time; sources.push(this); }, stop() { this.stopped = true; } }; return source; } };
  const transport = { playing: true, time: 0, rate, playRevision: 1, context }, sounds = new HitSounds(transport); sounds.gain = {};
  const buffer = context.createBuffer(2, 1600, context.sampleRate); sounds.buffers.set('tap', buffer); sounds.buffers.set('drag', buffer);
  if (testContext) {
    const original = globalThis.AudioWorkletNode;
    globalThis.AudioWorkletNode = class {
      constructor(context, name, options) { assert.equal(name, 'rpen-hit-impulses'); this.frames = options.processorOptions.frames; this.messages = []; this.port = { postMessage: message => this.messages.push(message) }; generators.push(this); }
      connect() {} disconnect() { this.disconnected = true; }
    };
    testContext.after(() => { if (original === undefined) delete globalThis.AudioWorkletNode; else globalThis.AudioWorkletNode = original; }); sounds.workletContext = context;
  }
  return { sounds, transport, context, chart, tempo: new TempoMap(chart.BPMList), buffer, sources, mixers, generators };
}

test('千个同拍音符交给同一音频线程，不再被同拍或声部上限截断', context => {
  const state = setup(Array.from({ length: 1000 }, () => createNote(1, 2, 0)), 1, context); state.transport.time = .95; state.sounds.tick(state.chart, state.tempo);
  assert.equal(state.sources.length, 0); assert.equal(state.mixers.length, 1); assert.equal(state.mixers[0].normalize, false); assert.equal(state.mixers[0].buffer, state.buffer);
  assert.equal(state.generators[0].frames.length, 1000); assert.ok(state.generators[0].frames.every(frame => Math.abs(frame - 400) < 1e-6)); assert.equal(state.sounds.next, 1000);
});

test('连续高密度音符全部保留，正常音效与音频线程切换不重复，后续帧不重新提交整张谱面', context => {
  const count = 3000, state = setup(Array.from({ length: count }, (unused, index) => createNote(1, 2 + index / 500, 0)), 1, context);
  for (let frame = 0; frame < 250; frame++) {
    state.context.currentTime = frame / 60; state.transport.time = .95 + state.context.currentTime;
    for (const source of [...state.sounds.sources]) if (source.at + source.buffer.duration < state.context.currentTime) source.onended();
    state.sounds.tick(state.chart, state.tempo);
  }
  assert.equal(state.sounds.next, count); assert.equal(state.generators.length, 1); assert.equal(state.generators[0].messages.length, 0);
  const frames = [...state.sources.map(source => source.at * 8000), ...state.generators[0].frames].sort((left, right) => left - right);
  assert.equal(frames.length, count); frames.forEach((frame, index) => assert.ok(Math.abs(frame - (state.tempo.seconds(state.chart.judgeLineList[0].notes[index].startTime) - .95) * 8000) < 1e-6));
});

test('混合调度保留倍速、音高和延迟；暂停清除旧尾音；音乐时钟漂移能重新对齐', context => {
  const state = setup(Array.from({ length: 80 }, () => createNote(1, 2, 0)), .5, context); state.sounds.setDelays({ tap: 100 }); state.transport.time = 1.1 - .025 * .5; state.sounds.tick(state.chart, state.tempo);
  assert.ok(state.generators[0].frames.every(frame => Math.abs(frame - 200) < 1e-6)); assert.equal(state.mixers[0].buffer, state.buffer);
  state.context.currentTime += .03; state.sounds.tick(state.chart, state.tempo); assert.ok(Math.abs(state.generators[0].messages[0].shift - 240) < 1e-6);
  state.sounds.stop(); assert.equal(state.mixers[0].disconnected, true); assert.equal(state.generators[0].disconnected, true); assert.equal(state.generators[0].messages.at(-1), 'stop'); assert.equal(state.sounds.mixers.size, 0);
});

test('没有音频线程时按块精确叠加，不丢弃音符，普通密度仍使用原音效', () => {
  const state = setup(Array.from({ length: 1000 }, () => createNote(1, 2, 0))); state.buffer.getChannelData(0).fill(.001); state.buffer.getChannelData(1).fill(.002); state.transport.time = .95;
  state.sounds.tick(state.chart, state.tempo); assert.equal(state.sources.length, 1); assert.equal(state.mixers.length, 0); assert.ok(Math.abs(state.sources[0].at - .05) < 1e-6);
  assert.ok(Math.abs(state.sources[0].buffer.getChannelData(0)[800] - 1) < .0001); assert.ok(Math.abs(state.sources[0].buffer.getChannelData(1)[800] - 2) < .0001);
  const sparse = setup([createNote(1, 2, 0)]); sparse.transport.time = .95; sparse.sounds.tick(sparse.chart, sparse.tempo); assert.equal(sparse.sources[0].buffer, sparse.buffer);
});

test('画面长时间卡顿不会重建或截断已交给音频线程的打击序列，替换素材会停止旧序列', context => {
  const state = setup(Array.from({ length: 1000 }, (unused, index) => createNote(1, 2 + index / 1000, 0)), 1, context); state.transport.time = .95; state.sounds.tick(state.chart, state.tempo);
  const frames = [...state.generators[0].frames]; state.transport.time += 1; state.context.currentTime += 1; state.sounds.tick(state.chart, state.tempo);
  assert.equal(state.generators.length, 1); assert.deepEqual([...state.generators[0].frames], frames);
  state.sounds.setAssets(new Map([['new.wav', new Uint8Array([1])]])); assert.equal(state.generators[0].messages.at(-1), 'stop'); assert.equal(state.sounds.mixers.size, 0);
});

test('音频线程模块加载失败允许回退，下一次可重试，不阻止原有音乐播放', async context => {
  const state = setup([], 1, context); state.sounds.workletContext = null; let requests = 0;
  state.context.audioWorklet = { async addModule(url) { assert.match(String(url), /hitsound-impulses\.mjs$/); if (++requests === 1) throw TypeError('Failed to fetch'); } };
  await state.sounds.prepareMixer(state.context); assert.equal(state.sounds.workletContext, null); await state.sounds.prepareMixer(state.context); assert.equal(state.sounds.workletContext, state.context); assert.equal(requests, 2);
});

test('负时间预滚不提前向音频线程提交音乐起点后的打击，假音符不参与混音', context => {
  const state = setup(Array.from({ length: 100 }, (unused, index) => ({ ...createNote(1, index % 2 ? -.02 : 0, 0), isFake: index < 10 ? 1 : 0 })), 1, context);
  state.buffer.getChannelData(0).fill(.01); state.transport.time = -.03; state.transport.scheduleHorizon = 0; state.sounds.tick(state.chart, state.tempo);
  assert.equal(state.generators.length, 0); assert.equal(state.sounds.next, 45); assert.ok(Math.abs(state.sources[0].buffer.getChannelData(0)[400] - .45) < .0001);
});

test('音频线程在跨处理块的分数帧、同时打击、时钟修正和停止时保持正确冲激', async () => {
  let Processor; const environment = { AudioWorkletProcessor: class { constructor() { this.port = {}; } }, currentFrame: 0, registerProcessor(name, implementation) { Processor = implementation; } };
  runInNewContext(await readFile(new URL('../src/platform/hitsound-impulses.mjs', import.meta.url), 'utf8'), environment);
  const processor = new Processor({ processorOptions: { frames: new Float64Array([.25, 127.75, 128.2, 300, 300]) } }), output = new Float32Array(128);
  assert.equal(processor.process([], [[output]]), true); assert.equal(output[0], .75); assert.equal(output[1], .25); assert.equal(output[127], .25);
  environment.currentFrame = 128; output.fill(0); processor.process([], [[output]]); assert.ok(Math.abs(output[0] - 1.55) < 1e-6); assert.ok(Math.abs(output[1] - .2) < 1e-6);
  processor.port.onmessage({ data: { shift: 10 } }); environment.currentFrame = 256; output.fill(0); processor.process([], [[output]]); assert.equal(output[54], 2);
  processor.port.onmessage({ data: 'stop' }); assert.equal(processor.process([], [[output]]), false);
});
