import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { AssetMetadataReader, formatAssetDuration } from '../src/platform/asset-metadata.mjs';

test('素材时长保留两位小数并正确跨分、跨时进位，非法时长不显示', () => {
  for (const [seconds, expected] of [[0, '0:00.00'], [2, '0:02.00'], [65.125, '1:05.13'], [59.999, '1:00.00'], [3599.999, '1:00:00.00'], [3601.01, '1:00:01.01']]) assert.equal(formatAssetDuration(seconds), expected);
  for (const seconds of [-1, NaN, Infinity, undefined, '2']) assert.equal(formatAssetDuration(seconds), '');
});

test('素材元信息按字节身份缓存并合并重复请求，替换素材重新读取', async () => {
  const calls = [], reader = new AssetMetadataReader({ probe: async (bytes, name) => { calls.push(name); return { kind: 'image', width: bytes[0], height: 180 }; } });
  const original = new Uint8Array([32]), replacement = new Uint8Array([64]);
  const first = reader.read(original, 'image.png'), duplicate = reader.read(original, 'renamed.png');
  assert.equal(first, duplicate); assert.deepEqual(await first, { kind: 'image', width: 32, height: 180 });
  assert.deepEqual(await reader.read(original, 'renamed.png'), await duplicate); assert.equal(calls.length, 1);
  assert.deepEqual(await reader.read(replacement, 'image.png'), { kind: 'image', width: 64, height: 180 }); assert.equal(calls.length, 2);
});

test('素材元信息读取限制并发，不会同时解码整套素材', async () => {
  const pending = [], calls = [], reader = new AssetMetadataReader({ concurrency: 2, probe: (bytes, name) => { calls.push(name); return new Promise(resolve => pending.push(resolve)); } });
  const requests = Array.from({ length: 5 }, (unused, index) => reader.read(new Uint8Array([index]), index + '.wav'));
  await nextTurn(); assert.equal(calls.length, 2);
  pending.shift()({ kind: 'audio', duration: 1 }); await nextTurn(); assert.equal(calls.length, 3);
  pending.shift()(null); await nextTurn(); assert.equal(calls.length, 4);
  pending.shift()(null); await nextTurn(); assert.equal(calls.length, 5);
  for (const resolve of pending) resolve(null);
  assert.equal((await Promise.all(requests))[0].duration, 1);
});

test('关闭或重绘素材库会取消队列并释放在途读取，之后可重新读取同一素材', async () => {
  let calls = 0, canceled = 0;
  const reader = new AssetMetadataReader({ concurrency: 1, probe: (bytes, name, signal) => {
    calls++;
    if (calls > 1) return { kind: 'audio', duration: 2 };
    return new Promise(resolve => signal.addEventListener('abort', () => { canceled++; resolve(null); }, { once: true }));
  } });
  const original = new Uint8Array([1]), queued = new Uint8Array([2]), first = reader.read(original, 'first.wav'), second = reader.read(queued, 'second.wav');
  await nextTurn(); assert.equal(calls, 1); reader.cancel();
  assert.deepEqual(await Promise.all([first, second]), [null, null]); assert.equal(canceled, 1);
  assert.deepEqual(await reader.read(original, 'first.wav'), { kind: 'audio', duration: 2 }); assert.equal(calls, 2);
  assert.deepEqual(await reader.read(queued, 'second.wav'), { kind: 'audio', duration: 2 }); assert.equal(calls, 3);
});

test('损坏素材读取失败会显示空结果且不反复读取，不影响后续队列', async () => {
  let calls = 0; const reader = new AssetMetadataReader({ probe: async bytes => { calls++; if (!bytes[0]) throw Error('Invalid media'); return { kind: 'image', width: 320, height: 180 }; } });
  const broken = new Uint8Array([0]); assert.equal(await reader.read(broken, 'broken.png'), null); assert.equal(await reader.read(broken, 'broken.png'), null); assert.equal(calls, 1);
  assert.deepEqual(await reader.read(new Uint8Array([1]), 'valid.png'), { kind: 'image', width: 320, height: 180 });
});
