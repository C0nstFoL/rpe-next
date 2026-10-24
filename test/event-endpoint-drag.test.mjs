import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline } from '../src/ui/timeline.mjs';
import { EditorSession } from '../src/application/session.mjs';
import { createChart, createLine, createEvent } from '../src/core/chart.mjs';
import { TempoMap } from '../src/core/tempo.mjs';
import { beatValue } from '../src/core/beat.mjs';
import { dragEventEndpoint } from '../src/core/event-drag.mjs';
import { selectEvent } from '../src/application/event-commands.mjs';
import { DEFAULT_HOTKEYS, shortcutAction, shortcutReleased } from '../src/core/preferences.mjs';
import { normalizeEditorPreferences } from '../src/platform/editor-preferences.mjs';
import { DEFAULT_EDITOR_PREFERENCES } from '../src/core/default-settings.mjs';

function fixture(multi = false) {
  const chart = createChart(); chart.judgeLineList = [createLine(), createLine()];
  chart.judgeLineList[1].bpmfactor = 2;
  for (const line of chart.judgeLineList) line.eventLayers[0].moveXEvents = [createEvent(10, 30, 1, 4)];
  const session = new EditorSession(chart); session.focus = 'events'; if (multi) { session.setMultiLineEnabled(true, 'events'); session.multiLineIndices = [0, 1]; }
  const canvas = () => ({ clientWidth: 600, clientHeight: 600, style: {}, addEventListener() {}, focus() {}, setPointerCapture() {}, releasePointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }) });
  const timeline = new Timeline(canvas(), canvas(), () => session, () => {}, () => {}, assert.fail); timeline.scale = 90; timeline.rpeEventDrag = true;
  selectEvent(session, multi ? 1 : 0, 'moveXEvents', 0, { replace: true });
  const lineIndex = multi ? 1 : 0, vertical = beat => timeline.verticalForLine(beat, lineIndex);
  timeline.eventRects = [{ type: 'moveXEvents', index: 0, lineIndex, x: 20, width: 60, y: vertical(4), height: vertical(1) - vertical(4) }];
  const pointer = (beat, button = 0, x = 550) => ({ clientX: x, clientY: vertical(beat), button, pointerId: 1, preventDefault() {} });
  return { session, timeline, interaction: timeline.eventInteraction, pointer, event: () => session.chart.judgeLineList[lineIndex].eventLayers[0].moveXEvents[0] };
}

test('开启新设置后事件边缘和身体一致；关闭时恢复旧式首尾命中与拖拽', () => {
  const { timeline, interaction, pointer, event } = fixture();
  assert.equal(timeline.rpeEventDrag, true); interaction.move(pointer(4, 0, 50)); assert.equal(timeline.eventsCanvas.style.cursor, 'move');
  interaction.down(pointer(4, 0, 50)); assert.equal(interaction.drag.kind, 'move'); interaction.up(pointer(4, 0, 50));
  timeline.rpeEventDrag = false; interaction.move(pointer(4, 0, 50)); assert.equal(timeline.eventsCanvas.style.cursor, 'ns-resize');
  interaction.down(pointer(4, 0, 50)); assert.equal(interaction.drag.kind, 'endTime'); interaction.move(pointer(5, 0, 50)); interaction.up(pointer(5, 0, 50));
  assert.equal(beatValue(event().endTime), 5);
});

test('按住快捷键可从空白位置用左键绝对调整起拍，右键绝对调整尾拍；一次撤销且不弹菜单', () => {
  const { session, timeline, interaction, pointer, event } = fixture(), original = event();
  timeline.eventEndpointDragHeld = true;
  interaction.down(pointer(2)); interaction.move(pointer(2.5));
  assert.deepEqual([beatValue(interaction.previewEvent(original).startTime), beatValue(interaction.previewEvent(original).endTime)], [2.5, 4]);
  interaction.up(pointer(2.5)); assert.equal(beatValue(event().startTime), 2.5); assert.equal(event().start, 10); assert.equal(event().end, 30);
  assert.equal(session.history.undoStack.length, 1); session.travel('undo'); assert.equal(event(), original);
  interaction.down(pointer(2, 2)); interaction.move(pointer(5, 2)); interaction.up(pointer(5, 2));
  assert.equal(beatValue(event().endTime), 5); assert.equal(interaction.consumeContextMenu(), true); assert.equal(interaction.consumeContextMenu(), false);
});

