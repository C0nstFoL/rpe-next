import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { modManifest, resolveModManifest, parseModPackage } from '../src/core/mod-package.mjs';
import { ModRuntime, ModScope } from '../src/ui/mod-runtime.mjs';
import { GlobalEventRegistry } from '../src/core/global-events.mjs';
import { createChart, serializeChart, parseChart } from '../src/core/chart.mjs';
import { setLocale } from '../src/i18n.mjs';
import { withCameraFollow, cameraFollowsChart } from '../assets/mods/spatial-camera/settings.mjs';

const fixture = () => modManifest({ protocol: 'rpen-mod', api: 1, id: 'example', version: '1.2.3', entry: 'main.mjs',
  name: { 'zh-CN': '示例', 'en-US': 'Example' }, author: { 'zh-CN': '作者', 'en-US': 'Author' }, description: { 'zh-CN': '说明', 'en-US': 'Description' },
  settings: { mode: { type: 'select', label: { 'zh-CN': '模式', 'en-US': 'Mode' }, description: { 'zh-CN': '选择模式', 'en-US': 'Choose mode' }, default: 'one', options: { one: { 'zh-CN': '一', 'en-US': 'One' } } } }
});

test('API 1 清单和设置文本保持字符串，原始映射、稳定键和包内容保留', context => {
  context.after(() => setLocale('zh-CN')); const source = fixture(), original = structuredClone(source);
  for (const locale of ['zh-CN', 'en-US']) {
    setLocale(locale); const manifest = resolveModManifest(source);
    for (const key of ['name', 'author', 'description', 'version']) assert.equal(typeof manifest[key], 'string');
    assert.equal(manifest.name, source.name[locale]); assert.equal(manifest.settings.mode.label, source.settings.mode.label[locale]);
    assert.equal(manifest.settings.mode.description, source.settings.mode.description[locale]); assert.equal(manifest.settings.mode.options.one, source.settings.mode.options.one[locale]);
    assert.equal(manifest.settings.mode.default, 'one'); assert.equal(manifest.version, '1.2.3'); assert.deepEqual(source, original);
    const registry = new GlobalEventRegistry(), runtime = new ModRuntime({ editor: { globalEventRegistry: registry }, notify() {}, invalidate() {}, changed() {} }), scope = new ModScope();
    const api = runtime.createApi({ id: source.id, scope, record: { manifest: source, files: new Map() }, settings: {}, onSetting() {} });
    assert.equal(api.manifest.name.trim(), source.name[locale]); assert.deepEqual(api.manifestSource, source); assert.notEqual(api.manifestSource, source);
    api.globalEvents.register({ id: 'move', name: api.manifest.name, columns: [{ id: 'x', name: 'X' }] });
    assert.equal(registry.types.get('example/move').source.name, source.name[locale]); assert.equal(registry.types.get('example/move').source.author, source.author[locale]);
    api.manifestSource.name['en-US'] = 'changed'; assert.deepEqual(source, original); scope.dispose(); assert.equal(registry.types.size, 0);
  }
});

test('内置摄像机使用实际多语言清单注册事件，跟随选项及事件来源可序列化往返', async context => {
  context.after(() => setLocale('zh-CN'));
  const source = JSON.parse(await readFile(new URL('../assets/mods/spatial-camera/mod.json', import.meta.url), 'utf8'));
  for (const locale of ['zh-CN', 'en-US']) {
    setLocale(locale); const registry = new GlobalEventRegistry(), scope = new ModScope();
    const runtime = new ModRuntime({ editor: { globalEventRegistry: registry }, notify() {}, invalidate() {}, changed() {} });
    const api = runtime.createApi({ id: source.id, scope, record: { manifest: modManifest(source), files: new Map() }, settings: {}, onSetting() {} });
    for (const id of ['position', 'rotation', 'lens']) api.globalEvents.register({ id, name: `${id} · ${api.manifest.name} (${api.manifest.author})`, columns: [{ id: 'x', name: 'X' }] });
    assert.equal(registry.types.size, 3);
    const chart = withCameraFollow(createChart(), api.manifest, true), restored = parseChart(serializeChart(chart));
    assert.equal(cameraFollowsChart(restored), true); assert.equal(restored.globalEvents.types['spatial-camera/lens'].source.name, source.name[locale]);
    assert.equal(typeof restored.globalEvents.types['spatial-camera/lens'].source.author, 'string'); assert.ok(!JSON.stringify(restored).includes('[object Object]')); scope.dispose();
  }
});

test('字符串旧清单兼容，多语言清单导入不改写源文件，版本保持语义版本字符串', async context => {
  context.after(() => setLocale('zh-CN')); setLocale('en-US');
  const old = modManifest({ ...fixture(), name: 'Old name', author: '', description: '', settings: {} }); assert.deepEqual(resolveModManifest(old), old);
  assert.throws(() => modManifest({ ...fixture(), version: { 'zh-CN': '1.0.0', 'en-US': '1.0.0' } }));
  const source = fixture(), raw = new TextEncoder().encode(JSON.stringify(source)), files = new Map([['mod.json', raw], ['main.mjs', new TextEncoder().encode('export default () => {};')]]);
  const record = parseModPackage(files); assert.deepEqual(record.manifest.name, source.name); assert.deepEqual(record.files.get('mod.json'), raw);
  const schema = JSON.parse(await readFile(new URL('../schemas/mod-v1.schema.json', import.meta.url), 'utf8')); assert.equal(schema.properties.version.type, 'string');
});
