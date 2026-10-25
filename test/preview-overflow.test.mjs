import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EDITOR_PREFERENCES } from '../src/core/default-settings.mjs';
import { normalizeEditorPreferences } from '../src/platform/editor-preferences.mjs';
import { overflowTextureSize } from '../src/core/editor-display.mjs';
import { Preview } from '../src/ui/preview.mjs';
import { createChart } from '../src/core/chart.mjs';

test('预览窗口外内容默认关闭并限制模糊与变暗参数', () => {
  assert.equal(DEFAULT_EDITOR_PREFERENCES.viewportOverflow, false);
  assert.equal(DEFAULT_EDITOR_PREFERENCES.overflowBlur, 25);
  assert.equal(DEFAULT_EDITOR_PREFERENCES.overflowDarken, 0.15);
  assert.equal(normalizeEditorPreferences({ viewportOverflow: false }).viewportOverflow, false);
  assert.equal(normalizeEditorPreferences({ overflowBlur: 200 }).overflowBlur, 80);
  assert.equal(normalizeEditorPreferences({ overflowDarken: -1 }).overflowDarken, 0);
});

test('窗口外模糊使用受限分辨率，高 DPI 不再扩大模糊缓冲，关闭模糊时保留像素精度', () => {
  const size = overflowTextureSize(1600, 700, 1.5, 25);
  assert.equal(size.width, 512); assert.equal(size.height, 224);
  assert.deepEqual(overflowTextureSize(1600, 700, 2, 25), size);
  assert.deepEqual(overflowTextureSize(1600, 700, 2, 25, 4), { width: 256, height: 112 });
  assert.deepEqual(overflowTextureSize(1000, 400, 2, 0), { width: 2000, height: 800 });
  const large = overflowTextureSize(16000, 7000, 2, 1);
  assert.ok(large.width * large.height < 482000);
});

test('窗口外预览缓存静止画面，播放以独立刷新频率更新，参数或时间跳转立即生效', context => {
  const original = globalThis.document;
  globalThis.document = {};
  context.after(() => { if (original === undefined) delete globalThis.document; else globalThis.document = original; });
  let timestamp = 100;
  context.mock.method(performance, 'now', () => timestamp);
  const renderer = Object.assign(Object.create(Preview.prototype), {
    viewportOverflow: true, overflowBlur: 25, overflowDarken: 0.45, overflowRevision: 0,
    noisePreview: {}, shaderRuntime: { sources: new Map() },
  });
  const chart = createChart(), tempo = {}, frame = { width: 1600, height: 700, scale: 1, viewport: { left: 275, width: 1050 } };
  const prepare = seconds => renderer.prepareViewportOverflowFrame(chart, tempo, seconds, 0, frame);
  prepare(5); assert.equal(renderer.overflowRefreshRequired, true);
  renderer.overflowMemo = renderer.overflowPendingMemo;
  timestamp += 1; prepare(5); assert.equal(renderer.overflowRefreshRequired, false);
  timestamp += 4; prepare(5.008); assert.equal(renderer.overflowRefreshRequired, false);
  timestamp += 20; prepare(5.016); assert.equal(renderer.overflowRefreshRequired, true);
  timestamp = 101; prepare(2); assert.equal(renderer.overflowRefreshRequired, true);
  prepare(6); assert.equal(renderer.overflowRefreshRequired, true);
  renderer.overflowBlur = 30; prepare(5); assert.equal(renderer.overflowRefreshRequired, true);
  renderer.overflowBlur = 25; renderer.noisePreview.hiddenLayers = new Set(['water']); prepare(5); assert.equal(renderer.overflowRefreshRequired, true);
  renderer.noisePreview.hiddenLayers.clear(); prepare(5); assert.equal(renderer.overflowRefreshRequired, false);
  frame.shaderEffects = [{ shader: 'glitch', startBeat: 0, endBeat: 10, global: true }]; prepare(5); assert.equal(renderer.overflowRefreshRequired, true);
  frame.shaderEffects = []; prepare(5); assert.equal(renderer.overflowRefreshRequired, false);
  renderer.overflowRevision++; prepare(5); assert.equal(renderer.overflowRefreshRequired, true);
  renderer.overflowRevision--; renderer.images = { backgroundAnimated: true }; prepare(5); renderer.overflowMemo = renderer.overflowPendingMemo;
  prepare(5); assert.equal(renderer.overflowRefreshRequired, true);
});
