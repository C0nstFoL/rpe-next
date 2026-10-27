import { openFiles } from './files.mjs';
import { t } from '../i18n.mjs';

const accepts = { pez: '.pez', json: '.json', music: 'audio/*', cover: 'image/*', separate: '.json,audio/*,image/*' };
const extensions = {
  pez: /\.pez$/i,
  json: /\.json$/i,
  music: /\.(mp3|ogg|oga|wav|flac|m4a|aac|opus|webm|weba|aif|aiff)$/i,
  cover: /\.(png|jpe?g|webp|gif|bmp|avif|apng|svg|heic|heif)$/i,
};

export function chartImportAccept(kind, device = globalThis.navigator ?? {}) {
  const ios = /iPad|iPhone|iPod/i.test(device.userAgent ?? '')
    || device.platform === 'MacIntel' && device.maxTouchPoints > 1;
  return ios && (kind === 'pez' || kind === 'json' || kind === 'separate') ? '' : accepts[kind];
}

export function isChartImportFile(kind, file) {
  if (!file || !extensions[kind]) return false;
  return extensions[kind].test(file.name)
    || kind === 'music' && /^audio\//i.test(file.type)
    || kind === 'cover' && /^image\//i.test(file.type);
}

export function assignChartImportFiles(fileList, selected = {}) {
  const kinds = ['json', 'music', 'cover'];
  const assigned = {};
  for (const file of fileList) {
    // Prefer an explicit extension when the file provider supplies a vague MIME.
    const kind = kinds.find(kind => extensions[kind].test(file.name))
      ?? kinds.find(kind => isChartImportFile(kind, file));
    if (!kind) throw Error(t('chart-import.unsupportedBatch', { name: file.name }));
    if (assigned[kind]) throw Error(t('chart-import.multipleKind', { kind: t('chart-import.' + kind) }));
    assigned[kind] = file;
  }
  return { ...selected, ...assigned };
}

export function chartImportFiles(mode, selected) {
  if (mode !== 'pez' && mode !== 'separate') throw Error(t('chart-import.chooseMode'));
  const kinds = mode === 'pez' ? ['pez'] : ['json', 'music', 'cover'];
  const missing = kinds.filter(kind => !selected[kind]);
  if (missing.length) throw Error(t('chart-import.missing', { files: missing.map(kind => t('chart-import.' + kind)).join('、') }));
  for (const kind of kinds) if (!isChartImportFile(kind, selected[kind])) {
    throw Error(t('chart-import.invalid', { kind: t('chart-import.' + kind), name: selected[kind].name }));
  }
  const files = kinds.map(kind => selected[kind]);
  if (new Set(files.map(file => file.name.toLowerCase())).size !== files.length) throw Error(t('chart-import.duplicate'));
  return files;
}

export async function readChartImport(mode, selected, options) {
  const loaded = await openFiles(chartImportFiles(mode, selected), options);
  if (mode === 'separate') {
    for (const candidate of loaded.candidates) candidate.chart = {
      ...candidate.chart,
      META: { ...candidate.chart.META, song: selected.music.name, background: selected.cover.name },
    };
  }
  return loaded;
}
