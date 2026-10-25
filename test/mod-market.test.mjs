import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createModMarket, installMarketRelease, restoreMarketBackup, marketContentHash } from '../assets/mods/rpen-mod-market/client.mjs';
import { marketSocket } from '../assets/mods/rpen-mod-market/transport.mjs';
import { parseModPackage } from '../src/core/mod-package.mjs';
import { readZip, writeZip } from '../src/platform/archive.mjs';
import { ModManager } from '../src/ui/mod-manager.mjs';
import { ModScope } from '../src/ui/mod-runtime.mjs';
import { configureMarketText, marketName, marketText, runMarketTask } from '../assets/mods/rpen-mod-market/text.mjs';

const element = () => ({ prepend() {}, append() {}, remove() {}, querySelector: element });
globalThis.document = { createElement: element, body: element() };
const encode = new TextEncoder();
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(id = 'review-fixture', version = '1.0.0', dependencies = [], extra = {}) {
  const manifest = { protocol: 'rpen-mod', api: 1, id, name: 'Review fixture', author: 'Local review', description: '', version, dependencies, entry: 'main.mjs', ...extra };
  const record = parseModPackage(new Map([
    ['mod.json', encode.encode(JSON.stringify(manifest))],
    ['main.mjs', encode.encode('export function activate() {}')],
  ]));
  const bytes = await writeZip(record.files).arrayBuffer();
  const metadata = { manifest: record.manifest, version, release: id + '-' + version, sha256: createHash('sha256').update(new Uint8Array(bytes)).digest('hex'), content_hash: await marketContentHash(record.files) };
  return { record, bytes, metadata };
}

function managerFor(records = [], enabled = []) {
  const manager = {
    records: new Map(records.map(record => [record.manifest.id, record])),
    desired: new Set(enabled), errors: new Map(), options: Object.create(null), dialog: element(),
    runtime: {
      loaded: new Map(),
      async unload(id) { this.loaded.delete(id); },
      async load(record) { const state = { id: record.manifest.id, status: 'loaded', record }; this.loaded.set(state.id, state); return state; },
    },
    ready: Promise.resolve(), selected: records[0]?.manifest.id,
    persist() {}, updateStatus() {}, renderList() {},
    settingsFor(record) { return this.options[record.manifest.id] ??= {}; },
  };
  manager.disable = ModManager.prototype.disable.bind(manager);
  manager.enable = ModManager.prototype.enable.bind(manager);
  for (const id of enabled) manager.runtime.loaded.set(id, { id, status: 'loaded', record: manager.records.get(id) });
  return manager;
}

function installation(manager, fixtures, overrides = {}) {
  const writes = [];
  const reviews = [];
  const disk = new Map(manager.records);
  const controller = new AbortController();
  let recoveryBackup;
  const journal = {
    async read() { return structuredClone(recoveryBackup); },
    async save(backup) { recoveryBackup = structuredClone(backup); },
    async clear() { recoveryBackup = undefined; },
  };
  const options = {
    manager, parsePackage: parseModPackage, readZip, journal, signal: controller.signal, ownerId: 'rpen-mod-market',
    api: async (action, data, query) => {
      assert.equal(action, 'detail');
      return fixtures.find(item => item.record.manifest.id === query.id && (!query.release || item.metadata.release === query.release)).metadata;
    },
    download: async mod => fixtures.find(item => item.metadata.release === mod.release).bytes,
    storeMod: async record => { writes.push(record.manifest.id); disk.set(record.manifest.id, record); },
    deleteMod: async id => { disk.delete(id); },
    readMods: async () => [...disk].map(([id, record]) => ({ id, files: [...record.files] })),
    review: async (record, context) => { reviews.push({ id: record.manifest.id, context }); assert.equal(writes.length, 0); return { accepted: true, restore: false }; },
    ...overrides,
  };
  return { controller, writes, reviews, disk, journal, options, install: (id = fixtures[0].record.manifest.id, release = fixtures[0].metadata.release) => installMarketRelease(options, id, release) };
}