test('跨越另一端时交换时间并保留数值，首尾相同使用原分母的五分之一补足时长', () => {
  const event = createEvent(10, 30, 1, 4);
  const crossed = dragEventEndpoint(event, 'startTime', 5); assert.deepEqual([beatValue(crossed.startTime), beatValue(crossed.endTime), crossed.start, crossed.end], [4, 5, 10, 30]);
  assert.deepEqual(dragEventEndpoint(event, 'startTime', 4).endTime, [4, 1, 5]);
  const fraction = createEvent(0, 1, 1.25, 4); assert.ok(Math.abs(beatValue(dragEventEndpoint(fraction, 'endTime', 1.25).endTime) - 1.3) < 1e-10);
  assert.deepEqual(event.startTime, [1, 0, 1]); assert.deepEqual(event.endTime, [4, 0, 1]);
});

test('松开快捷键后冻结已拖动位置，不把随后鼠标位置应用到事件；多选不进入单事件首尾模式', () => {
  const { session, timeline, interaction, pointer, event } = fixture(); timeline.eventEndpointDragHeld = true;
  interaction.down(pointer(2)); interaction.move(pointer(2.5)); timeline.eventEndpointDragHeld = false; interaction.move(pointer(0.5)); interaction.up(pointer(0.5));
  assert.equal(beatValue(event().startTime), 2.5);
  session.eventSelection.add('alphaEvents:0'); timeline.eventEndpointDragHeld = true; assert.equal(interaction.endpointTarget(), null);
});

test('首尾拖出视区后可滚动跟随，松开快捷键后停止自动滚动且预览位置冻结', () => {
  const { timeline, interaction, pointer, event } = fixture(); timeline.eventEndpointDragHeld = true;
  interaction.down(pointer(2)); interaction.move({ ...pointer(2), clientY: -30 });
  const first = beatValue(interaction.previewEvent(event()).endTime); timeline.onDragScroll = () => { timeline.origin += 1; };
  timeline.autoScroll(0.05); assert.ok(beatValue(interaction.previewEvent(event()).endTime) > first);
  timeline.eventEndpointDragHeld = false; const frozen = interaction.previewEvent(event()); const origin = timeline.origin;
  timeline.autoScroll(0.05); assert.equal(timeline.origin, origin); timeline.origin += 1; assert.deepEqual(interaction.previewEvent(event()), frozen);
  timeline.eventRects = []; assert.equal(interaction.previewRectangles([], 600).length, 1);
});

test('多线非当前线按自己的倍率和跨BPM视区取拍，拖动滚屏后保持正确且可撤销', () => {
  const { session, timeline, interaction, pointer, event } = fixture(true);
  const original = event(); timeline.tempo = new TempoMap([{ bpm: 120, startTime: [0, 0, 1] }, { bpm: 240, startTime: [3, 0, 1] }]); timeline.eventEndpointDragHeld = true;
  interaction.down(pointer(2)); interaction.move(pointer(2.5)); interaction.up(pointer(2.5)); assert.equal(beatValue(event().startTime), 2.5);
  assert.equal(session.chart.judgeLineList[0].eventLayers[0].moveXEvents[0].startTime[0], 1); session.travel('undo'); assert.equal(event(), original);
  interaction.down(pointer(2)); interaction.move(pointer(5)); timeline.origin = 1; interaction.drag.scrolled = true; interaction.up(pointer(6)); assert.equal(beatValue(event().startTime), 4); assert.equal(beatValue(event().endTime), 6);
});

test('首尾拖拽默认关闭，快捷键默认Z且可自定义组合键并检测释放，已保存的设置保持不变', () => {
  assert.equal(DEFAULT_HOTKEYS.DragLong, 'Z'); assert.equal(DEFAULT_EDITOR_PREFERENCES.rpeEventDrag, false);
  const { timeline } = fixture(); delete timeline.rpeEventDrag; assert.equal(timeline.eventInteraction.endpointTarget(), null);
  assert.equal(shortcutAction({ key: 'z' }, { hotkeys: DEFAULT_HOTKEYS }, 'events'), 'DragLong');
  assert.equal(shortcutAction({ key: 'l', altKey: true }, { hotkeys: { ...DEFAULT_HOTKEYS, DragLong: 'LEFTALT&L' } }, 'events'), 'DragLong');
  assert.equal(shortcutReleased({ key: 'Alt' }, 'LEFTALT&L'), true); for (const rpeEventDrag of [false, true]) assert.deepEqual(normalizeEditorPreferences({ rpeEventDrag }), { rpeEventDrag });
});
