import { checkAgentSignal, agentAbort } from '../core/agent-commands.mjs';

export async function rasterizeTextLines(options, skin, noteSize = 175) {
  if (!options.text.trim()) throw Error('请输入可见文字');
  if (options.text.length > 1000 || ![options.width, options.x, options.y, options.spacing, options.size, options.tolerance].every(Number.isFinite) || options.width < 10 || options.width > 10000 || options.spacing < 0.5 || options.spacing > 4 || options.size < 0.05 || options.size > 4 || options.tolerance < 0 || options.tolerance > 90) throw Error('布局、音符大小或容忍度无效');
  if (!Number.isFinite(options.coverage) || options.coverage < 0 || options.coverage > 100) throw Error('骨架覆盖度下限须为 0–100%');
  if (![4, 1, 3].includes(options.noteType)) throw Error('请选择 Drag、Tap 或 Flick');
  await document.fonts.load(`96px "${options.font}"`, options.text);
  const lines = options.text.split(/\r?\n/); if (lines.length > 16) throw Error('一次最多拟合 16 行文字');
  const measure = document.createElement('canvas').getContext('2d'); measure.font = `96px "${options.font}", sans-serif`;
  const metrics = lines.map(line => measure.measureText(line));
  const naturalWidth = Math.max(1, ...metrics.map(entry => Math.max(entry.width, entry.actualBoundingBoxLeft + entry.actualBoundingBoxRight)));
  const ascent = Math.max(80, ...metrics.map(entry => entry.actualBoundingBoxAscent)), descent = Math.max(20, ...metrics.map(entry => entry.actualBoundingBoxDescent));
  const lineHeight = (ascent + descent) * options.spacing, naturalHeight = ascent + descent + lineHeight * (lines.length - 1);
  const worldHeight = options.width * naturalHeight / naturalWidth, scale = Math.min(384 / options.width, 384 / worldHeight);
  const texture = skin.noteImage?.(options.noteType) ?? skin.images?.get({ 4: 'Drag2', 1: 'Tap2', 3: 'Flick2' }[options.noteType]);
  const length = noteSize * options.size * scale, thickness = Math.max(5, noteSize * (texture ? texture.naturalHeight / texture.naturalWidth : 0.2)) * scale;
  if (thickness < 1 || length < 1) throw Error('笔画相对文字太细，请增大音符大小、减少文字或减小总宽度');
  if (length * thickness > 2048) throw Error('笔画相对文字太大，请减小音符大小或增大文字总宽度');
  const padding = Math.ceil(Math.hypot(length, thickness) / 2) + 2, width = Math.ceil(options.width * scale) + padding * 2, height = Math.ceil(worldHeight * scale) + padding * 2;
  const raster = document.createElement('canvas'); raster.width = width; raster.height = height; const context = raster.getContext('2d');
  const fontScale = options.width / naturalWidth * scale; context.font = `${96 * fontScale}px "${options.font}", sans-serif`; context.fillStyle = '#fff'; context.textBaseline = 'alphabetic';
  lines.forEach((line, index) => context.fillText(line, (width - metrics[index].width * fontScale) / 2, padding + (ascent + index * lineHeight) * fontScale));
  const pixels = context.getImageData(0, 0, width, height).data, mask = Uint8Array.from({ length: width * height }, (unused, index) => pixels[index * 4 + 3] >= 100 ? 1 : 0);
  return { raster, mask, width, height, length, thickness, texture, scale };
}

export async function rasterizeNoisePattern(options, bitmap) {
  const { precision, mode, text, font, spacing } = options;
  if (!Number.isInteger(precision) || precision < 16 || precision > 512) throw Error('精细程度须为 16–512 格');
  const raster = document.createElement('canvas'), context = raster.getContext('2d', { willReadFrequently: true });
  if (mode === 'image') {
    if (!bitmap) throw Error('请先选择本地图片');
    const scale = precision / Math.max(bitmap.width, bitmap.height);
    raster.width = Math.max(1, Math.round(bitmap.width * scale)); raster.height = Math.max(1, Math.round(bitmap.height * scale));
    context.drawImage(bitmap, 0, 0, raster.width, raster.height);
  } else {
    if (!text.trim()) throw Error('请输入可见文字');
    const lines = text.split(/\r?\n/); if (lines.length > 16 || text.length > 1000) throw Error('一次最多拟合 16 行、1000 个字符');
    if (!Number.isFinite(spacing) || spacing < 0.5 || spacing > 4) throw Error('行距须在 0.5–4 之间');
    await document.fonts.load(`96px "${font}"`, text);
    context.font = `96px "${font}", sans-serif`; const metrics = lines.map(line => context.measureText(line));
    const ascent = Math.max(1, ...metrics.map(metric => metric.actualBoundingBoxAscent || 72)), descent = Math.max(1, ...metrics.map(metric => metric.actualBoundingBoxDescent || 18));
    const naturalWidth = Math.max(1, ...metrics.map(metric => Math.max(metric.width, metric.actualBoundingBoxLeft + metric.actualBoundingBoxRight)));
    const lineHeight = (ascent + descent) * spacing, naturalHeight = ascent + descent + lineHeight * (lines.length - 1), scale = (precision - 4) / Math.max(naturalWidth, naturalHeight);
    raster.width = Math.min(512, Math.max(1, Math.ceil(naturalWidth * scale) + 4)); raster.height = Math.min(512, Math.max(1, Math.ceil(naturalHeight * scale) + 4));
    context.font = `${96 * scale}px "${font}", sans-serif`; context.fillStyle = '#fff'; context.textBaseline = 'alphabetic';
    lines.forEach((line, index) => context.fillText(line, (raster.width - metrics[index].width * scale) / 2, 2 + (ascent + index * lineHeight) * scale));
  }
  return { pixels: context.getImageData(0, 0, raster.width, raster.height).data, width: raster.width, height: raster.height };
}

export function runPatternFit(kind, payload, signal) {
  checkAgentSignal(signal);
  if (!['noise', 'text'].includes(kind)) throw Error('未知拟合类型');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(kind === 'noise' ? '../core/noise-fit-worker.mjs' : '../core/text-fit-worker.mjs', import.meta.url), { type: 'module' });
    const finish = (error, result) => { signal?.removeEventListener('abort', abort); worker.terminate(); if (error) reject(error); else resolve(result); };
    const abort = () => finish(agentAbort()); signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(Error('后台拟合失败')); worker.onmessage = ({ data }) => finish(data.error ? Error(data.error) : null, data.result);
    try { worker.postMessage(payload); } catch (error) { finish(error); }
    if (signal?.aborted) abort();
  });
}