test('内置市场保留作者与 ID，所有文件可按宿主协议加载', async () => {
  const index = JSON.parse(await readFile(new URL('../assets/mods/index.json', import.meta.url), 'utf8'));
  const entry = index.find(item => item.directory === 'rpen-mod-market');
  assert.ok(entry);
  const files = new Map(await Promise.all(entry.files.map(async name => [name, new Uint8Array(await readFile(new URL('../assets/mods/rpen-mod-market/' + name, import.meta.url)))])));
  const record = parseModPackage(files);
  assert.equal(record.manifest.id, 'rpen-mod-market');
  assert.equal(record.manifest.version, '1.0.2');
  assert.equal(record.manifest.author, 'NyamonZone');
  assert.equal(record.manifest.name['en-US'], 'Nyamon Mod Market');
  assert.ok(files.has('README.zh-CN.md') && files.has('text.mjs'));
});

test('new installation requires review and remains disabled by default', async () => {
  const item = await fixture();
  const manager = managerFor();
  const operation = installation(manager, [item]);
  await operation.install();
  assert.equal(operation.reviews.length, 1);
  assert.equal(manager.runtime.loaded.has('review-fixture'), false);
  assert.equal(operation.disk.has('review-fixture'), true);
});

test('rejecting review does not write or change the enabled original', async () => {
  const old = await fixture();
  const item = await fixture('review-fixture', '2.0.0');
  const manager = managerFor([old.record], ['review-fixture']);
  const operation = installation(manager, [item], { review: async () => ({ accepted: false }) });
  await assert.rejects(operation.install(), { name: 'AbortError' });
  assert.equal(operation.writes.length, 0);
  assert.equal(manager.records.get('review-fixture'), old.record);
  assert.equal(manager.runtime.loaded.get('review-fixture').record, old.record);
});

test('all dependencies are reviewed before any package is stored', async () => {
  const child = await fixture('child');
  const parent = await fixture('parent', '1.0.0', ['child']);
  const operation = installation(managerFor(), [parent, child]);
  await operation.install();
  assert.deepEqual(operation.reviews.map(item => item.id), ['child', 'parent']);
  assert.deepEqual(operation.writes, ['child', 'parent']);
});

test('invalid parent hash leaves no dependency installed', async () => {
  const child = await fixture('child');
  const parent = await fixture('parent', '1.0.0', ['child']);
  parent.metadata.sha256 = '0'.repeat(64);
  const operation = installation(managerFor(), [parent, child]);
  await assert.rejects(operation.install(), /hash mismatch/);
  assert.equal(operation.disk.size, 0);
  assert.equal(operation.reviews.length, 0);
});

test('explicit restore re-enables updated dependency and its dependents', async () => {
  const old = await fixture('dependency');
  const dependent = await fixture('dependent', '1.0.0', ['dependency']);
  const item = await fixture('dependency', '2.0.0');
  const manager = managerFor([old.record, dependent.record], ['dependency', 'dependent']);
  const operation = installation(manager, [item], { review: async () => ({ accepted: true, restore: true }) });
  await operation.install();
  assert.equal(manager.runtime.loaded.get('dependency').record.manifest.version, '2.0.0');
  assert.equal(manager.runtime.loaded.has('dependent'), true);
  assert.deepEqual([...manager.desired].sort(), ['dependency', 'dependent']);
});

test('default update disables affected packages and reports their names', async () => {
  const old = await fixture('dependency');
  const dependent = await fixture('dependent', '1.0.0', ['dependency']);
  const item = await fixture('dependency', '2.0.0');
  const manager = managerFor([old.record, dependent.record], ['dependency', 'dependent']);
  const operation = installation(manager, [item]);
  const result = await operation.install();
  assert.equal(manager.runtime.loaded.size, 0);
  assert.deepEqual(result.disabled.map(item => item.id), ['dependency', 'dependent']);
});

