// Extraction helper for the locale catalogs. Rewrites Chinese string literals in
// application modules as `t('key', …)` calls and returns `{ key, value }` pairs.
// Keys hash the file name plus the literal text, so they survive line moves and
// identical strings share one translation.
//
// Template literals: every `${…}` becomes `{pN}` and the call receives
// `{ pN: expr }`, which lets translators reorder words freely.
import { createHash } from 'node:crypto';
import { parseExpressionAt } from '../src/core/vendor/acorn.mjs';

export const CJK = /[\u4e00-\u9fff]/;

export const hash7 = text => createHash('sha1').update(String(text)).digest('hex').slice(0, 7);

export const keyFor = (file, literal) => `${file.replace(/^.*\//, '').replace(/\.mjs$/, '')}.s${hash7(literal)}`;

// Chart data and protocol values that must never be translated.
export const DATA_LITERALS = new Set([
  '未命名谱面', '默认层', '判定线', 'Default', '联机谱面.json',
]);

// CSS selectors and file names are data, not interface text.
const DATA_SHAPE = /^[#[]|\[[^\]]*="|\.(?:json|mjs|js|png|txt|pez|zip|wav|ogg)$/i;
const MEMBER_BEFORE = /(?:\?\.|\.)\s*$/;
const KEYWORD_BEFORE = /\b(?:import|from|export|case)\s*$/;

function leadingLiteral(node, start) {
  if (!node || typeof node !== 'object' || node.start !== start) return null;
  if (['Literal', 'TemplateLiteral'].includes(node.type)) return node;
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      const found = leadingLiteral(child, start); if (found) return found;
    }
  }
  return null;
}

// Walks the module, skipping comments, and rewrites CJK string literals.
export function extractSource(file, text) {
  const pairs = [];
  let out = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '/' && text[index + 1] === '/') { const end = text.indexOf('\n', index); const stop = end < 0 ? text.length : end; out += text.slice(index, stop); index = stop; continue; }
    if (character === '/' && text[index + 1] === '*') { const end = text.indexOf('*/', index + 2); const stop = end < 0 ? text.length : end + 2; out += text.slice(index, stop); index = stop; continue; }
    if (character === '/') {
      // A regex literal can hold Chinese too; copy it verbatim instead of
      // mistaking its body for interface text.
      const previous = out.replace(/\s+$/, '').slice(-1);
      const previousWord = out.replace(/\s+$/, '').match(/([\w$]+)$/)?.[1] ?? '';
      const startsRegex = !previous || '([{=,:;!&|?+-*%<>~^'.includes(previous)
        || ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'new', 'do', 'else', 'yield', 'await'].includes(previousWord);
      if (startsRegex) {
        let cursor = index + 1;
        let inClass = false;
        while (cursor < text.length) {
          const current = text[cursor];
          if (current === '\\') { cursor += 2; continue; }
          if (current === '\n') break;
          if (current === '[') inClass = true;
          else if (current === ']') inClass = false;
          else if (current === '/' && !inClass) { cursor++; break; }
          cursor++;
        }
        out += text.slice(index, cursor); index = cursor; continue;
      }
    }
    if (character !== "'" && character !== '"' && character !== '`') { out += character; index++; continue; }
    const quote = character;
    let parsed;
    try { parsed = leadingLiteral(parseExpressionAt(text, index, { ecmaVersion: 'latest' }), index); }
    catch { out += character; index++; continue; }
    if (!parsed) { out += character; index++; continue; }
    const end = parsed.end, literal = text.slice(index, end), body = literal.slice(1, -1);
    if (!CJK.test(parsed.type === 'Literal' ? parsed.value : body)) { out += literal; index = end; continue; }
    const before = out.replace(/\s+$/, '');
    const nextCharacter = text.slice(end).match(/^\s*(.)/)?.[1];
    const isObjectKey = nextCharacter === ':' && /([{,]\s*$)|(^\s*$)/.test(before);
    if (isObjectKey || MEMBER_BEFORE.test(before) || KEYWORD_BEFORE.test(before)) { out += literal; index = end; continue; }
    if (DATA_LITERALS.has(body) || DATA_SHAPE.test(body)) { out += literal; index = end; continue; }
    if (quote === '`') {
      const rewritten = parsed.expressions.map(expression => {
        const nested = extractSource(file, text.slice(expression.start, expression.end));
        for (const pair of nested.pairs) if (!pairs.some(existing => existing.key === pair.key)) pairs.push(pair);
        return nested.out;
      });
      if (parsed.quasis.some(quasi => CJK.test(quasi.value.cooked ?? quasi.value.raw))) {
        const template = parsed.quasis.map((quasi, position) => (quasi.value.cooked ?? quasi.value.raw) + (position < rewritten.length ? `{p${position}}` : '')).join('');
        const key = keyFor(file, body); pairs.push({ key, value: template });
        out += rewritten.length ? `t('${key}', { ${rewritten.map((expression, position) => `p${position}: ${expression}`).join(', ')} })` : `t('${key}')`;
      } else out += '`' + parsed.quasis.map((quasi, position) => quasi.value.raw + (position < rewritten.length ? '${' + rewritten[position] + '}' : '')).join('') + '`';
      index = end; continue;
    }
    const value = parsed.value;
    const key = keyFor(file, value);
    pairs.push({ key, value });
    out += `t('${key}')`;
    index = end;
  }
  return { out, pairs };
}

// Inserts `import { t } from '<relative>/i18n.mjs';` after the last import.
export function addImport(text, specifier) {
  if (text.includes(`from '${specifier}'`)) return text;
  const lines = text.split(/\r?\n/);
  let lastImport = -1;
  let braces = false;
  for (let index = 0; index < lines.length; index++) {
    const current = lines[index];
    if (braces) { braces = !/^[^'"]*from\s+['"][^'"]+['"]/.test(current); lastImport = index; continue; }
    if (!/^\s*import\b/.test(current)) break;
    if (/\bfrom\s+['"][^'"]+['"]|\bimport\s+['"][^'"]+['"]/.test(current)) { lastImport = index; continue; }
    braces = true; lastImport = index;
  }
  lines.splice(lastImport + 1, 0, `import { t } from '${specifier}';`);
  return lines.join('\n');
}
