import test from 'node:test';
import assert from 'node:assert/strict';
import { mixAudioSources } from '../src/platform/audio-mix.mjs';

function buffer(channels, length, sampleRate) { const samples = Array.from({ length: channels }, () => new Float32Array(length)); return { sampleRate, length, duration: length / sampleRate, numberOfChannels: channels, getChannelData: index => samples[index] }; }

test('混音沿用原音乐采样率与长度，正确重采样、单声道扩展、补零和截断', async () => {
  const original = buffer(2, 8, 8), first = buffer(1, 4, 4), second = buffer(2, 4, 8); first.getChannelData(0).set([0, .2, .4, .6]); second.getChannelData(0).fill(.1); second.getChannelData(1).fill(.2);
  const result = await mixAudioSources([{ buffer: first }, { buffer: second }], original, { createBuffer: buffer });
  assert.equal(result.buffer.length, 8); assert.equal(result.buffer.sampleRate, 8); assert.equal(result.buffer.numberOfChannels, 2);
  const left = result.buffer.getChannelData(0), right = result.buffer.getChannelData(1); assert.ok(Math.abs(left[1] - .2) < 1e-6); assert.ok(Math.abs(right[1] - .3) < 1e-6); assert.ok(Math.abs(left[6] - .6) < 1e-6); assert.ok(Math.abs(right[6] - .6) < 1e-6);
});

test('只在叠加超过峰值上限时统一降增益，保留声道相位，不逐采样硬削顶', async () => {
  const original = buffer(1, 4, 4), first = buffer(1, 4, 4), second = buffer(1, 4, 4); first.getChannelData(0).set([.9, .45, -.9, 0]); second.getChannelData(0).set([.9, .45, -.9, 0]);
  const result = await mixAudioSources([{ buffer: first }, { buffer: second }], original, { createBuffer: buffer }); assert.deepEqual([...result.buffer.getChannelData(0)], [1, .5, -1, 0]); assert.ok(Math.abs(result.gain - 1 / 1.8) < 1e-6);
  const controller = new AbortController(); controller.abort(); await assert.rejects(mixAudioSources([{ buffer: first }], original, { createBuffer: buffer }, controller.signal), { name: 'AbortError' });
});
