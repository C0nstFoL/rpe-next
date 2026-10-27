import { beatValue, fromNumber } from './beat.mjs';

export function verticalGrid(count = 11) {
  const spacing = 1350 / (count - 1);
  const half = (Math.floor(count + 0.01) - 1) / 2;
  return { spacing, first: -half, last: half };
}

export function snapPosition(value, count, enabled = true) {
  if (!enabled) return value;
  const { spacing, first } = verticalGrid(count);
  return (Math.round(value / spacing - first) + first) * spacing;
}

export function snapTime(seconds, division, tempo, factor = 1) {
  const beat = Math.max(0, tempo.beat(seconds, factor));
  const lower = Math.floor(beat * division) / division;
  const upper = lower + 1 / division;
  return fromNumber(Math.abs(tempo.seconds(lower, factor) - seconds) <= Math.abs(tempo.seconds(upper, factor) - seconds) ? lower : upper);
}

export function placementRange(first, second) {
  const start = Math.min(beatValue(first), beatValue(second));
  const end = Math.max(beatValue(first), beatValue(second));
  return end - start < 0.001 ? null : { start, end };
}

export function wheelSeconds(delta, duration, speed, rate, accelerated = false, burstSeconds = 0, alt = false, deltaMode = 0) {
  if (!Number.isFinite(delta)) return 0;
  // Canvas timelines have no native line/page scroll size; use 16px/line and 800px/page.
  // Keep 100px equivalent to the previous wheel step, including fractional inertia tails.
  const pixels = delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1);
  // Pixel events already carry OS acceleration/inertia. Extra burst acceleration distorts it.
  const acceleration = accelerated && deltaMode !== 0 ? 1 + 4 * (Math.min(4, Math.max(0, burstSeconds)) / 4) ** 3 : 1;
  return -pixels / 100 * 120 / 1000000 * speed * rate * (alt ? 500 : 100) * acceleration;
}
