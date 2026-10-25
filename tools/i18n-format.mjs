// Normalizes the locale catalogs: at most one blank line in a row, no trailing
// whitespace, and a single trailing newline. Keeps the author's ordering.
//   node tools/i18n-format.mjs
import { readFile, writeFile } from 'node:fs/promises';

for (const locale of ['zh-CN', 'en-US']) {
  const file = `src/locales/${locale}.mjs`;
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/).map(line => line.replace(/\s+$/, ''));
  const output = [];
  for (const line of lines) {
    if (!line && !output.at(-1)) continue;
    output.push(line);
  }
  while (output.at(-1) === '') output.pop();
  await writeFile(file, output.join('\n') + '\n');
  console.log(`${file}: ${output.length} lines`);
}
