import test from 'node:test';
import assert from 'node:assert/strict';
import { createChart, createEvent, EVENT_TYPES, EXTENDED_TYPES } from '../src/core/chart.mjs';
import { createChartExport } from '../src/platform/files.mjs';
import { readZip } from '../src/platform/archive.mjs';
import { DEFAULT_BEZIER_EXPORT_MARGIN, bezierExportMargin, clampExportBezierEvent } from '../src/core/bezier-compat.mjs';

test('Bezier导出微钳制只调整危险X控制点，保留Y超调、标志、数值及普通曲线', () => {
  const event = { ...createEvent(-20, 80, 1, 4), bezier: 1, bezierPoints: [0, -2, 0, 3], anchor: { x: 20, y: 30 } };
  assert.deepEqual(clampExportBezierEvent(event).bezierPoints, [0.05, -2, 0.05, 3]);
  assert.deepEqual(clampExportBezierEvent({ ...event, bezierPoints: [1, -2, 1, 3] }).bezierPoints, [0.95, -2, 0.95, 3]);
  assert.deepEqual(clampExportBezierEvent({ ...event, bezierPoints: [1, -2, 0, 3] }).bezierPoints, [0.95, -2, 0.05, 3]);
  const regular = { ...event, bezierPoints: [0, 0, 1, 1] }; assert.equal(clampExportBezierEvent(regular), regular);
  assert.equal(clampExportBezierEvent({ ...event, bezier: 0 }).bezier, 0); assert.deepEqual(event.bezierPoints, [0, -2, 0, 3]);
  const output = clampExportBezierEvent(event); assert.equal(output.bezier, 1); assert.equal(output.start, -20); assert.equal(output.end, 80); assert.equal(output.anchor, event.anchor);
});

test('兼容距离可调并校验范围，不接受不能生效的数值', () => {
  assert.equal(DEFAULT_BEZIER_EXPORT_MARGIN, 0.05); assert.equal(bezierExportMargin(), 0.05); assert.equal(bezierExportMargin(0.01), 0.01);
  for (const value of [0, -1, NaN, Infinity, 0.0001, 0.5, '0.05']) assert.throws(() => bezierExportMargin(value));
  const event = { ...createEvent(), bezier: 1, bezierPoints: [0, 0, 0, 1] }; assert.deepEqual(clampExportBezierEvent(event, 0.01).bezierPoints, [0.01, 0, 0.01, 1]);
});

test('RPE JSON与PEZ在勾选时处理全部事件及参数轨道，未勾选或Next格式均保留原始控制点', async () => {
  const chart = createChart(), layer = chart.judgeLineList[0].eventLayers[0], extended = chart.judgeLineList[0].extended;
  const event = (type = '') => ({ ...createEvent(type === 'colorEvents' ? [0, 0, 0] : type === 'textEvents' ? 'A' : 0, type === 'colorEvents' ? [255, 255, 255] : type === 'textEvents' ? 'B' : 100, 0, 4), bezier: 1, bezierPoints: [0, 0, 0, 1] });
  for (const type of EVENT_TYPES) layer[type] = [event(type)];
  for (const type of EXTENDED_TYPES.filter(type => type !== 'paintEvents')) extended[type] = [event(type)];
  chart.effects = [{ shader: 'glitch', start: [0, 0, 1], end: [4, 0, 1], vars: { strength: [event()] } }];
  const original = structuredClone(chart);
  for (const compatibility of ['next', 'rpe']) for (const format of ['json', 'pez']) for (const clampBezier of [undefined, false, true]) {
    const result = createChartExport(chart, new Map(), 'chart.json', { compatibility, format, clampBezier });
    const entries = format === 'pez' ? await readZip(await result.blob.arrayBuffer()) : null;
    const output = JSON.parse(entries ? new TextDecoder().decode(entries.get('chart.json')) : await result.blob.text());
    const points = compatibility === 'rpe' && clampBezier ? [0.05, 0, 0.05, 1] : [0, 0, 0, 1];
    for (const type of EVENT_TYPES) assert.deepEqual(output.judgeLineList[0].eventLayers[0][type][0].bezierPoints, points);
    for (const type of EXTENDED_TYPES.filter(type => type !== 'paintEvents')) assert.deepEqual(output.judgeLineList[0].extended[type][0].bezierPoints, points);
    assert.deepEqual(output.effects[0].vars.strength[0].bezierPoints, points);
    if (entries) assert.deepEqual(JSON.parse(new TextDecoder().decode(entries.get('extra.json'))).effects[0].vars.strength[0].bezierPoints, points);
    assert.deepEqual(chart, original);
  }
  assert.throws(() => createChartExport(chart, new Map(), 'chart.json', { compatibility: 'rpe', clampBezier: true, bezierMargin: 0 }), /保护距离/);
});
