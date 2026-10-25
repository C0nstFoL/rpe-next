// Appends verified translation batches (`tools/i18n-batches/*.en.json`) to the
// English catalog. Safe to re-run: existing keys are kept.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const localeFile = join(root, 'src/locales/en-US.mjs');
const batches = (await readdir(join(root, 'tools/i18n-batches'))).filter(name => name.endsWith('.en.json')).sort();
let text = await readFile(localeFile, 'utf8');
const added = [];
for (const name of batches) {
  const batch = JSON.parse(await readFile(join(root, 'tools/i18n-batches', name), 'utf8'));
  for (const [key, value] of Object.entries(batch)) if (!text.includes(`'${key}':`)) added.push([key, value]);
}
if (added.length) {
  const block = added.map(([key, value]) => `    '${key}': ${JSON.stringify(value)},`).join('\n');
  text = text.replace(/\n  \},\n\};\n?$/, `\n    // Translated from the reference catalog (${batches.length} batches).\n${block}\n  },\n};\n`);
  await writeFile(localeFile, text);
}
console.log(`${added.length} messages appended from ${batches.length} batches`);
