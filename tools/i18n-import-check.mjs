// Verifies that every module using a translation helper also imports it.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const helpers = ['t', 'localizedValue', 'isLocalizedMap', 'chartDisplayName', 'groupDisplayName', 'isUngrouped', 'installDomTranslation', 'setLocale', 'currentLocale', 'availableLocales'];
const files = [];
const walk = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'locales') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.mjs') && !/^i18n/.test(entry.name)) files.push(full);
  }
};
walk('src');
const problems = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const helper of helpers) {
    const used = new RegExp(`(?<![.\\w$'])${helper}\\(`).test(text);
    if (!used) continue;
    const declared = new RegExp(`(?:import|export)[^;]*\\b${helper}\\b[^;]*from`, 's').test(text)
      || new RegExp(`(?:const|let|var|function)\\s+${helper}\\b`).test(text)
      || (helper === 't' && /export const t\b/.test(text));
    if (!declared) problems.push(`${relative('.', file)}: ${helper}`);
  }
}
console.log(problems.length ? problems.join('\n') : 'imports ok');
