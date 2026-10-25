import test from 'node:test';
import assert from 'node:assert/strict';
import { TempoMap } from '../src/core/tempo.mjs';

const previousDocument = globalThis.document;
globalThis.document = { querySelector: () => null };
const { AudioAnalysis, analyseAudioBuffer } = await import('../src/ui/audio-analysis.mjs');
const { setEditorCanvasSkin } = await import('../src/ui/editor-skin-canvas.mjs');
globalThis.document = previousDocument;

function fixture() {
  const operations = [], states = [], rectangle = { width: 400, height: 200, left: 0 }, styleWrites = [], style = new Proxy({}, { set(target, key, value) { styleWrites.push([key, value]); target[key] = value; return true; } });
  const canvas = { id: 'audio-analysis-overlay', hidden: true, width: 0, height: 0, style, parentElement: { getBoundingClientRect: () => rectangle } };
  const context = { canvas, globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, setTransform() {}, clearRect: () => operations.push('clear'), fillRect: (...args) => operations.push({ rectangle: args, alpha: context.globalAlpha }), save: () => states.push(context.globalAlpha), restore: () => { context.globalAlpha = states.pop(); } }; canvas.getContext = () => context;
  const tempo = new TempoMap([{ startTime: [0, 0, 1], bpm: 120 }]), timeline = { tempo, origin: 0, factor: 1, scale: 100, judgementOffset: 42, viewHeight: () => rectangle.height, notesCanvas: { getBoundingClientRect: () => ({ width: 180, height: rectangle.height, left: 20, right: 200 }) }, getSession: () => ({}) };
  timeline.timeAt = () => { throw Error('绘图不应逐行访问时间轴布局'); };
  const buffer = { duration: 4 }, data = { duration: 4, waveform: new Float32Array(100).fill(.5) }, analysis = new AudioAnalysis(canvas, () => timeline, () => ({ buffer }));
  analysis.data = data; analysis.layers = [{ data, buffer, color: '#5db9d4' }]; analysis.enabled = true;
  return { analysis, canvas, operations, styleWrites, timeline, rectangle };
}

test('静止分析图复用现有画面，无重复画布操作或样式写入；仅分配有效横向区域', () => {
  const { analysis, canvas, operations, styleWrites } = fixture(); analysis.draw(.1); assert.equal(canvas.hidden, false); assert.ok(canvas.width < analysis.drawRegion.fullWidth); assert.ok(operations.some(entry => entry === 'clear'));
  operations.length = 0; styleWrites.length = 0; for (let frame = 0; frame < 120; frame++) analysis.draw(.1); assert.equal(operations.length, 0); assert.equal(styleWrites.length, 0);
  analysis.enabled = false; analysis.draw(.1); assert.equal(canvas.hidden, true); analysis.enabled = true; analysis.draw(.1); assert.equal(canvas.hidden, false); assert.ok(operations.length > 0);
});

test('定位、缩放、视区大小、透明度和皮肤变化及时重绘，不跳过有效更新', () => {
  const { analysis, timeline, operations, rectangle, styleWrites } = fixture(); analysis.draw(0);
  for (const change of [() => { timeline.origin = 2; }, () => { timeline.scale = 180; }, () => { rectangle.width = 500; }, () => { analysis.alpha = .5; }, () => { analysis.width = .4; }]) {
    operations.length = 0; change(); analysis.draw(0); assert.ok(operations.length > 0);
  }
  const before = styleWrites.length; rectangle.height = 300; analysis.draw(.25); assert.equal(analysis.canvas.height, 300); assert.equal(styleWrites.length, before);
  try { setEditorCanvasSkin({ opacity: .25 }); operations.length = 0; analysis.draw(.25); const fills = operations.filter(entry => typeof entry === 'object'); assert.ok(fills.length > 0); assert.ok(fills.every(entry => entry.alpha === .125)); }
  finally { setEditorCanvasSkin(null); }
});

test('音频以外的时间范围不逐像素绘制空白行，但仍保留画面清理', () => {
  const { analysis, timeline, operations } = fixture(); timeline.origin = 500; analysis.draw(0); assert.deepEqual(operations, ['clear']); operations.length = 0; timeline.origin = -500; analysis.draw(0); assert.deepEqual(operations, ['clear']);
});

test('短音频滚动取每行完整时间范围的峰值，恒定音量不会随抽样相位闪动', () => {
  const rate = 48000, length = rate * 20, samples = new Float32Array(length);
  for (let index = 0; index < samples.length; index++) samples[index] = 0.5 * Math.sin(2 * Math.PI * 440 * index / rate);
  const data = analyseAudioBuffer({ length, duration: 20, numberOfChannels: 1, getChannelData: () => samples }, { bands: 16, spectrumFrames: 256 });
  const { analysis, timeline, operations } = fixture(); analysis.layers[0].data = data; analysis.data = data; analysis.getAudio = () => ({ buffer: { duration: 20 } }); timeline.scale = 500;
  const widths = [];
  for (let frame = 0; frame < 120; frame++) {
    timeline.origin = 8 + frame / 120; operations.length = 0; analysis.draw(0);
    widths.push(operations.find(entry => typeof entry === 'object' && entry.rectangle[1] === 120).rectangle[2]);
  }
  assert.ok((Math.max(...widths) - Math.min(...widths)) / Math.max(...widths) < 0.01);
  const envelope = analysis.waveformCache.get(data.waveform);
  timeline.origin += 1; analysis.draw(0); assert.equal(analysis.waveformCache.get(data.waveform), envelope);
});
