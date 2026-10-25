// Removes blank lines from the locale catalogs so entries form one compact
// block. Comments and ordering are preserved.
//   node tools/i18n-format.mjs
import { readFile, writeFile } from 'node:fs/promises';

for (const locale of ['zh-CN', 'en-US']) {
  const file = `src/locales/${locale}.mjs`;
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/).map(line => line.replace(/\s+$/, ''));
  const output = lines.filter(line => line.length > 0);
  await writeFile(file, output.join('\n') + '\n');
  console.log(`${file}: ${output.length} lines, 0 blank`);
}