test('transient write failure restores package, settings and enabled state', async () => {
  const old = await fixture();
  const item = await fixture('review-fixture', '2.0.0');
  const manager = managerFor([old.record], ['review-fixture']);
  manager.options['review-fixture'] = { value: 7 };
  const operation = installation(manager, [item]);
  let first = true;
  operation.options.storeMod = async record => { if (first) { first = false; throw Error('Transient write failure'); } operation.disk.set(record.manifest.id, record); };
  await assert.rejects(operation.install(), /Transient write failure/);
  assert.equal(operation.disk.get('review-fixture'), old.record);
  assert.equal(manager.runtime.loaded.get('review-fixture').record, old.record);
  assert.equal(manager.options['review-fixture'].value, 7);
});

test('persistent first-write failure preserves the intact old package without deleting it', async () => {
  const old = await fixture();
  const item = await fixture('review-fixture', '2.0.0');
  const manager = managerFor([old.record], ['review-fixture']);
  const operation = installation(manager, [item], { storeMod: async () => { throw Error('Storage write unavailable'); } });
  await assert.rejects(operation.install(), error => /Storage write unavailable/.test(error.message) && error.rolledBack === true);
  assert.equal(manager.records.get('review-fixture'), old.record);
  assert.equal(operation.disk.get('review-fixture'), old.record);
  assert.equal(await operation.journal.read(), undefined);
});

test('journal save failure leaves the old package and runtime unchanged', async () => {
  const old = await fixture();
  const item = await fixture('review-fixture', '2.0.0');
  const manager = managerFor([old.record], ['review-fixture']);
  const operation = installation(manager, [item], { journal: { read: async () => undefined, save: async () => { throw Error('Backup storage full'); } } });
  await assert.rejects(operation.install(), /Backup storage full/);
  assert.equal(manager.runtime.loaded.get('review-fixture').record, old.record);
  assert.equal(operation.disk.get('review-fixture'), old.record);
  assert.equal(operation.writes.length, 0);
});

test('partially written update retains a durable backup and reports the actual installed version', async context => {
  context.mock.method(console, 'error', () => {});
  const childOld = await fixture('child');
  const parentOld = await fixture('parent');
  const child = await fixture('child', '2.0.0');
  const parent = await fixture('parent', '2.0.0', ['child']);
  const manager = managerFor([parentOld.record]);
  const operation = installation(manager, [parent, child]);
  let writeCount = 0;
  operation.options.storeMod = async record => {
    writeCount++;
    if (writeCount >= 2) throw Error('Persistent write failure');
    operation.disk.set(record.manifest.id, record);
  };
  operation.options.deleteMod = async () => { throw Error('Cannot remove new package'); };
  await assert.rejects(operation.install(), error => error.recoveryPending === true);
  const backup = await operation.journal.read();
  assert.ok(backup);
  assert.equal(manager.records.get('child').manifest.version, '2.0.0');
  assert.equal(manager.records.get('parent').manifest.version, '1.0.0');
  assert.ok(manager.errors.get('child'));
  assert.equal(new Map(backup.snapshots).get('parent').record.manifest.version, '1.0.0');
  operation.options.storeMod = async record => operation.disk.set(record.manifest.id, record);
  operation.options.deleteMod = async id => operation.disk.delete(id);
  const failures = await restoreMarketBackup(operation.options, backup);
  assert.deepEqual(failures, []);
  assert.equal(operation.disk.has('child'), false);
  assert.equal(operation.disk.get('parent').manifest.version, '1.0.0');
  assert.equal(childOld.record.manifest.version, '1.0.0');
});

test('overwritten old package remains recoverable when restoring its previous bytes fails', async context => {
  context.mock.method(console, 'error', () => {});
  const old = await fixture();
  const item = await fixture('review-fixture', '2.0.0');
  const manager = managerFor([old.record], ['review-fixture']);
  const operation = installation(manager, [item], { review: async () => ({ accepted: true, restore: true }) });
  manager.runtime.load = async () => { throw Error('Activation failed'); };
  operation.options.storeMod = async record => {
    if (record.manifest.version === '1.0.0') throw Error('Cannot restore old bytes yet');
    operation.disk.set(record.manifest.id, record);
  };
  await assert.rejects(operation.install(), error => error.recoveryPending === true);
  assert.equal(manager.records.get('review-fixture').manifest.version, '2.0.0');
  assert.equal(manager.runtime.loaded.has('review-fixture'), false);
  const backup = await operation.journal.read();
  assert.equal(new Map(backup.snapshots).get('review-fixture').record.manifest.version, '1.0.0');
  operation.options.storeMod = async record => operation.disk.set(record.manifest.id, record);
  assert.deepEqual(await restoreMarketBackup(operation.options, backup), []);
  assert.equal(operation.disk.get('review-fixture').manifest.version, '1.0.0');
});

