import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parse } from '../src/core/vendor/acorn.mjs';
import { extractSource } from '../tools/i18n-extract.mjs';
import { setLocale, t } from '../src/i18n.mjs';

function translated(source) {
  const result = extractSource('fixture.mjs', source), messages = new Map(result.pairs.map(pair => [pair.key, pair.value]));
  parse(result.out, { ecmaVersion: 'latest', sourceType: 'module' });
  return { ...result, value: runInNewContext(result.out + '\nresult;', { t: (key, values = {}) => messages.get(key).replace(/\{(\w+)\}/g, (placeholder, name) => Object.hasOwn(values, name) ? String(values[name]) : placeholder) }) };
}

test('提取普通字符串正确解码换行、制表、引号，保留有意写出的字面转义', () => {
  for (const source of ['const result = "中文\\n下一行\\t内容";', 'const result = "中文\\\\n原样";', 'const result = "中文\\\"引号\\\"";']) {
    assert.equal(translated(source).value, runInNewContext(source + '\nresult;'));
  }
});

test('嵌套模板按真实表达式边界提取，不将代码残片混入翻译文案', () => {
  for (const skipped of [0, 2]) {
    const source = 'const message = "已完成", skipped = ' + skipped + '; const result = `${message}${skipped ? `；跳过 ${skipped} 个不适用的事件` : ""}`;';
    const result = translated(source); assert.equal(result.value, runInNewContext(source + '\nresult;'));
    assert.ok(result.pairs.every(pair => !pair.value.includes('`') && !pair.value.includes(" : ''}")));
  }
  const source = 'const value = 4; const result = `结果\\n${({ note: "括号}内容", value }).value}：${`内层 ${value}`}`;';
  assert.equal(translated(source).value, runInNewContext(source + '\nresult;'));
});

test('字符串与模板后的运算及成员访问不被误认为字符串内容', () => {
  for (const source of ['const result = "中文" + "文本";', 'const result = "中文".slice(0, 1);', 'const result = `中文 ${3}` + "后缀";']) {
    const result = translated(source); assert.equal(result.value, runInNewContext(source + '\nresult;')); assert.ok(result.pairs.length > 0);
  }
});

test('中英文事件通知无代码残片，摘要和存储提示保留真实换行，模组示例仍为有效代码', context => {
  context.after(() => setLocale('zh-CN'));
  for (const locale of ['zh-CN', 'en-US']) {
    setLocale(locale); assert.equal(t('event-tools.s42cc575', { p0: 'Done', p1: '' }), 'Done');
    const message = t('event-tools.s42cc575', { p0: 'Done', p1: ' + skipped' }); assert.equal(message, 'Done + skipped');
    for (const key of ['agent.sf8046ce', 'agent-context.s39718a0', 'audio-storage.s3ff7103', 'storage-panel.s20f3bd9']) {
      assert.ok(t(key).includes('\n'), key); assert.ok(!t(key).includes('\\n'), key);
    }
    parse(t('mod-manager.s33e5ce9'), { ecmaVersion: 'latest', sourceType: 'module' });
  }
  setLocale('zh-CN'); assert.match(t('settings.language'), /界面语言.*Language/);
});
