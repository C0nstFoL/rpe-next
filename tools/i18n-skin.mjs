// Adds per-locale maps to the built-in editor skin so its labels and texts
// follow the interface language. English text lives here; the Chinese original
// is kept as `zh-CN`.
//   node tools/i18n-skin.mjs
import { readFile, writeFile } from 'node:fs/promises';

const file = new URL('../assets/editor-skins/inkline/skin.json', import.meta.url);
const skin = JSON.parse(await readFile(file, 'utf8'));

const EN = {
  '墨线 Inkline': 'Inkline',
  '深灰工作台，判定线金为唯一强调色。精简标签与图标化常用操作，背景预览设置移至编辑底栏，时间轴网格降噪以突出音符。强调色、底色、文字与事件颜色可在设置中调整（默认 #efcd78 / #252527 / #ebe7e0 / #4d6476 / #6e8a9e），底色始终保持深色。':
    'A deep-grey workspace where the judge-line gold is the only accent. Compact labels and icon-first common actions, background preview moved to the editor footer, and a quieter timeline grid so notes stand out. Accent, base, text and event colors can be changed in Settings (defaults #efcd78 / #252527 / #ebe7e0 / #4d6476 / #6e8a9e); the base always stays dark.',
  '界面字体为 Noto Sans SC 子集（© 2014-2021 Adobe，SIL Open Font License 1.1，完整许可见字体内嵌元数据）；图标与样式为本皮肤原创。':
    'The interface font is a Noto Sans SC subset (© 2014-2021 Adobe, SIL Open Font License 1.1; the full license is embedded in the font metadata); icons and styles are original to this skin.',
  '强调色': 'Accent color', '界面底色': 'Base color', '文字颜色': 'Text color',
  '事件底色': 'Event fill', '事件边框与曲线': 'Event border and curve', '边框强度（%）': 'Border strength (%)',
  '侧栏宽度': 'Sidebar width', '全局事件': 'Global events', '谱面': 'Chart', '生成': 'Generate',
  '编辑模式': 'Edit modes', '检查与协作': 'Checks and collaboration',
  '新建谱面': 'New chart', '打开': 'Open',
  '打开 JSON / PEZ 谱面，也可载入音乐或图片': 'Open a JSON / PEZ chart, or load music and images',
  '保存': 'Save', '保存到谱面库（Ctrl+S）': 'Save to the chart library (Ctrl+S)',
  '导出 PEZ / JSON': 'Export PEZ / JSON', '谱面库': 'Chart library', '迁移': 'Migrate',
  '迁移旧 RPE 项目': 'Migrate old RPE projects', '从自动备份恢复': 'Restore from automatic backups',
  '设置与热键': 'Settings and hotkeys', '撤销（Ctrl+Z）': 'Undo (Ctrl+Z)', '重做（Ctrl+Y）': 'Redo (Ctrl+Y)',
  '复制': 'Copy', '剪切': 'Cut', '粘贴': 'Paste',
  '镜像：翻转选中音符，或 X / 旋转事件': 'Mirror: flip selected notes, or X / rotation events',
  '删除': 'Delete', '批量修改选中音符': 'Batch edit selected notes', '吸附': 'Snap',
  'Y 缩放': 'Y scale', 'Y 轴缩放（像素 / 秒）': 'Y axis scale (pixels per second)',
  '曲线音符': 'Curve notes', '填充曲线音符': 'Fill curve notes', '曲线轨迹': 'Curve trajectory',
  '生成曲线轨迹': 'Generate curve trajectory', '剪贴板': 'Clipboard',
  '剪贴板历史（长按 Ctrl+V）': 'Clipboard history (hold Ctrl+V)', '谱面工具': 'Chart tools',
  '返回谱面工具': 'Back to chart tools', '打开谱面': 'Open chart', '继续编辑': 'Keep editing',
  '关闭': 'Close', '取消': 'Cancel',
  '可连续取样，完成后统一应用 · Esc 全部取消': 'Sample repeatedly, then apply at once · Esc cancels all',
  '打开 JSON / PEZ': 'Open a JSON / PEZ chart',
  '音频分析': 'Audio analysis',
};

const KEYS = new Set(['label', 'text', 'title', 'ariaLabel', 'placeholder', 'name', 'description', 'license', 'content']);
const missing = new Set();
const localize = (value, isContent = false) => {
  if (typeof value !== 'string' || !/[\u4e00-\u9fff]/.test(value)) return value;
  // CSS `content` values keep their quotes: `"全局事件"`.
  const quoted = isContent && /^(["']).*\1$/s.test(value);
  const inner = quoted ? value.slice(1, -1) : value;
  const english = EN[inner] ?? EN[value];
  if (!english) { missing.add(value); return value; }
  const wrap = text => quoted ? `"${text}"` : text;
  return { 'zh-CN': wrap(inner), 'en-US': wrap(english) };
};
const walk = node => {
  if (Array.isArray(node)) return node.map(walk);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = KEYS.has(key) && typeof value === 'string' ? localize(value, key === 'content') : walk(value);
  }
  return out;
};
await writeFile(file, JSON.stringify(walk(skin), null, 2) + '\n');
if (missing.size) console.log('untranslated skin strings:', [...missing]);
console.log('skin localized');
