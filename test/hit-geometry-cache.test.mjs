import test from 'node:test';
import assert from 'node:assert/strict';
import { HitGeometryCache } from '../src/core/hit-effects.mjs';
import { RpeSkin } from '../src/ui/skin.mjs';
import { ResourceNoteSkin } from '../src/ui/resource-note-skin.mjs';

test('连续帧复用同次打击的位置，Hold的每次脉冲保持独立，离开可见时间范围释放缓存', () => {
  const cache = new HitGeometryCache(), scene = { chart: {}, tempo: {} }, note = {}, hold = {}; let samples = 0;
  const compute = () => ({ sample: ++samples });
  cache.begin(scene, { x: 1, y: 1 }); const first = cache.sample(note, 2, compute), pulse = cache.sample(hold, 2, compute), nextPulse = cache.sample(hold, 2.2, compute); cache.end();
  cache.begin(scene, { x: 1, y: 1 }); assert.equal(cache.sample(note, 2, compute), first); assert.equal(cache.sample(hold, 2.2, compute), nextPulse); cache.end();
  assert.equal(samples, 3); assert.equal(cache.entries.get(hold).has(2), false);
  cache.begin(scene, { x: 1, y: 1 }); cache.end(); assert.equal(cache.entries.size, 0); assert.notEqual(pulse, nextPulse);
});

test('修改谱面、BPM或预览宽高比会重新采样，改变画布比例或视野不改变缓存的谱面坐标', () => {
  const cache = new HitGeometryCache(), scene = { chart: {}, tempo: {} }, note = {}; let samples = 0;
  for (const change of [() => {}, () => { scene.chart = {}; }, () => { scene.tempo = {}; }]) {
    change(); cache.begin(scene, { x: 1, y: 1 }); cache.sample(note, 1, () => ++samples); cache.end();
  }
  cache.begin(scene, { x: 1, y: .75 }); assert.equal(cache.sample(note, 1, () => ++samples), 4); cache.end();
  cache.begin(scene, { x: 1, y: .75 }); assert.equal(cache.sample(note, 1, () => ++samples), 4); assert.equal(samples, 4);
});

test('模组覆盖实例或原型的特效绘制后自动沿用原绘制接口，不采用未知的批量绘制或裁剪范围', () => {
  const skin = new RpeSkin(() => {}), original = RpeSkin.prototype.drawHit;
  assert.equal(skin.hitBatchCompatible, true);
  try { RpeSkin.prototype.drawHit = () => true; assert.equal(skin.hitBatchCompatible, false); assert.equal(skin.hitRadius(200), Infinity); }
  finally { RpeSkin.prototype.drawHit = original; }
  const pack = new ResourceNoteSkin({ id: 'test', info: {} }, new Map(), () => {}); skin.resourcePack = pack;
  assert.equal(skin.hitBatchCompatible, true); pack.drawHit = () => true; assert.equal(skin.hitBatchCompatible, false); assert.equal(skin.hitRadius(200), Infinity);
});
