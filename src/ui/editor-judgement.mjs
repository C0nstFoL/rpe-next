import { originalEditorContext } from './editor-skin-canvas.mjs';

export function drawEditorJudgement(context, segments, color = '#ffffff', width = 2) {
  context = originalEditorContext(context);
  context.save(); context.globalAlpha = 1; context.globalCompositeOperation = 'source-over';
  context.strokeStyle = color; context.lineWidth = width; context.setLineDash([]); context.beginPath();
  for (const segment of segments) { context.moveTo(segment.left, segment.y); context.lineTo(segment.right, segment.y); }
  context.stroke(); context.restore();
}
