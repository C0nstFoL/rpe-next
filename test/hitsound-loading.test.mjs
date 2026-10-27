import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { HitSounds } from '../src/platform/hitsounds.mjs';
import { EditorPlayback } from '../src/application/playback.mjs';
import { createChart, createNote } from '../src/core/chart.mjs';

function setup() {
  const decoded = [], warnings = [], context = { destination: {}, createGain: () => ({ gain: {}, connect() {} }),
    async decodeAudioData(bytes) { const buffer = { bytes: [...new Uint8Array(bytes)] }; decoded.push(buffer); return buffer; },
  };
  const transport = { playing: false, ensureContext: () => context, pause() { this.playing = false; }, async play() { this.playing = true; } };
  const sounds = new HitSounds(transport, { onWarning: message => warnings.push(message) });
  const chart = createChart(); sounds.setProject(chart, new Map(), 'chart.json');
  return { sounds, transport, context, decoded, warnings, chart };
}

test('默认音效请求失败只产生非阻断提示，音乐正常开始且播放状态不会卡在等待中', async context => {
  context.mock.method(globalThis, 'fetch', async () => { throw TypeError('Failed to fetch'); });
  const { sounds, transport, warnings, chart } = setup(), playback = new EditorPlayback(transport, sounds, () => {});
  await playback.toggle(chart); assert.equal(transport.playing, true); assert.equal(playback.pending, false);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /tap\.ogg/); assert.match(warnings[0], /Failed to fetch/);
  assert.equal(sounds.buffers.size, 0); assert.equal(sounds.defaultPending.size, 0);
});

test('当前音符皮肤提供的音效不再请求默认文件，仍解码谱面自定义音效', async context => {
  const request = context.mock.method(globalThis, 'fetch', async () => { throw TypeError('Unexpected request'); });
  const { sounds, chart, warnings } = setup(); sounds.setSoundPack(new Map(['tap', 'drag', 'flick'].map(kind => [kind, { skin: kind }])));
  chart.judgeLineList[0].notes = [{ ...createNote(1, 0, 0), hitsound: 'cue.wav' }]; sounds.setAssets(new Map([['cue.wav', new Uint8Array([7])]]));
  await sounds.prepare(); assert.equal(request.mock.calls.length, 0); assert.deepEqual(sounds.buffers.get('cue.wav').bytes, [7]); assert.deepEqual(warnings, []);
});

test('应用其他皮肤时仍能单独试听默认音效，试听不替换当前皮肤或谱面音效', async context => {
  const request = context.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1])));
  const { sounds, context: audioContext } = setup(), skinTap = { skin: true }; sounds.setSoundPack(new Map([['tap', skinTap]]));
  const first = await sounds.defaultBuffer('tap', audioContext), second = await sounds.defaultBuffer('tap', audioContext);
  assert.equal(first, second); assert.equal(request.mock.calls.length, 1); assert.equal(sounds.skinBuffers.get('tap'), skinTap); assert.equal(sounds.buffers.size, 0);
});

test('切换谱面和删除项目素材不会清空默认音效缓存，自定义音效缓存不跨谱面串用', async context => {
  const request = context.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1])));
  const { sounds, chart, decoded } = setup(); chart.judgeLineList[0].notes = [{ ...createNote(1, 0, 0), hitsound: 'cue.wav' }]; sounds.setAssets(new Map([['cue.wav', new Uint8Array([7])]]));
  await sounds.prepare(); const defaults = new Map(sounds.defaultBuffers); assert.equal(request.mock.calls.length, 3); assert.equal(decoded.length, 4);
  sounds.setAssets(new Map()); await sounds.prepare(); assert.equal(sounds.buffers.has('cue.wav'), false);
  const next = createChart(); next.judgeLineList[0].notes = [{ ...createNote(1, 0, 0), hitsound: 'cue.wav' }];
  sounds.setProject(next, new Map([['cue.wav', new Uint8Array([9])]]), 'next.json'); await sounds.prepare();
  assert.equal(request.mock.calls.length, 3); assert.equal(decoded.length, 5); assert.deepEqual(sounds.buffers.get('cue.wav').bytes, [9]);
  for (const [kind, buffer] of defaults) assert.equal(sounds.buffers.get(kind), buffer);
});

test('皮肤缺少的音效才请求回退文件；HTTP和解码失败可在下次播放时重试', async context => {
  let attempts = 0; const request = context.mock.method(globalThis, 'fetch', async url => { assert.match(url, /\/flick\.ogg$/); attempts++; return attempts === 1 ? new Response('', { status: 503 }) : new Response(new Uint8Array([1])); });
  const { sounds, warnings } = setup(); sounds.setSoundPack(new Map([['tap', {}], ['drag', {}]]));
  await sounds.prepare(); assert.equal(sounds.buffers.has('flick'), false); assert.match(warnings[0], /HTTP 503/); assert.equal(sounds.defaultBuffers.size, 0);
  await sounds.prepare(); assert.equal(sounds.buffers.has('flick'), true); assert.equal(request.mock.calls.length, 2); assert.equal(warnings.length, 1);
  const other = setup(); other.sounds.setSoundPack(new Map([['tap', {}], ['drag', {}]])); other.context.decodeAudioData = async () => { throw Error('Invalid audio'); };
  await other.sounds.prepare(); assert.match(other.warnings[0], /Invalid audio/); assert.equal(other.sounds.defaultPending.size, 0);
  other.context.decodeAudioData = async () => ({}); await other.sounds.prepare(); assert.equal(other.sounds.buffers.has('flick'), true);
});

test('并行准备和中途切谱复用正在加载的默认音效，迟到的自定义音效不会写进新谱面', async context => {
  const pending = []; const request = context.mock.method(globalThis, 'fetch', () => new Promise(resolve => pending.push(resolve)));
  const { sounds, chart, context: audioContext } = setup(); let finishCustom;
  audioContext.decodeAudioData = async bytes => new Uint8Array(bytes)[0] === 7 ? new Promise(resolve => { finishCustom = resolve; }) : { bytes: [...new Uint8Array(bytes)] };
  chart.judgeLineList[0].notes = [{ ...createNote(1, 0, 0), hitsound: 'cue.wav' }]; sounds.setAssets(new Map([['cue.wav', new Uint8Array([7])]]));
  const first = sounds.prepare(); await nextTurn(); sounds.setProject(createChart(), new Map(), 'next.json'); const second = sounds.prepare();
  assert.equal(request.mock.calls.length, 3);
  for (const resolve of pending) resolve(new Response(new Uint8Array([1]))); finishCustom({ stale: true }); await Promise.all([first, second]);
  assert.equal(sounds.buffers.has('cue.wav'), false); assert.equal(sounds.buffers.size, 3); assert.equal(sounds.defaultPending.size, 0);
});

test('切谱或载入已有音效的皮肤后，不再报告旧项目尚未完成的音效请求错误', async context => {
  const pending = []; context.mock.method(globalThis, 'fetch', () => new Promise((resolve, reject) => pending.push(reject)));
  for (const change of ['project', 'skin']) {
    const { sounds, warnings } = setup(); const first = sounds.prepare();
    if (change === 'project') sounds.setProject(createChart(), new Map(), 'new.json');
    else sounds.setSoundPack(new Map(['tap', 'drag', 'flick'].map(kind => [kind, {}])));
    for (const reject of pending.splice(0)) reject(TypeError('Failed to fetch')); await first; assert.deepEqual(warnings, []);
  }
});
