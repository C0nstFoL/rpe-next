import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EditorSkinRuntime } from '../src/ui/editor-skin-runtime.mjs';

function fixture(context, { direct = false, nestedControl = false } = {}) {
  const previousDocument = globalThis.document, previousObserver = globalThis.MutationObserver, observers = [], attributes = new Map();
  const element = { nodeType: 1, isConnected: true, dataset: {}, matches: () => false, closest: () => null,
    getAttribute: key => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key) };
  const text = { nodeType: 3, textContent: '原始名称' }, wrapper = { nodeType: 1, parentElement: element, childNodes: [text], closest: () => nestedControl ? {} : element };
  text.parentElement = direct ? element : wrapper;
  const icon = { nodeType: 1, name: 'img' }, shortcut = { nodeType: 1, name: 'kbd' }, input = { nodeType: 1, name: 'input', value: 'unchanged' };
  element.childNodes = [icon, direct ? text : wrapper, shortcut, input];
  element.querySelectorAll = selector => selector === '[data-i18n]' && !direct ? [wrapper] : [];
  let matches = true;
  globalThis.document = { querySelectorAll: selector => matches && selector === '#save' ? [element] : [], querySelector: () => null, documentElement: { dataset: {} }, fonts: { delete() {} } };
  globalThis.MutationObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } disconnect() {} observe() {} };
  const runtime = new EditorSkinRuntime(() => {});
  runtime.prepared = { record: { skin: { texts: [{ selector: '@save', text: '皮肤名称', title: '皮肤提示' }] } }, images: new Map(), sources: new Map() };
  context.after(() => { runtime.clear(); globalThis.document = previousDocument; globalThis.MutationObserver = previousObserver; });
  return { runtime, element, text, wrapper, icon, shortcut, input, observer: observers[0], stopMatching: () => { matches = false; } };
}

test('皮肤文字覆盖翻译包装中的标签，保留图标、快捷键和输入框，卸载恢复原文', context => {
  const { runtime, element, text, wrapper, icon, shortcut, input } = fixture(context); const children = [...element.childNodes];
  runtime.sync(); assert.equal(text.textContent, '皮肤名称'); assert.equal(element.getAttribute('title'), '皮肤提示');
  assert.deepEqual(element.childNodes, children); assert.equal(element.childNodes[0], icon); assert.equal(element.childNodes[2], shortcut); assert.equal(input.value, 'unchanged');
  runtime.sync(); runtime.clear(); assert.equal(wrapper.childNodes[0].textContent, '原始名称'); assert.equal(element.getAttribute('title'), null);
});

test('翻译或动态页面重建标签后重新应用皮肤，取消匹配时恢复应用最新文案', context => {
  const { runtime, element, wrapper, stopMatching } = fixture(context); runtime.sync();
  const updated = { nodeType: 3, textContent: '应用的新名称', parentElement: wrapper }; wrapper.childNodes = [updated]; runtime.sync();
  assert.equal(updated.textContent, '皮肤名称'); assert.equal(element.childNodes[1], wrapper);
  stopMatching(); runtime.sync(); assert.equal(updated.textContent, '应用的新名称');
});

test('翻译标签与提示变更触发皮肤更新，无关文字不触发更新', context => {
  const { runtime, text, wrapper, element, observer } = fixture(context); runtime.sync(); let scheduled = 0; runtime.schedule = () => scheduled++;
  observer.callback([{ type: 'characterData', target: text, addedNodes: [] }]); assert.equal(scheduled, 1);
  observer.callback([{ type: 'childList', target: wrapper, addedNodes: [] }]); assert.equal(scheduled, 2);
  element.setAttribute('title', '应用提示'); observer.callback([{ type: 'attributes', target: element, attributeName: 'title', oldValue: '皮肤提示' }]); assert.equal(scheduled, 3);
  observer.callback([{ type: 'characterData', target: { nodeType: 3 }, addedNodes: [] }]); assert.equal(scheduled, 3);
});

test('原有直属文字覆盖继续有效，不会越过目标改写内嵌控件的翻译', context => {
  const { runtime, text } = fixture(context, { direct: true }); runtime.sync(); assert.equal(text.textContent, '皮肤名称'); runtime.clear(); assert.equal(text.textContent, '原始名称');
});

test('父容器文字覆盖不会修改内部按钮或表单控件的标签', context => {
  const { runtime, text } = fixture(context, { nestedControl: true }); runtime.sync(); assert.equal(text.textContent, '原始名称');
});

test('墨线保持已有中文用词，各英文标签对应皮肤中的称呼', async () => {
  const skin = JSON.parse(await readFile(new URL('../assets/editor-skins/inkline/skin.json', import.meta.url), 'utf8'));
  const terms = [
    ['@open', '打开', 'Open'], ['@save', '保存', 'Save'], ['@library', '谱面库', 'Chart library'], ['@migrate', '迁移', 'Migrate'],
    ['@toolbar > label:has(#snap-x)', '吸附', 'Snap'], ['@toolbar label.y-scale-control', 'Y 缩放', 'Y scale'],
    ['@curve-notes', '曲线音符', 'Curve notes'], ['@curve-trajectory', '曲线轨迹', 'Curve trajectory'], ['#clipboard-history', '剪贴板', 'Clipboard'],
    ['[data-panel] > [data-return-chart],#diagnose-close,#history-close', '谱面工具', 'Chart tools'], ['#home-open', '打开谱面', 'Open chart'], ['#resume-editor', '继续编辑', 'Keep editing'],
    ['#modal:has(#modal-apply[hidden]) .modal-actions button[value=cancel]', '关闭', 'Close'], ['#modal:has(#modal-apply:not([hidden])) .modal-actions button[value=cancel]', '取消', 'Cancel']
  ];
  for (const [selector, chinese, english] of terms) assert.deepEqual(skin.texts.find(entry => entry.selector === selector)?.text, { 'zh-CN': chinese, 'en-US': english }, selector);
  const groups = [['chart', '谱面', 'Chart'], ['generate', '生成', 'Generate'], ['modes', '编辑模式', 'Edit modes'], ['assist', '检查与协作', 'Checks and collaboration']];
  for (const [id, chinese, english] of groups) assert.deepEqual(skin.organize.find(group => group.id === id)?.label, { 'zh-CN': chinese, 'en-US': english }, id);
});
