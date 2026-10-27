import test from 'node:test';
import assert from 'node:assert/strict';
import { DICTATION_DEFAULTS, chineseNumber, englishNumber, dictationNumber, prepareDictationText, matchesDictationKey, editableDictationTarget, validDictationPcm } from '../src/core/dictation.mjs';
import { setLocale } from '../src/i18n.mjs';
import { dictationPackages, extractSpeechPackage } from '../desktop/dictation.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

test('中文数词和小数作为数值应用，纯数字框过滤无关文字并保留负号', () => {
  for (const [text, expected] of [['三百', '300'], ['负三百点五', '-300.5'], ['一千零三', '1003'], ['二〇二六', '2026'], ['十二', '12'], ['五万三千二百一十', '53210'], ['三百毫秒。', '300'], ['value: 42px', '42'], ['零点零五', '0.05'], ['三点五六', '3.56'], ['负１２.５秒', '-12.5']]) assert.equal(dictationNumber(text), expected, text);
  assert.equal(chineseNumber('一亿零三万零六'), 100030006);
  for (const text of ['hello', '', '--3', '1.2.3']) assert.equal(dictationNumber(text), null, text);
  assert.equal(prepareDictationText('三百', 'text'), '300');
  assert.equal(prepareDictationText('三维摄像机', 'text'), '三维摄像机');
  assert.equal(prepareDictationText('hello 世界', 'text'), 'hello 世界');
  assert.equal(prepareDictationText('三冒号一斜杠二', 'beat'), '3:1/2');
});

test('默认开启，仅捕获配置的按键，重复和输入法状态由交互层处理', () => {
  assert.equal(DICTATION_DEFAULTS.enabled, true);
  const key = { code: 'Backquote', key: '`', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  assert.equal(matchesDictationKey(key), true);
  assert.equal(matchesDictationKey({ ...key, key: '~', shiftKey: true }), true);
  assert.equal(matchesDictationKey({ ...key, ctrlKey: true }), false);
  assert.equal(matchesDictationKey({ ...key, code: 'KeyV', key: 'v' }, 'V'), true);
  assert.equal(matchesDictationKey(key, ''), false);
});

test('英文数词、负数和小数转换不依赖界面语言', context => {
  context.after(() => setLocale('zh-CN'));
  const samples = [
    ['five hundred', 500], ['Five Hundred.', 500], ['five hundred and twenty-six', 526],
    ['negative five hundred point zero five', -500.05], ['minus 3.5', -3.5], ['zero point zero five', 0.05],
    ['one million two hundred and thirty-four thousand five hundred and six', 1234506],
    ['a hundred', 100], ['hundred', 100], ['one thousand and a hundred', 1100], ['one two three', 123],
    ['five hundred milliseconds', 500], ['set it to twenty-five pixels', 25],
  ];
  for (const locale of ['zh-CN', 'en-US']) {
    setLocale(locale);
    for (const [text, expected] of samples) assert.equal(dictationNumber(text), String(expected), `${locale}: ${text}`);
    assert.equal(prepareDictationText('five hundred', 'text'), '500');
    assert.equal(prepareDictationText('five hundred and more', 'text'), '500 and more');
    assert.equal(prepareDictationText('set it to five hundred pixels', 'text'), 'set it to 500 pixels');
    assert.equal(prepareDictationText('three colon one slash two', 'beat'), '3:1/2');
    assert.equal(prepareDictationText('someone is here', 'text'), 'someone is here');
    assert.equal(prepareDictationText('三维摄像机', 'text'), '三维摄像机');
  }
  for (const text of ['', 'negative', 'five and six', 'one hundred hundred', 'one thousand and', 'one point hundred', 'one million two million']) assert.equal(englishNumber(text), null, text);
});

test('通过事件路径识别 Shadow DOM 输入框，只读或禁用输入不触发', () => {
  const host = { tagName: 'DIV' };
  const input = { tagName: 'INPUT', type: 'text', dataset: {}, closest: () => null };
  assert.equal(editableDictationTarget({ target: host, composedPath: () => [input, host] }), input);
  assert.equal(editableDictationTarget({ target: { ...input, disabled: true } }), null);
  assert.equal(editableDictationTarget({ target: { ...input, readOnly: true } }), null);
  assert.equal(editableDictationTarget({ target: { ...input, type: 'checkbox' } }), null);
  assert.equal(editableDictationTarget({ target: { ...input, dataset: { dictation: 'off' } } }), null);
});

test('麦克风分片限制大小并拒绝非有限值', () => {
  assert.equal(validDictationPcm(new Float32Array([0, -1, 0.5])), true);
  assert.equal(validDictationPcm(new Float32Array([NaN])), false);
  assert.equal(validDictationPcm(new Float32Array([2])), false);
  assert.equal(validDictationPcm(new Float32Array(32001)), false);
});

test('六种桌面平台均使用固定版本及完整性值，不执行 npm 安装脚本', () => {
  for (const platform of ['win32', 'darwin', 'linux']) for (const arch of ['x64', 'arm64']) {
    const packages = dictationPackages(platform, arch);
    assert.equal(packages.length, 2);
    for (const entry of packages) { assert.match(entry.url, /^https:\/\/registry\.npmjs\.org\//); assert.equal(Buffer.from(entry.integrity, 'base64').length, 64); }
    assert.ok(packages[1].name.endsWith(arch));
  }
  assert.throws(() => dictationPackages('linux', 'ia32'));
});

function tar(name, text, type = '0') {
  const data = Buffer.from(text), header = Buffer.alloc(512);
  header.write(name); header.write(data.length.toString(8).padStart(11, '0') + '\0', 124); header.write(type, 156);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]));
}

test('私有运行库只解包常规文件，拒绝路径越界和链接', async context => {
  const root = await mkdtemp(join(tmpdir(), 'rpen-speech-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await extractSpeechPackage(tar('package/sub/main.js', 'verified'), root);
  assert.equal(await readFile(join(root, 'sub/main.js'), 'utf8'), 'verified');
  await assert.rejects(extractSpeechPackage(tar('package/../../escape', 'no'), root), /escaped/);
  await assert.rejects(extractSpeechPackage(tar('package/link', 'no', '2'), root), /link/);
});