test('pending recovery prevents starting another installation', async () => {
  const item = await fixture();
  const operation = installation(managerFor(), [item]);
  await operation.journal.save({ targets: [] });
  await assert.rejects(operation.install(), error => error.recoveryPending === true);
  assert.equal(operation.reviews.length, 0);
  assert.equal(operation.writes.length, 0);
});

test('abort during unzip prevents all installation writes', async () => {
  const item = await fixture();
  const operation = installation(managerFor(), [item]);
  operation.options.readZip = async (...args) => { operation.controller.abort(); return readZip(...args); };
  await assert.rejects(operation.install(), { name: 'AbortError' });
  assert.equal(operation.writes.length, 0);
  assert.equal(operation.disk.size, 0);
});

test('concurrent installation is refused by manager busy state', async () => {
  const item = await fixture();
  const manager = managerFor();
  manager.busy = true;
  const operation = installation(manager, [item]);
  await assert.rejects(operation.install(), /正在处理|busy/);
  assert.equal(manager.busy, true);
});

test('market cannot replace itself or a built-in package', async () => {
  const self = await fixture('rpen-mod-market');
  const operation = installation(managerFor(), [self]);
  await assert.rejects(operation.install(), /Reserved/);
  const builtin = await fixture('builtin');
  builtin.record.builtin = true;
  const next = installation(managerFor([builtin.record]), [builtin]);
  await assert.rejects(next.install(), /Reserved/);
});

test('update checks exclude private local mods unless manually selected', async () => {
  const remote = await fixture('remote', '1.0.0', [], { market: { id: 'remote', api: 'https://market.example/api.php' } });
  const local = await fixture('private-local');
  const own = await fixture('rpen-mod-market');
  const manager = managerFor([remote.record, local.record, own.record]);
  const requests = [];
  const market = createModMarket({ manager, marketUrl: () => 'https://market.example/', mount: node => node,
    transport: { close() {}, async json(action, data) { requests.push({ action, data }); return { items: [] }; } } });
  await market.check();
  assert.deepEqual(requests[0].data.installed.map(item => item.id), ['remote']);
  market.setScope('selected', ['private-local']);
  await market.check();
  assert.deepEqual(requests[1].data.installed.map(item => item.id), ['private-local']);
  market.dispose();
});

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(text) { this.sent = JSON.parse(text); }
  respond(data) { this.onmessage?.({ data: JSON.stringify({ request: this.sent.request, type: 'json', result: { ok: true, data } }) }); }
}

function transportFor(options = {}) {
  FakeSocket.instances = [];
  return marketSocket(() => 'wss://market.example/socket', { WebSocketClass: FakeSocket, connectTimeout: 30, requestTimeout: 30, ...options });
}

test('close during connection rejects immediately and cancels queued jobs', async () => {
  const transport = transportFor();
  const first = transport.json('first');
  const second = transport.json('second');
  await wait(0);
  transport.close();
  await assert.rejects(first, { name: 'AbortError' });
  await assert.rejects(second, { name: 'AbortError' });
  await wait(0);
  assert.equal(FakeSocket.instances.length, 1);
  await assert.rejects(transport.json('third'), { name: 'AbortError' });
});

test('connection timeout and request timeout reject instead of hanging', async () => {
  let transport = transportFor();
  await assert.rejects(transport.json('categories'), /connection timed out/);
  transport.close();
  transport = transportFor();
  const request = transport.json('categories');
  await wait(0);
  FakeSocket.instances[0].open();
  await assert.rejects(request, /request timed out/);
  transport.close();
});

