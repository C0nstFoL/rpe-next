import test from 'node:test';
import assert from 'node:assert/strict';
import { assignChartImportFiles, chartImportAccept, chartImportFiles, isChartImportFile, readChartImport } from '../src/platform/chart-import.mjs';
import { createChart } from '../src/core/chart.mjs';
import { writeZip } from '../src/platform/archive.mjs';
import { resourceReferences, assetBytes } from '../src/platform/files.mjs';

const encode = value => JSON.stringify(value);
const separate = () => ({
  json: new File([encode(createChart())], 'chart.json', { type: 'application/json' }),
  music: new File(['music'], 'chosen.ogg', { type: 'audio/ogg' }),
  cover: new File(['cover'], 'chosen.png', { type: 'image/png' }),
});

test('两种导入方式只检查当前方式，分文件只要求谱面，音乐和封面可稍后补充', () => {
  const selected = separate();
  assert.throws(() => chartImportFiles('pez', selected), /PEZ/);
  assert.throws(() => chartImportFiles('separate', {}), /JSON.*PEC/);
  assert.throws(() => chartImportFiles('separate', { music: selected.music, cover: selected.cover }), /请先选择/);
  for (const kind of ['music', 'cover']) {
    const incomplete = { ...selected }; delete incomplete[kind];
    assert.equal(chartImportFiles('separate', incomplete).length, 2);
  }
  assert.deepEqual(chartImportFiles('separate', { json: selected.json }), [selected.json]);
  assert.deepEqual(chartImportFiles('separate', selected), [selected.json, selected.music, selected.cover]);
  selected.pez = new File(['package'], 'chart.pez');
  assert.deepEqual(chartImportFiles('pez', selected), [selected.pez]);
  assert.equal(chartImportFiles('separate', selected).length, 3);
  assert.throws(() => chartImportFiles('both', selected), /一种打开方式/);
});

test('多选文件按格式分类，与选择顺序和点击的格子无关', () => {
  const files = separate();
  const selected = assignChartImportFiles([files.cover, files.json, files.music]);
  assert.deepEqual(selected, { ...files, additional: [] });
  assert.equal(chartImportFiles('separate', selected).length, 3);
  const partial = assignChartImportFiles([files.cover, files.json]);
  assert.equal(chartImportFiles('separate', partial).length, 2);
  const complete = assignChartImportFiles([files.music], partial);
  assert.deepEqual(complete, { ...files, additional: [] });
  const replacement = new File([], 'replacement.MP3');
  assert.equal(assignChartImportFiles([replacement], complete, 'music').music, replacement);
  assert.equal(complete.music, files.music);
});

test('批量选择名称冲突或混入谱面包时，不会覆盖已有选择', () => {
  const selected = separate(), before = { ...selected };
  assert.throws(() => assignChartImportFiles([new File([], 'new.json'), new File([], 'NEW.JSON')], selected), /名称重复/);
  assert.throws(() => assignChartImportFiles([new File([], 'package.pez')], selected), /本次选择未应用/);
  assert.deepEqual(selected, before);
  const mismatchedMime = new File([], 'cover.PNG', { type: 'audio/ogg' });
  assert.equal(assignChartImportFiles([mismatchedMime]).cover, mismatchedMime);
});

test('扩展名大小写与空 MIME 可用，错放格式和重复名称被拒绝', () => {
  assert.equal(isChartImportFile('pez', new File([], 'chart.PEZ')), true);
  assert.equal(isChartImportFile('music', new File([], 'music.MP3')), true);
  assert.equal(isChartImportFile('cover', new File([], 'cover.JPG')), true);
  assert.equal(isChartImportFile('pez', new File([], 'chart.ZIP', { type: 'application/zip' })), true);
  assert.equal(isChartImportFile('json', new File([], 'chart.PEC')), true);
  assert.equal(isChartImportFile('json', new File([], 'chart.pez', { type: 'application/json' })), false);
  assert.equal(isChartImportFile('music', new File([], 'clip.mp4', { type: 'video/mp4' })), false);
  const selected = separate();
  selected.cover = new File([], 'notes.json');
  assert.throws(() => chartImportFiles('separate', selected), /封面/);
  selected.cover = separate().cover;
  selected.music = new File([], 'CHART.JSON', { type: 'audio/ogg' });
  assert.throws(() => chartImportFiles('separate', selected), /名称重复/);
});

