// Extraction helper for the locale catalogs. Rewrites Chinese string literals in
// application modules as `t('key', …)` calls and returns `{ key, value }` pairs.
// Keys hash the file name plus the literal text, so they survive line moves and
// identical strings share one translation.
//
// Template literals: every `${…}` becomes `{pN}` and the call receives
// `{ pN: expr }`, which lets translators reorder words freely.
import { createHash } from 'node:crypto';

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

function interpolationGroups(body) {
  const groups = [];
  let index = 0;
  while (index < body.length) {
    const start = body.indexOf('${', index);
    if (start < 0) break;
    let depth = 1; let cursor = start + 2;
    while (cursor < body.length && depth > 0) {
      if (body[cursor] === '{') depth++;
      else if (body[cursor] === '}') depth--;
      cursor++;
    }
    groups.push({ start, end: cursor, expression: body.slice(start + 2, cursor - 1) });
    index = cursor;
  }
  return groups;
}

function messageFromTemplate(body) {
  const groups = interpolationGroups(body);
  let template = '';
  let cursor = 0;
  const parameters = [];
  for (const group of groups) {
    template += body.slice(cursor, group.start);
    template += `{p${parameters.length}}`;
    parameters.push(group.expression.trim());
    cursor = group.end;
  }
  template += body.slice(cursor);
  return { template, parameters };
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
    let end = index + 1;
    let body = '';
    let closed = false;
    while (end < text.length) {
      const current = text[end];
      if (current === '\\') { body += current + (text[end + 1] ?? ''); end += 2; continue; }
      if (current === quote) { closed = true; break; }
      if (quote !== '`' && current === '\n') break;
      if (quote === '`' && current === '$' && text[end + 1] === '{') {
        let depth = 1; let cursor = end + 2;
        while (cursor < text.length && depth > 0) {
          if (text[cursor] === '{') depth++;
          else if (text[cursor] === '}') depth--;
          cursor++;
        }
        body += text.slice(end, cursor); end = cursor; continue;
      }
      body += current; end++;
    }
    const literal = text.slice(index, end + 1);
    if (!closed || !CJK.test(body)) { out += literal; index = end + 1; continue; }
    const before = out.replace(/\s+$/, '');
    const nextCharacter = text.slice(end + 1).match(/^\s*(.)/)?.[1];
    const isObjectKey = nextCharacter === ':' && /([{,]\s*$)|(^\s*$)/.test(before);
    if (isObjectKey || MEMBER_BEFORE.test(before) || KEYWORD_BEFORE.test(before)) { out += literal; index = end + 1; continue; }
    if (DATA_LITERALS.has(body) || DATA_SHAPE.test(body)) { out += literal; index = end + 1; continue; }
    if (quote === '`') {
      const { template, parameters } = messageFromTemplate(body);
      const key = keyFor(file, body);
      pairs.push({ key, value: template });
      const rewritten = parameters.map((expression, position) => {
        const nested = extractSource(file, expression);
        for (const pair of nested.pairs) if (!pairs.some(existing => existing.key === pair.key)) pairs.push(pair);
        return `p${position}: ${nested.out}`;
      });
      out += rewritten.length ? `t('${key}', { ${rewritten.join(', ')} })` : `t('${key}')`;
      index = end + 1; continue;
    }
    const value = body.replace(/\\(['"\\`])/g, '$1').replace(/\\(.)/g, '\\$1');
    const key = keyFor(file, value);
    pairs.push({ key, value });
    out += `t('${key}')`;
    index = end + 1;
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
