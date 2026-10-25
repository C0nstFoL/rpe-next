import { mkdir, writeFile } from 'node:fs/promises';
import { BUILTIN_LOCALES } from '../src/core/locales.mjs';

const [zh, en] = BUILTIN_LOCALES;
const missing = Object.entries(zh.messages).filter(([key]) => !(key in en.messages));
await mkdir('tools/i18n-batches', { recursive: true });
const size = Math.ceil(missing.length / 6);
for (let index = 0; index < 6; index++) {
  const slice = missing.slice(index * size, (index + 1) * size);
  if (!slice.length) continue;
  await writeFile(`tools/i18n-batches/batch${index + 1}.json`, JSON.stringify(Object.fromEntries(slice), null, 1) + '\n');
  console.log(`batch${index + 1}: ${slice.length}`);
}
console.log('total', missing.length);