test('谱面包允许 PEZ/ZIP，散文件不限制附加素材类型，保留 iOS 谱面选择兼容', () => {
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
    assert.equal(chartImportAccept('pez', device), '.pez,.zip'); assert.equal(chartImportAccept('json', device), '.json,.pec');
    assert.equal(chartImportAccept('separate', device), '');
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

test('PEZ 和 ZIP 导入保留包内引用，不混入另一种方式已选择的文件', async () => {
  const chart = createChart(); chart.META.song = 'packed.ogg'; chart.META.background = 'packed.png';
  const bytes = writeZip(new Map([['chart.json', new TextEncoder().encode(encode(chart))], ['packed.ogg', new Uint8Array([1, 2])], ['packed.png', new Uint8Array([3, 4])]]));
  for (const extension of ['pez', 'ZIP']) {
    const loaded = await readChartImport('pez', { ...separate(), additional: [new File([], 'unrelated.glsl')], pez: new File([bytes], 'chart.' + extension) });
    assert.equal(loaded.candidates[0].chart.META.song, 'packed.ogg');
    assert.equal(loaded.candidates[0].chart.META.background, 'packed.png');
    for (const name of ['chosen.ogg', 'chosen.png', 'unrelated.glsl']) assert.equal(loaded.assets.has(name), false);
  }
});

test('JSON 单文件和 JSON 加音乐都可打开，不覆盖未提供的媒体引用', async () => {
  const chart = createChart(); chart.META.song = 'later.ogg'; chart.META.background = 'later.png';
  const json = new File([encode(chart)], 'chart.json');
  for (const music of [undefined, separate().music]) {
    const selected = { json, ...(music ? { music } : {}) };
    const loaded = await readChartImport('separate', selected);
    assert.equal(loaded.candidates[0].chart.META.song, music?.name ?? 'later.ogg');
    assert.equal(loaded.candidates[0].chart.META.background, 'later.png');
    assert.equal(loaded.assets.size, music ? 2 : 1);
  }
});

test('PEC 可从分文件入口单独打开，也可和音乐一起自动分类', async () => {
  const pec = new File(['0\nbp 0 120\nn1 0 1 1024 1 0'], 'chart.PEC');
  for (const files of [[pec], [pec, separate().music]]) {
    const selected = assignChartImportFiles(files);
    assert.equal(selected.json, pec);
    const loaded = await readChartImport('separate', selected);
    assert.equal(loaded.candidates[0].chart.rpeNextLegacySource.format, 'pec');
    assert.equal(loaded.candidates[0].chart.judgeLineList[0].notes.length, 1);
  }
});

test('批量完整导入保留 extra.json、判定线贴图、着色器和多音频，按原引用匹配封面音乐', async () => {
  const chart = createChart(); chart.META.song = 'main.ogg'; chart.META.background = 'cover.png'; chart.judgeLineList[0].Texture = 'line.png';
  const effects = [{ shader: 'scan.glsl', start: [0, 0, 1], end: [8, 0, 1] }];
  const files = [
    new File([encode({ effects })], 'extra.json'),
    new File(['line texture'], 'line.png', { type: 'image/png' }),
    new File(['void main() {}'], 'scan.glsl'),
    new File([encode(chart)], 'chart.json'),
    new File(['cover'], 'cover.png', { type: 'image/png' }),
    new File(['music'], 'main.ogg', { type: 'audio/ogg' }),
    new File(['other music'], 'other.ogg', { type: 'audio/ogg' }),
    new File(['Chart: chart.json\nSong: main.ogg\nPicture: cover.png'], 'info.txt'),
  ];
  const selected = assignChartImportFiles(files);
  assert.equal(selected.json.name, 'chart.json');
  assert.equal(selected.cover, undefined); assert.equal(selected.music, undefined);
  const loaded = await readChartImport('separate', selected);
  assert.equal(loaded.candidates.length, 1);
  const candidate = loaded.candidates[0];
  assert.deepEqual(candidate.chart.effects, effects);
  assert.deepEqual(resourceReferences(candidate.chart, loaded.assets, candidate.name), { song: 'main.ogg', background: 'cover.png' });
  for (const file of files) assert.deepEqual(assetBytes(loaded.assets, file.name), new Uint8Array(await file.arrayBuffer()));
});

test('后续补充贴图和 JSON 素材保留已选谱面和封面，明确选择封面时才替换', async () => {
  const initial = assignChartImportFiles(Object.values(separate()));
  const texture = new File(['texture'], 'line.png');
  const config = new File(['{"enabled":true}'], 'config.json');
  const next = assignChartImportFiles([texture, config], initial);
  assert.equal(next.json, initial.json); assert.equal(next.cover, initial.cover);
  const loaded = await readChartImport('separate', next);
  assert.equal(loaded.candidates.length, 1);
  assert.ok(loaded.assets.has('config.json')); assert.ok(loaded.assets.has('line.png'));
  const replacement = new File(['replacement'], 'new-cover.png');
  const replaced = assignChartImportFiles([replacement], next, 'cover');
  assert.equal(replaced.cover, replacement);
  assert.equal(chartImportFiles('separate', replaced).includes(initial.cover), false);
  assert.equal(next.cover, initial.cover);
});

test('多个谱面都保留为候选，副谱面不会作为错误的媒体文件被拒绝', async () => {
  const first = new File([encode(createChart())], 'one.json');
  const second = new File([encode(createChart())], 'two.json');
  const selected = assignChartImportFiles([first, second]);
  const loaded = await readChartImport('separate', selected);
  assert.deepEqual(loaded.candidates.map(candidate => candidate.name), ['one.json', 'two.json']);
});

test('扩展名通过后仍检查实际 JSON、PEC、PEZ 和 ZIP 内容', async () => {
  await assert.rejects(readChartImport('separate', { ...separate(), json: new File(['broken'], 'chart.json') }));
  await assert.rejects(readChartImport('separate', { json: new File(['broken'], 'chart.pec') }));
  for (const extension of ['pez', 'zip']) await assert.rejects(readChartImport('pez', { pez: new File(['broken'], 'chart.' + extension) }));
});
