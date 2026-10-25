// Drops catalog keys that no longer appear in the source, markup, skins or mod
// manifests. Run after a merge so entries from rewritten code do not linger.
//   node tools/i18n-prune.mjs [--dry-run]
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dryRun = process.argv.includes('--dry-run');

const files = [];
const walk = async (directory, predicate) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'vendor') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, predicate);
    else if (predicate(entry.name)) files.push(full);
  }
};
await walk(join(root, 'src'), name => name.endsWith('.mjs'));
await walk(join(root, 'assets'), name => name.endsWith('.json'));
files.push(join(root, 'index.html'));

const used = new Set();
for (const file of files) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/'([a-z][\w-]*\.s[0-9a-f]{7})'/g)) used.add(match[1]);
  // Semantic keys added by hand (settings.language, doc.untitled, …).
  for (const match of text.matchAll(/\bt\(\s*'([a-z][\w-]*\.[\w.-]+)'/g)) used.add(match[1]);
  for (const match of text.matchAll(/data-i18n(?:-[\w-]+)?="([\w.-]+)"/g)) used.add(match[1]);
  // Static markup keys in the catalog are hashed too; keep them if present in markup.
  for (const match of text.matchAll(/"(markup\.[\w.-]+)"/g)) used.add(match[1]);
}

const report = [];
for (const name of ['zh-CN', 'en-US']) {
  const file = join(root, 'src/locales', `${name}.mjs`);
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
  const kept = lines.filter(line => {
    const match = line.match(/^\s*'([^']+)':/);
    if (!match) return true;
    if (used.has(match[1])) return true;
    report.push(`${name}: drop ${match[1]}`);
    return false;
  });
  if (!dryRun && kept.length !== lines.length) await writeFile(file, kept.join('\n'));
}
console.log(report.slice(0, 20).join('\n'));
console.log(`${report.length} unused entries${dryRun ? ' (dry run)' : ' removed'}`);
