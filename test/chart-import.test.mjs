import test from 'node:test';
import assert from 'node:assert/strict';
import { assignChartImportFiles, chartImportAccept, chartImportFiles, isChartImportFile, readChartImport } from '../src/platform/chart-import.mjs';
import { createChart } from '../src/core/chart.mjs';
import { writeZip } from '../src/platform/archive.mjs';

const encode = value => JSON.stringify(value);
const separate = () => ({
  json: new File([encode(createChart())], 'chart.json', { type: 'application/json' }),
  music: new File(['music'], 'chosen.ogg', { type: 'audio/ogg' }),
  cover: new File(['cover'], 'chosen.png', { type: 'image/png' }),
});

test('两种导入方式只检查当前方式，分文件方式必须三项齐全', () => {
  const selected = separate();
  assert.throws(() => chartImportFiles('pez', selected), /PEZ/);
  assert.throws(() => chartImportFiles('separate', {}), /JSON.*音乐.*封面/);
  for (const kind of ['json', 'music', 'cover']) {
    const incomplete = { ...selected }; delete incomplete[kind];
    assert.throws(() => chartImportFiles('separate', incomplete), /请先选择/);
  }
  assert.deepEqual(chartImportFiles('separate', selected), [selected.json, selected.music, selected.cover]);
  selected.pez = new File(['package'], 'chart.pez');
  assert.deepEqual(chartImportFiles('pez', selected), [selected.pez]);
  assert.equal(chartImportFiles('separate', selected).length, 3);
  assert.throws(() => chartImportFiles('both', selected), /一种打开方式/);
});

test('多选文件按格式分类，与选择顺序和点击的格子无关', () => {
  const files = separate();
  const selected = assignChartImportFiles([files.cover, files.json, files.music]);
  assert.deepEqual(selected, files);
  assert.equal(chartImportFiles('separate', selected).length, 3);
  const partial = assignChartImportFiles([files.cover, files.json]);
  assert.throws(() => chartImportFiles('separate', partial), /音乐/);
  const complete = assignChartImportFiles([files.music], partial);
  assert.deepEqual(complete, files);
  const replacement = new File([], 'replacement.MP3');
  assert.equal(assignChartImportFiles([replacement], complete).music, replacement);
  assert.equal(complete.music, files.music);
});

test('批量选择出现同类冲突或不支持文件时，不会覆盖已有选择', () => {
  const selected = separate(), before = { ...selected };
  assert.throws(() => assignChartImportFiles([new File([], 'new.json'), new File([], 'other.json')], selected), /JSON.*本次选择未应用/);
  assert.throws(() => assignChartImportFiles([new File([], 'new.json'), new File([], 'notes.txt')], selected), /notes.txt.*本次选择未应用/);
  assert.throws(() => assignChartImportFiles([new File([], 'package.pez')], selected), /本次选择未应用/);
  assert.deepEqual(selected, before);
  const mismatchedMime = new File([], 'cover.PNG', { type: 'audio/ogg' });
  assert.equal(assignChartImportFiles([mismatchedMime]).cover, mismatchedMime);
});

test('扩展名大小写与空 MIME 可用，错放格式和重复名称被拒绝', () => {
  assert.equal(isChartImportFile('pez', new File([], 'chart.PEZ')), true);
  assert.equal(isChartImportFile('music', new File([], 'music.MP3')), true);
  assert.equal(isChartImportFile('cover', new File([], 'cover.JPG')), true);
  assert.equal(isChartImportFile('pez', new File([], 'chart.zip', { type: 'application/zip' })), false);
  assert.equal(isChartImportFile('json', new File([], 'chart.pez', { type: 'application/json' })), false);
  assert.equal(isChartImportFile('music', new File([], 'clip.mp4', { type: 'video/mp4' })), false);
  const selected = separate();
  selected.cover = new File([], 'notes.json');
  assert.throws(() => chartImportFiles('separate', selected), /封面/);
  selected.cover = separate().cover;
  selected.music = new File([], 'CHART.JSON', { type: 'audio/ogg' });
  assert.throws(() => chartImportFiles('separate', selected), /名称重复/);
});

test('仅 iOS 的谱面选择取消 accept，Windows、安卓和媒体选择保留筛选提示', () => {
  for (const device of [
    { userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 },
    { userAgent: 'iPad', platform: 'iPad', maxTouchPoints: 5 },
    { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 },
  ]) {
    assert.equal(chartImportAccept('pez', device), ''); assert.equal(chartImportAccept('json', device), '');
    assert.equal(chartImportAccept('separate', device), '');
    assert.equal(chartImportAccept('music', device), 'audio/*'); assert.equal(chartImportAccept('cover', device), 'image/*');
  }
  for (const device of [
    { userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 10 },
    { userAgent: 'Android', platform: 'Linux armv8l', maxTouchPoints: 5 },
    { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 }, {},
  ]) {
    assert.equal(chartImportAccept('pez', device), '.pez'); assert.equal(chartImportAccept('json', device), '.json');
    assert.equal(chartImportAccept('separate', device), '.json,audio/*,image/*');
  }
});

test('分文件导入将明确选择的音乐、封面绑定到谱面并保留完整素材字节', async () => {
  const chart = createChart(); chart.META.song = 'old.ogg'; chart.META.background = 'old.png';
  const selected = separate(); selected.json = new File([encode(chart)], 'chart.json');
  const loaded = await readChartImport('separate', selected);
  assert.equal(loaded.candidates.length, 1);
  assert.equal(loaded.candidates[0].chart.META.song, selected.music.name);
  assert.equal(loaded.candidates[0].chart.META.background, selected.cover.name);
  assert.deepEqual(loaded.assets.get(selected.music.name), new Uint8Array(await selected.music.arrayBuffer()));
  assert.deepEqual(loaded.assets.get(selected.cover.name), new Uint8Array(await selected.cover.arrayBuffer()));
  assert.equal(JSON.parse(await selected.json.text()).META.song, 'old.ogg');
});

test('PEZ 导入保留包内引用，不混入另一种方式已选择的文件', async () => {
  const chart = createChart(); chart.META.song = 'packed.ogg'; chart.META.background = 'packed.png';
  const bytes = writeZip(new Map([['chart.json', new TextEncoder().encode(encode(chart))], ['packed.ogg', new Uint8Array([1, 2])], ['packed.png', new Uint8Array([3, 4])]]));
  const loaded = await readChartImport('pez', { ...separate(), pez: new File([bytes], 'chart.pez') });
  assert.equal(loaded.candidates[0].chart.META.song, 'packed.ogg');
  assert.equal(loaded.candidates[0].chart.META.background, 'packed.png');
  assert.equal(loaded.assets.has('chosen.ogg'), false); assert.equal(loaded.assets.has('chosen.png'), false);
});

test('扩展名通过后仍检查实际 JSON 和 PEZ 内容', async () => {
  await assert.rejects(readChartImport('separate', { ...separate(), json: new File(['broken'], 'chart.json') }));
  await assert.rejects(readChartImport('pez', { pez: new File(['broken'], 'chart.pez') }));
});
