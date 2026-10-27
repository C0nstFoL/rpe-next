import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createNote, parseChart, assertChart, serializeChart } from '../src/core/chart.mjs';
import { noteColor, parseNoteColor, setNoteHitSound } from '../src/core/note-properties.mjs';
import { normalizeLineGroups, reservedLineGroupName } from '../src/core/line-groups.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { captureSelection } from '../src/application/batch-edit.mjs';
import { previewMultiEdit } from '../src/application/multi-edit.mjs';
import { HitSounds, hitTimeline } from '../src/platform/hitsounds.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { resourceReferences } from '../src/platform/files.mjs';

test('RPE音符颜色、特效颜色使用各自默认值，RGB输入接受空格和逗号但拒绝不合法字节', () => {
  const note = createNote(1, 0, 0);
  assert.deepEqual(noteColor(note, 'tint'), [255, 255, 255]); assert.deepEqual(noteColor(note, 'tintHitEffects'), [255, 236, 160]);
  assert.deepEqual(noteColor({ ...note, color: [12, 34, 56] }, 'tint'), [12, 34, 56]);
  for (const text of ['12 34 56', '12,34,56', '12, 34, 56']) assert.deepEqual(parseNoteColor(text), [12, 34, 56]);
  for (const text of ['', '1,2', '1,2,3,4', '-1,2,3', '256,2,3', '0.5,2,3', 'a,b,c']) assert.throws(() => parseNoteColor(text));
  assert.equal(Object.hasOwn(note, 'tint'), false);
});

test('打击音效写入RPE的hitsound字段，选择默认同时清除旧别名，其他音符属性原样保留', () => {
  const original = { ...createNote(2, 0, 0, 4), hitSound: 'old.wav', judgeArea: 1.25, tint: [10, 20, 30], tintHitEffects: [40, 50, 60] };
  const changed = setNoteHitSound(original, 'audio/new.wav'); assert.equal(changed.hitsound, 'audio/new.wav'); assert.equal(Object.hasOwn(changed, 'hitSound'), false);
  assert.equal(original.hitSound, 'old.wav'); assert.equal(changed.judgeArea, 1.25); assert.deepEqual(changed.tint, original.tint); assert.deepEqual(changed.tintHitEffects, original.tintHitEffects);
  const reset = setNoteHitSound(changed, ''); assert.equal(Object.hasOwn(reset, 'hitsound'), false); assert.equal(Object.hasOwn(reset, 'hitSound'), false);
  const chart = createChart(); chart.judgeLineList[0].notes = [changed]; const restored = parseChart(serializeChart(chart));
  assert.deepEqual(restored.judgeLineList[0].notes[0], changed);
  assert.equal(hitTimeline(restored, new TempoMap(restored.BPMList))[0].sound, 'audio/new.wav');
});

test('已有批量音效工具同样写入RPE字段，避免旧别名覆盖或无法修改已有hitsound', () => {
  const chart = createChart(); chart.judgeLineList[0].notes = [{ ...createNote(1, 0, 0), hitsound: 'original.wav', hitSound: 'ignored.wav' }];
  const session = new EditorSession(chart); session.selection.add(0);
  const result = previewMultiEdit(captureSelection(session), 'notes', { field: 'hitSound', operation: 'To', lower: 'replacement.wav', seed: 1 });
  assert.equal(result.chart.judgeLineList[0].notes[0].hitsound, 'replacement.wav'); assert.equal(Object.hasOwn(result.chart.judgeLineList[0].notes[0], 'hitSound'), false);
});

test('all不能作为组名，已有保留名称安全改名且保持组索引和已有名称', () => {
  const chart = createChart(); chart.judgeLineGroup = ['Default', 'ALL', 'all_group', 'all']; chart.judgeLineList[0].Group = 3;
  assert.equal(reservedLineGroupName(' aLl '), true); assert.equal(reservedLineGroupName('all_group'), false);
  assert.throws(() => assertChart(chart), /all/);
  const normalized = normalizeLineGroups(chart); assert.deepEqual(normalized.judgeLineGroup, ['Default', 'ALL_group_2', 'all_group', 'all_group_3']); assert.equal(normalized.judgeLineList[0].Group, 3);
  assert.deepEqual(chart.judgeLineGroup, ['Default', 'ALL', 'all_group', 'all']);
  assert.deepEqual(parseChart(JSON.stringify(chart)).judgeLineGroup, normalized.judgeLineGroup); assert.deepEqual(new EditorSession(chart).chart.judgeLineGroup, normalized.judgeLineGroup);
});

test('更新音频素材只失效被替换的音效缓冲，不清除打击音量、皮肤或当前线静音设置', () => {
  const original = new Uint8Array([1]), next = new Uint8Array([2]), hit = new HitSounds({});
  hit.assets = new Map([['cue.wav', original]]); hit.chartName = 'chart.json'; hit.buffers.set('tap', 'default'); hit.buffers.set('cue.wav', 'custom'); hit.onlyCurrentLine = true; hit.volume = 0.25;
  hit.setAssets(new Map([['cue.wav', next]])); assert.equal(hit.buffers.has('cue.wav'), false); assert.equal(hit.buffers.get('tap'), 'default'); assert.equal(hit.onlyCurrentLine, true); assert.equal(hit.volume, 0.25);
});

test('导入的音符音效不会在保存重开时被推断为谱面音乐，明确指定的音乐引用仍优先', () => {
  const chart = createChart(); chart.judgeLineList[0].notes = [{ ...createNote(1, 0, 0), hitsound: 'cue.wav' }]; const assets = new Map([['cue.wav', new Uint8Array([1])]]);
  assert.equal(resourceReferences(chart, assets, 'chart.json').song, '');
  chart.judgeLineList[0].notes = [];
  assert.equal(resourceReferences(parseChart(serializeChart(chart)), assets, 'chart.json').song, '');
  assert.ok(assets.has('cue.wav'));
  chart.META.song = 'cue.wav'; assert.equal(resourceReferences(chart, assets, 'chart.json').song, 'cue.wav');
});

test('明确空媒体绑定和缺失的绑定不会被闲置素材代替，旧谱面未记录绑定时仍可推断', () => {
  const chart = createChart(), assets = new Map([['chart.wav', new Uint8Array([1])], ['chart.png', new Uint8Array([2])]]);
  assert.deepEqual(resourceReferences(chart, assets, 'chart.json'), { song: '', background: '' });
  chart.META.song = 'missing.ogg'; chart.META.background = 'missing.jpg';
  assert.deepEqual(resourceReferences(chart, assets, 'chart.json'), { song: 'missing.ogg', background: 'missing.jpg' });
  delete chart.META.song; delete chart.META.background;
  assert.deepEqual(resourceReferences(chart, assets, 'chart.json'), { song: 'chart.wav', background: 'chart.png' });
  assets.set('other.wav', new Uint8Array([3])); assets.set('other.png', new Uint8Array([4]));
  assert.deepEqual(resourceReferences(chart, assets, 'chart.json'), { song: 'chart.wav', background: 'chart.png' });
  assert.deepEqual(resourceReferences(chart, assets, 'unknown.json'), { song: '', background: '' });
  assert.deepEqual(resourceReferences(chart, assets, 'chart.json', { Song: '', Picture: '' }), { song: '', background: '' });
});
