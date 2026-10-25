import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAgentAudio, quantizeAgentPeaks } from '../src/core/agent-audio.mjs';
import { agentTapNotes } from '../src/core/agent-chart.mjs';
import { createChart, createNote } from '../src/core/chart.mjs';

function audio(samples, rate = 12000) {
  const channels = Array.isArray(samples) ? samples : [samples];
  return { sampleRate: rate, length: channels[0].length, duration: channels[0].length / rate, numberOfChannels: channels.length, getChannelData: index => channels[index] };
}
function attacks(times, duration = 4, amplitudes = []) {
  const rate = 12000, data = new Float32Array(duration * rate);
  for (const [note, seconds] of times.entries()) for (let index = 0; index < 360; index++) data[Math.round(seconds * rate) + index] += (amplitudes[note] ?? .8) * Math.sin(2 * Math.PI * 2200 * index / rate) * Math.exp(-index / 70);
  return data;
}
function matches(peaks, times, tolerance = .025) { return times.filter(seconds => peaks.some(peak => Math.abs(peak.seconds - seconds) <= tolerance)).length; }

test('频谱采音精确识别弱音与密集起音，不因左右反相抵消', async () => {
  const times = [.5, 1, 1.125, 1.25, 2, 2.5, 3], samples = attacks(times, 4, [1, .2, .15, .2, .05, .8, .1]);
  const mono = await analyzeAgentAudio(audio(samples), { startSeconds: .2, endSeconds: 3.5, minGap: .07 });
  const stereo = await analyzeAgentAudio(audio([samples, Float32Array.from(samples, value => -value)]), { startSeconds: .2, endSeconds: 3.5, minGap: .07 });
  assert.equal(matches(mono.peaks, times), times.length, JSON.stringify(mono.peaks));
  assert.equal(matches(stereo.peaks, times), times.length); assert.ok(stereo.peaks.length <= times.length + 1);
  assert.ok(mono.peaks.every(peak => peak.confidence >= .12 && ['low', 'high', 'mixed'].includes(peak.band)));
});

test('等响度的旋律换音不依赖整体音量上升，持续单音不连续误报', async () => {
  const rate = 12000, data = new Float32Array(rate * 4), constant = new Float32Array(rate * 4), changes = [1, 1.5, 2, 2.5, 3];
  let phase = 0;
  for (let index = 0; index < data.length; index++) {
    const seconds = index / rate, frequency = [330, 440, 660, 440, 550, 330][Math.max(0, changes.filter(time => seconds >= time).length)];
    phase += 2 * Math.PI * frequency / rate; data[index] = .5 * Math.sin(phase); constant[index] = .5 * Math.sin(2 * Math.PI * 440 * seconds);
  }
  const melody = await analyzeAgentAudio(audio(data), { startSeconds: .5, endSeconds: 3.5, focus: 'melody' });
  const held = await analyzeAgentAudio(audio(constant), { startSeconds: .5, endSeconds: 3.5 });
  assert.ok(matches(melody.peaks, changes, .05) >= 4, JSON.stringify(melody.peaks));
  assert.ok(held.peaks.length <= 1, JSON.stringify(held.peaks));
});

test('边界起音被保留，静音不产生拍点且取消会中止分析', async () => {
  const data = attacks([1, 2, 3]); const result = await analyzeAgentAudio(audio(data), { startSeconds: 1, endSeconds: 3 });
  assert.equal(matches(result.peaks, [1, 2]), 2, JSON.stringify(result.peaks)); assert.ok(result.peaks.every(peak => peak.seconds < 3));
  const silent = await analyzeAgentAudio(audio(new Float32Array(24000)), { startSeconds: 0, endSeconds: 2 }); assert.equal(silent.peaks.length, 0); assert.equal(silent.estimatedBpms.length, 0);
  const controller = new AbortController(); const pending = analyzeAgentAudio(audio(data), { startSeconds: .1, endSeconds: 3.5, signal: controller.signal }); controller.abort(); await assert.rejects(pending, /停止/);
});

test('自适应量化只吸附靠近网格的起音，严格/不量化模式独立且同槽保留强候选', () => {
  const peaks = [{ beat: 1.01, strength: .5 }, { beat: 1.09, strength: .7 }, { beat: 1.24, strength: .9 }, { beat: 1.255, strength: .1 }];
  const options = { division: 4, start: 1, end: 2 };
  assert.deepEqual(quantizeAgentPeaks(peaks, options).map(peak => peak.beat), [1, 1.09, 1.25]);
  assert.deepEqual(quantizeAgentPeaks(peaks, { ...options, mode: 'nearest' }).map(peak => peak.beat), [1, 1.25]);
  assert.equal(quantizeAgentPeaks(peaks, { ...options, mode: 'none' }).length, 4);
  assert.equal(quantizeAgentPeaks(peaks, options).at(-1).strength, .9);
});

test('采音不在同位置Hold身体和端点中生成Tap，假音符不阻止真实采音', () => {
  const chart = createChart(); chart.judgeLineList[0].notes = [createNote(2, 1, 0, 3), { ...createNote(1, 4, 0), isFake: 1 }];
  const result = agentTapNotes(chart, 0, [.5, 1, 2, 3, 4]); assert.equal(result.count, 2); assert.equal(result.chart.judgeLineList[0].notes.length, 4);
});

test('持续伴奏和噪声背景下仍能找到弱起音，不把底噪每帧都当成音符', async () => {
  const times = [.5, 1, 1.5, 2, 2.5, 3], data = attacks(times, 4, [.5, .2, .3, .15, .4, .2]), rate = 12000;
  let state = 1;
  for (let index = 0; index < data.length; index++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; data[index] += .04 * Math.sin(2 * Math.PI * 110 * index / rate) + ((state / 0xffffffff) * 2 - 1) * .004; }
  const result = await analyzeAgentAudio(audio(data), { startSeconds: .2, endSeconds: 3.5, focus: 'percussion' });
  assert.ok(matches(result.peaks, times) >= 5, JSON.stringify(result.peaks)); assert.ok(result.peaks.length <= times.length + 3, JSON.stringify(result.peaks));
});
