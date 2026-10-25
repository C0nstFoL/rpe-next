import test from 'node:test';
import assert from 'node:assert/strict';
import { bezier } from '../src/core/easing.mjs';
import { EventTrack } from '../src/core/events.mjs';
import { createEvent } from '../src/core/chart.mjs';
import { TempoMap } from '../src/core/tempo.mjs';

test('Bezier极限控制点首尾严格为0和1，紧邻端点不抽动且保持对称', () => {
  for (const points of [[0, 0, 0, 1], [1, 0, 1, 1], [1, 0, 1, 0], [0, 1, 0, 0], [1, 1, 0, 0], [0.2, -4, 0.8, 6]]) {
    assert.equal(bezier(0, points), 0); assert.equal(bezier(1, points), 1);
    assert.equal(bezier(-0.01, points), 0); assert.equal(bezier(1.01, points), 1);
    const reversed = [1 - points[2], 1 - points[3], 1 - points[0], 1 - points[1]];
    for (const progress of [1e-12, 0.00001, 0.01, 0.25, 0.5, 0.8, 0.99999, 1 - 1e-12]) {
      assert.ok(Number.isFinite(bezier(progress, points)));
      assert.ok(Math.abs(bezier(progress, points) + bezier(1 - progress, reversed) - 1) < 1e-7);
    }
  }
});

test('双X为0或1时符合解析解，事件尾值与后续事件首值连续', () => {
  const component = (parameter, first, second) => 3 * parameter * (1 - parameter) ** 2 * first + 3 * parameter ** 2 * (1 - parameter) * second + parameter ** 3;
  for (const progress of [1e-15, 1e-10, 0.01, 0.5, 0.99, 1 - 1e-10, 1 - 1e-15]) {
    assert.ok(Math.abs(bezier(progress, [0, 0, 0, 1]) - component(Math.cbrt(progress), 0, 1)) < 1e-12);
    assert.ok(Math.abs(bezier(progress, [1, 0, 1, 0]) - (1 - Math.cbrt(1 - progress)) ** 3) < 1e-12);
  }
  const first = { ...createEvent(100, 200, 0, 2), bezier: 1, bezierPoints: [1, 0, 1, 0] }, tempo = new TempoMap([{ bpm: 120, startTime: [0, 0, 1] }]);
  assert.equal(new EventTrack([first], tempo).value(1), 200);
  assert.equal(new EventTrack([first, createEvent(200, 300, 2, 4)], tempo).value(1), 200);
});
