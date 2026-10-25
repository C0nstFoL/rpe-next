// Applies `i18n-extract` to every source module that still contains Chinese
// literals, adds the `t` import where needed, and records new keys in the
// reference catalog. Run after merging upstream code: new modules are written in
// the reference language, so this is how their strings become translatable.
//   node tools/i18n-apply.mjs
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addImport, CJK, extractSource } from './i18n-extract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
const walk = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'locales') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith('.mjs') && !/^i18n/.test(entry.name)) files.push(full);
  }
};
await walk(join(root, 'src'));

const pairs = new Map();
const changed = [];
for (const file of files) {
  const text = await readFile(file, 'utf8');
  if (!CJK.test(text)) continue;
  const result = extractSource(relative(root, file).replaceAll('\\', '/'), text);
  if (!result.pairs.length) continue;
  const specifier = relative(dirname(file), join(root, 'src/i18n.mjs')).replaceAll('\\', '/');
  await writeFile(file, addImport(result.out, specifier));
  for (const pair of result.pairs) if (!pairs.has(pair.key)) pairs.set(pair.key, pair.value);
  changed.push(`${relative(root, file).replaceAll('\\', '/')}: ${result.pairs.length}`);
}

const localeFile = join(root, 'src/locales/zh-CN.mjs');
let catalog = await readFile(localeFile, 'utf8');
const missing = [...pairs].filter(([key]) => !catalog.includes(`'${key}':`));
if (missing.length) {
  const lines = missing.map(([key, value]) => `    '${key}': ${JSON.stringify(value)},`);
  catalog = catalog.replace(/\n  \},\n\};\n?$/, `\n${lines.join('\n')}\n  },\n};\n`);
  await writeFile(localeFile, catalog);
}
console.log(changed.join('\n'));
console.log(`\n${changed.length} files touched, ${pairs.size} distinct messages, ${missing.length} new`);
