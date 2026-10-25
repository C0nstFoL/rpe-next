// Marks Chinese text in index.html for translation and records the strings in the
// reference catalog. Keys hash the text, so identical wording shares one entry
// and re-running after a merge only adds what changed.
//   node tools/i18n-markup.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { hash7 } from './i18n-extract.mjs';

const root = new URL('../', import.meta.url);
const htmlFile = new URL('index.html', root);
const catalogFile = new URL('src/locales/zh-CN.mjs', root);

let html = await readFile(htmlFile, 'utf8');
const pairs = [];
const byValue = new Map();
const key = (kind, value) => {
  if (byValue.has(value)) return byValue.get(value);
  let base = `markup.${kind}.${hash7(value)}`;
  while (pairs.some(pair => pair.key === base)) base += 'x';
  byValue.set(value, base);
  pairs.push({ key: base, value });
  return base;
};

html = html.replace(/<title>([^<]*[\u4e00-\u9fff][^<]*)<\/title>/g,
  (match, value) => `<title data-i18n="${key('title', value.trim())}"></title>`);

const attributeNames = { title: 'data-i18n-title', alt: 'data-i18n-alt', placeholder: 'data-i18n-placeholder', 'aria-label': 'data-i18n-aria-label' };
html = html.replace(/\b(title|alt|placeholder|aria-label)="([^"]*[\u4e00-\u9fff][^"]*)"/g,
  (match, attribute, value) => `${attributeNames[attribute]}="${key(attribute.replace('aria-label', 'aria'), value)}"`);

// `<option>` may only contain text, so the key goes on the option itself.
html = html.replace(/<option([^>]*)>([^<>]*[\u4e00-\u9fff][^<>]*)<\/option>/g,
  (match, attributes, value) => `<option${attributes} data-i18n="${key('text', value.trim())}"></option>`);

html = html.replace(/>([^<>]*[\u4e00-\u9fff][^<>]*)</g, (match, value) => {
  const trimmed = value.trim();
  if (!trimmed) return match;
  const leading = value.match(/^\s*/)[0];
  const trailing = value.match(/\s*$/)[0];
  return `>${leading}<span data-i18n="${key('text', trimmed)}"></span>${trailing}<`;
});

await writeFile(htmlFile, html);

let catalog = await readFile(catalogFile, 'utf8');
const missing = pairs.filter(({ key: name }) => !catalog.includes(`'${name}':`));
if (missing.length) {
  const lines = missing.map(({ key: name, value }) => `    '${name}': ${JSON.stringify(value)},`);
  catalog = catalog.replace(/\n  \},\n\};\n?$/, `\n${lines.join('\n')}\n  },\n};\n`);
  await writeFile(catalogFile, catalog);
}
console.log(`${pairs.length} markup strings, ${missing.length} new`);
