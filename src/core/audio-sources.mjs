export const STEM_NAMES = Object.freeze({ original: '原音频', vocals: '人声', drums: '鼓', bass: '贝斯', other: '其他配器', guitar: '吉他', piano: '钢琴' });
export const SEPARATION_MODELS = Object.freeze([
  { id: 'htdemucs', name: '四声部', stems: ['drums', 'bass', 'other', 'vocals'] },
  { id: 'htdemucs_6s', name: '六声部（吉他 / 钢琴为实验效果）', stems: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'] },
]);

export const SOURCE_COLORS = Object.freeze(['#5db9d4', '#e7b55e', '#bb8ce8', '#e78396', '#6fce9b', '#86a8ef', '#db96ce', '#b5c767']);
export const audioSourceColor = index => SOURCE_COLORS[index] ?? `hsl(${Math.round(index * 137.508) % 360}, 64%, 65%)`;

export function sourceAudioRange(source, start, end) {
  const buffer = source.buffer;
  if (!buffer?.getChannelData || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw Error('分析音源或时间范围无效');
  if (start < -.001 || end > buffer.duration + .001) throw Error('分析区间超出原音乐时间范围');
  return { startSeconds: Math.max(0, start), endSeconds: Math.min(buffer.duration, end), offsetSeconds: 0 };
}