test('malformed JSON rejects the request without throwing from message handler', async () => {
  const transport = transportFor();
  const request = transport.json('categories');
  await wait(0);
  const socket = FakeSocket.instances[0];
  socket.open();
  await wait(0);
  assert.doesNotThrow(() => socket.onmessage({ data: 'not-json' }));
  await assert.rejects(request, SyntaxError);
  transport.close();
});

test('aborting an active request permits a later fresh request', async () => {
  const transport = transportFor();
  const controller = new AbortController();
  const first = transport.json('first', undefined, {}, { signal: controller.signal });
  await wait(0);
  FakeSocket.instances[0].open();
  await wait(0);
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  const second = transport.json('second');
  await wait(0);
  const next = FakeSocket.instances[1];
  next.open();
  await wait(0);
  next.respond(['ok']);
  assert.deepEqual(await second, ['ok']);
  transport.close();
});

test('changing the configured socket URL reconnects at the new endpoint', async () => {
  FakeSocket.instances = [];
  let endpoint = 'wss://old.example/socket';
  const transport = marketSocket(() => endpoint, { WebSocketClass: FakeSocket, connectTimeout: 50, requestTimeout: 50 });
  const first = transport.json('first');
  await wait(0);
  const socket = FakeSocket.instances[0];
  socket.open();
  await wait(0);
  socket.respond([]);
  await first;
  endpoint = 'wss://new.example/socket';
  const next = transport.json('check-updates', { installed: ['private-local'] });
  await wait(0);
  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(socket.readyState, 3);
  const newSocket = FakeSocket.instances[1];
  assert.equal(newSocket.url, 'wss://new.example/socket');
  newSocket.open();
  await wait(0);
  assert.equal(newSocket.sent.action, 'check-updates');
  newSocket.respond({ items: [] });
  await next;
  transport.close();
});

test('explicit endpoint refresh cancels active and queued requests at the old server', async () => {
  FakeSocket.instances = [];
  let endpoint = 'wss://old.example/socket';
  const transport = marketSocket(() => endpoint, { WebSocketClass: FakeSocket, connectTimeout: 50, requestTimeout: 50 });
  const first = transport.json('first');
  const queued = transport.json('queued');
  await wait(0);
  FakeSocket.instances[0].open();
  await wait(0);
  endpoint = 'wss://new.example/socket';
  transport.refresh();
  await assert.rejects(first, { name: 'AbortError' });
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(transport.endpoint(), endpoint);
  transport.close();
});

test('正常取消不会累计宿主模组故障，真实异常仍然上报', async () => {
  const failures = [];
  const scope = new ModScope(error => failures.push(error));
  const cancelled = scope.wrap(() => runMarketTask(() => Promise.reject(new DOMException('Cancelled', 'AbortError'))));
  for (let attempt = 0; attempt < 6; attempt++) await cancelled();
  assert.deepEqual(failures, []);
  const failure = new Error('Actual failure');
  const broken = scope.wrap(() => runMarketTask(() => Promise.reject(failure)));
  await assert.rejects(broken(), error => error === failure);
  assert.deepEqual(failures, [failure]);
  scope.dispose();
});

test('市场文案和第三方多语言清单名称对应当前界面语言', context => {
  context.after(() => configureMarketText('zh-CN'));
  const name = { 'zh-CN': '测试模组', 'en-US': 'Test mod' };
  configureMarketText('en-US');
  assert.equal(marketText('openMarket'), 'Mod market');
  assert.equal(marketName(name), 'Test mod');
  assert.match(marketText('updateDisclosure', { endpoint: 'wss://example.test' }), /wss:\/\/example\.test/);
  configureMarketText('zh-CN');
  assert.equal(marketText('openMarket'), '模组市场');
  assert.equal(marketName(name), '测试模组');
  assert.equal(marketText('updatesAvailable', { count: 3 }), '更新 · 3');
  assert.deepEqual(name, { 'zh-CN': '测试模组', 'en-US': 'Test mod' });
});
