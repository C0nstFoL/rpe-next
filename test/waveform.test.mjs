import test from 'node:test';
import assert from 'node:assert/strict';
import { WaveformEnvelope } from '../src/core/waveform.mjs';

test('波形区间查询覆盖每个像素时间段内的峰值，处理非二次幂长度及边界', () => {
  const samples = new Float32Array([0.1, 0.8, 0.2, 1, 0.4, 0.7, 0.3]);
  const envelope = new WaveformEnvelope(samples);
  for (let start = -3; start < 10; start += 0.25) for (let end = start + 0.25; end < 11; end += 0.5) {
    const values = samples.slice(Math.max(0, Math.min(samples.length, Math.floor(start))), Math.max(0, Math.min(samples.length, Math.ceil(end))));
    assert.equal(envelope.peak(start, end), Math.max(0, ...values));
  }
  assert.equal(envelope.peak(2, 2), 0); assert.equal(envelope.peak(4, 2), 0);
  assert.equal(new WaveformEnvelope(new Float32Array()).peak(0, 2), 0);
  assert.equal(new WaveformEnvelope(new Float32Array([0.75])).peak(0, 1), 0.75);
});

test('多级峰值保留瞬态，缩小视野不会漏掉像素内的短促峰值', () => {
  const samples = new Float32Array(32768); samples[31] = 1; samples[4096] = 0.75; samples[28000] = 0.9;
  const envelope = new WaveformEnvelope(samples);
  assert.equal(envelope.peak(0, 64), 1);
  assert.equal(envelope.peak(4000, 8000), 0.75);
  assert.equal(envelope.peak(10000, 32768), samples[28000]);
  assert.ok(envelope.levels.reduce((sum, level) => sum + level.length, 0) < samples.length * 2);
});
