import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { AudioStorage, installAudioStorage, withAudioStorage } from '../desktop/audio-storage.mjs';
import { AudioSeparationService, installAudioSeparation } from '../desktop/audio-separation.mjs';
import { AudioOnsetService, installAudioOnsets } from '../desktop/audio-onsets.mjs';
import { AudioMapperService, installAudioMapper } from '../desktop/audio-mapper.mjs';

async function fixture(context, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rpen-audio-storage-')); context.after(() => rm(root, { recursive: true, force: true }));
  const roots = Object.fromEntries(['separation', 'onsets', 'mapper'].map(id => [id, join(root, 'original', 'audio-' + id)]));
  const classes = { separation: AudioSeparationService, onsets: AudioOnsetService, mapper: AudioMapperService };
  const config = join(root, 'profile', 'audio-storage.json'), parent = join(root, 'destination'); await mkdir(parent);
  const storage = await new AudioStorage(config, roots, options).initialize(), services = {}, originals = new Map();
  for (const [id, location] of Object.entries(roots)) {
    const service = services[id] = new classes[id](location, { script: 'fixture', python: process.execPath }); storage.attach(id, service); await service.initialize();
    for (const [name, bytes] of [['models/中文模型.bin', Buffer.alloc(2048, 41)], ['cache/example/result.bin', Buffer.alloc(512, 82)], ['pip-cache/package.whl', Buffer.alloc(128, 27)], ['download-cache/fetched.bin', Buffer.alloc(48, 6)], ['kernel-cache/compiled.bin', Buffer.alloc(48, 8)], ['runtime/keep.txt', Buffer.from('runtime')], ['unrelated.txt', Buffer.from('user file')]]) {
      const path = join(location, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, bytes); originals.set(path, bytes);
    }
    service.results.set('existing', join(location, 'cache', 'example'));
    await service.configure(process.execPath);
  }
  return { root, roots, parent, config, storage, services, originals };
}

test('三套工具整体迁移模型和各类缓存，校验后清理原副本，保留环境、配置和其他文件', async context => {
  const { root, roots, parent, config, storage, services, originals } = await fixture(context), result = await storage.migrate(parent);
  assert.equal(result.migrating, false); assert.equal(result.warnings.length, 0); assert.equal(result.files, 15); assert.ok(result.bytes > 0);
  for (const [id, service] of Object.entries(services)) {
    const next = join(parent, 'RPEN-Audio', 'audio-' + id); assert.equal(service.dataRoot, next); assert.equal(service.root, roots[id]);
    assert.equal(await service.configuredPython(), process.execPath); assert.equal(service.results.get('existing'), join(next, 'cache', 'example'));
    const env = service.environment(); assert.equal(env.TORCH_HOME, join(next, 'models', 'torch')); assert.equal(env.HF_HOME, join(next, 'models', 'huggingface'));
    for (const key of ['TEMP', 'TMP', 'TMPDIR', 'PIP_CACHE_DIR', 'TORCHINDUCTOR_CACHE_DIR', 'CUDA_CACHE_PATH', 'XDG_CACHE_HOME']) assert.ok(env[key].startsWith(next));
    for (const name of ['models/中文模型.bin', 'cache/example/result.bin', 'pip-cache/package.whl', 'download-cache/fetched.bin', 'kernel-cache/compiled.bin']) {
      assert.deepEqual(await readFile(join(next, name)), originals.get(join(roots[id], name))); await assert.rejects(lstat(join(roots[id], name)), { code: 'ENOENT' });
    }
    assert.equal(await readFile(join(roots[id], 'runtime', 'keep.txt'), 'utf8'), 'runtime'); assert.equal(await readFile(join(roots[id], 'unrelated.txt'), 'utf8'), 'user file');
    assert.equal(JSON.parse(await readFile(join(roots[id], 'config.json'), 'utf8')).python, process.execPath);
  }
  const resumed = await new AudioStorage(config, roots).initialize(); assert.equal(resumed.error, undefined); assert.deepEqual(resumed.paths, storage.paths); assert.equal(resumed.warnings.length, 0);
  const second = join(root, 'another destination'); await mkdir(second); await resumed.migrate(second);
  assert.equal(await readFile(join(second, 'RPEN-Audio', 'audio-mapper', 'models', '中文模型.bin'), 'utf8'), originals.get(join(roots.mapper, 'models', '中文模型.bin')).toString());
});

test('迁移后已有声部句柄仍可读取，新任务写入新目录，结果仍可持久复用', async context => {
  const { storage, services, parent } = await fixture(context), service = services.separation;
  let runs = 0; service.run = async (python, args) => {
    runs++; const request = JSON.parse(await readFile(args.at(-1), 'utf8')), sources = [];
    for (const id of ['vocals', 'drums', 'bass', 'other']) { await writeFile(join(request.output, id + '.wav'), Buffer.alloc(100, 3)); sources.push({ id, bytes: 100, frames: 12000, sampleRate: 12000 }); }
    return { model: request.model, sources };
  };
  const separate = async () => { const token = await withAudioStorage(service, () => service.begin({ id: 'test', bytes: 100 })); await withAudioStorage(service, () => service.write(token, 0, new Uint8Array(100))); return withAudioStorage(service, () => service.execute(token)); };
  const first = await separate(); await storage.migrate(parent);
  assert.deepEqual(await service.read(first.cacheId, 'drums', 0, 32), new Uint8Array(32).fill(3));
  const again = await separate(); assert.equal(again.cacheHit, true); assert.equal(runs, 1);
  assert.equal((await readdir(join(service.dataRoot, 'jobs'))).length, 0);
  await service.clear(); await assert.rejects(service.read(first.cacheId, 'drums', 0, 32), /无效/);
});

test('任务、安装、未完成请求和迁移互斥，禁止在目录切换期间使用三套工具', async context => {
  const { storage, services, parent } = await fixture(context);
  services.separation.jobs.set('active', {}); await assert.rejects(storage.migrate(parent), { name: 'StorageBusyError' }); services.separation.jobs.clear();
  services.mapper.installing = true; await assert.rejects(storage.migrate(parent), { name: 'StorageBusyError' }); services.mapper.installing = false;
  services.onsets.beginning = true; await assert.rejects(storage.migrate(parent), { name: 'StorageBusyError' }); services.onsets.beginning = false;
  let resume, started; const ready = new Promise(resolve => { started = resolve; });
  const request = storage.access(() => { started(); return new Promise(resolve => { resume = resolve; }); }); await ready;
  await assert.rejects(storage.migrate(parent), { name: 'StorageBusyError' }); resume(); await request;
  let release; storage.fault = async phase => { if (phase === 'beforeCommit') { await new Promise(resolve => { release = resolve; }); } };
  const migrating = storage.migrate(parent); while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(withAudioStorage(services.mapper, () => services.mapper.probe()), { name: 'StorageBusyError' }); await assert.rejects(storage.migrate(parent), { name: 'StorageBusyError' });
  release(); await migrating;
});

test('空间不足、目录重叠和已有目标均不改写配置、不覆盖文件、不删除源文件', async context => {
  const { storage, roots, parent, config } = await fixture(context, { availableSpace: async () => 1n });
  await assert.rejects(storage.migrate(parent), /空间不足/); await assert.rejects(lstat(join(parent, 'RPEN-Audio')), { code: 'ENOENT' });
  storage.availableSpace = async () => 1024n ** 4n;
  await assert.rejects(storage.migrate(roots.separation), /相互包含/);
  await mkdir(join(parent, 'RPEN-Audio')); await writeFile(join(parent, 'RPEN-Audio', 'keep.txt'), 'do not overwrite');
  await assert.rejects(storage.migrate(parent), /不会覆盖/); assert.equal(await readFile(join(parent, 'RPEN-Audio', 'keep.txt'), 'utf8'), 'do not overwrite');
  await assert.rejects(readFile(config), { code: 'ENOENT' }); assert.equal((await readFile(join(roots.separation, 'models', '中文模型.bin'))).length, 2048);
});

for (const phase of ['copied', 'beforeCommit']) test('迁移在 ' + phase + ' 阶段失败时保留全部原文件和原位置，中断记录可恢复识别', async context => {
  const { storage, originals, roots, parent, config } = await fixture(context, { fault: async step => { if (step === phase) throw Error('simulated failure'); } });
  await assert.rejects(storage.migrate(parent), /未切换存储位置/); assert.equal(storage.migrating, false); assert.deepEqual(storage.paths, roots);
  for (const [path, bytes] of originals) assert.deepEqual(await readFile(path), bytes);
  await assert.rejects(readFile(config), { code: 'ENOENT' });
  const resumed = await new AudioStorage(config, roots).initialize(); assert.deepEqual(resumed.paths, roots); assert.match(resumed.warnings[0], /未完成/);
});

test('副本损坏或原文件变化时不切换位置；切换后清理失败继续使用已验证的新副本', async context => {
  const first = await fixture(context, { fault: async (phase, { target }) => { if (phase === 'copied') await writeFile(target, 'corrupt'); } });
  await assert.rejects(first.storage.migrate(first.parent), /校验失败/); assert.deepEqual(first.storage.paths, first.roots);
  const second = await fixture(context, { fault: async phase => { if (phase === 'afterCommit') throw Error('cleanup denied'); } });
  const result = await second.storage.migrate(second.parent); assert.match(result.warnings[0], /部分原缓存保留/);
  assert.equal((await readFile(join(second.roots.separation, 'models', '中文模型.bin'))).length, 2048);
  const resumed = await new AudioStorage(second.config, second.roots).initialize(); assert.deepEqual(resumed.paths, second.storage.paths); assert.equal(resumed.error, undefined);
  const third = await fixture(context, { fault: async (phase, { source }) => { if (phase === 'copied') await writeFile(source, 'source was changed'); } });
  await assert.rejects(third.storage.migrate(third.parent), /原文件在迁移期间发生变化/); assert.deepEqual(third.storage.paths, third.roots);
});

test('拒绝目录链接和越界文件链接，允许模型目录内的文件链接并复制为普通文件', async context => {
  const { storage, roots, parent, root } = await fixture(context), external = join(root, 'external'); await mkdir(external); await writeFile(join(external, 'secret'), 'external');
  await symlink(external, join(roots.separation, 'models', 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(storage.migrate(parent), /链接/); assert.equal(await readFile(join(external, 'secret'), 'utf8'), 'external');
  await rm(join(roots.separation, 'models', 'junction'));
  try { await symlink(join(external, 'secret'), join(roots.separation, 'models', 'outside.bin'), 'file'); } catch (error) { if (error.code === 'EPERM') { context.diagnostic('本机未授予文件符号链接权限；目录链接拦截已验证'); return; } throw error; }
  await assert.rejects(storage.migrate(parent), /链接/); await rm(join(roots.separation, 'models', 'outside.bin'));
  const target = join(roots.separation, 'models', '中文模型.bin'), link = join(roots.separation, 'models', 'snapshot.bin'); await symlink(relative(join(link, '..'), target), link, 'file');
  await storage.migrate(parent); const copied = join(parent, 'RPEN-Audio', 'audio-separation', 'models', 'snapshot.bin');
  assert.equal((await lstat(copied)).isSymbolicLink(), false); assert.equal((await readFile(copied)).length, 2048);
});

test('迁移目录丢失或被替换时阻止写入，不静默回到系统盘', async context => {
  const { storage, roots, config, parent } = await fixture(context); await storage.migrate(parent);
  await rename(join(parent, 'RPEN-Audio'), join(parent, 'RPEN-Audio-unavailable'));
  const resumed = await new AudioStorage(config, roots).initialize(); assert.match(resumed.error, /目录不可用/); assert.equal(resumed.paths.separation, join(parent, 'RPEN-Audio', 'audio-separation'));
  await assert.rejects(resumed.access(() => {}), /目录不可用/); await assert.rejects(lstat(join(roots.separation, 'cache')), { code: 'ENOENT' });
});

test('存储 IPC 只接受当前窗口主框架，路径来自原生选择，取消和错误均有明确返回', async context => {
  const { storage, parent } = await fixture(context), handlers = new Map(), sender = { mainFrame: { url: 'rpe://app/' } }, opened = []; let canceled = false, response = 1, picks = 0;
  installAudioStorage({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, service: storage, origin: 'rpe://app', window: () => ({ webContents: sender }), shell: { openPath: async path => { opened.push(path); return ''; } }, dialog: { showOpenDialog: async () => { picks++; return { canceled, filePaths: [parent] }; }, showMessageBox: async () => ({ response }) } });
  const handle = (request, event = { sender, senderFrame: sender.mainFrame }) => handlers.get('rpen-audio-storage')(event, request);
  assert.equal((await handle({ action: 'migrate' }, { sender: {}, senderFrame: {} })).ok, false); assert.equal(picks, 0);
  assert.equal((await handle({ action: 'status' }, { sender, senderFrame: { url: 'rpe://app/' } })).ok, false);
  assert.equal((await handle({ action: 'status' })).result.tools.length, 3); assert.equal((await handle({ action: 'open', id: '../bad', kind: 'root' })).ok, false);
  assert.equal((await handle({ action: 'open', id: 'separation', kind: 'models' })).ok, true); assert.equal(opened.length, 1);
  canceled = true; assert.equal((await handle({ action: 'migrate' })).result, null); canceled = false;
  assert.equal((await handle({ action: 'migrate' })).result, null); response = 0;
  assert.equal((await handle({ action: 'migrate', path: '/ignored' })).ok, true); assert.equal(storage.location, join(parent, 'RPEN-Audio'));
});

test('音频 IPC 操作全程占用共享锁，迁移时所有后端拒绝启动任务', async context => {
  const { storage, services } = await fixture(context), handlers = new Map(), sender = { mainFrame: { url: 'rpe://app/' } };
  for (const [id, install, channel] of [['separation', installAudioSeparation, 'rpen-audio-separation'], ['onsets', installAudioOnsets, 'rpen-audio-onsets'], ['mapper', installAudioMapper, 'rpen-audio-mapper']]) {
    const service = services[id]; service.probe = async () => { assert.equal(storage.active, 1); return { ready: true }; };
    install({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, service, origin: 'rpe://app', window: () => ({ webContents: sender }), dialog: {} });
    const handle = () => handlers.get(channel)({ sender, senderFrame: sender.mainFrame }, { action: 'probe' });
    assert.equal((await handle()).ok, true); assert.equal(storage.active, 0); storage.migrating = true;
    assert.equal((await handle()).error.name, 'StorageBusyError'); storage.migrating = false;
  }
});

function storageBridge(storage, parent, choices = {}) {
  const handlers = new Map(), sender = { mainFrame: { url: 'rpe://app/' } }, questions = [], selections = [];
  installAudioStorage({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, service: storage, origin: 'rpe://app', window: () => ({ webContents: sender }), shell: { openPath: async () => '' }, dialog: {
    showMessageBox: async (_window, options) => { questions.push(options); return { response: choices.response ?? 0 }; },
    showOpenDialog: async (_window, options) => { selections.push(options); return { canceled: choices.canceled ?? false, filePaths: [parent] }; }
  } });
  return { questions, selections, call: action => handlers.get('rpen-audio-storage')({ sender, senderFrame: sender.mainFrame }, { action }) };
}

test('首次使用必须选择位置，取消引导或目录选择均不启动任务，并发任务只显示一次引导', async context => {
  const { storage, services, parent, config } = await fixture(context), choices = { response: 1 }, bridge = storageBridge(storage, parent, choices); let started = 0;
  const begin = () => withAudioStorage(services.separation, async () => { started++; }, 'begin');
  await assert.rejects(begin(), { name: 'AbortError' }); assert.equal(started, 0); assert.equal(bridge.selections.length, 0); assert.equal(storage.status().needsSetup, true);
  choices.response = 0; choices.canceled = true; await assert.rejects(begin(), { name: 'AbortError' }); await assert.rejects(readFile(config), { code: 'ENOENT' });
  choices.canceled = false; const before = bridge.questions.length;
  await Promise.all([begin(), begin(), begin()]); assert.equal(started, 3); assert.equal(bridge.questions.length, before + 1); assert.equal(storage.status().needsSetup, false);
  assert.match(bridge.questions.at(-1).detail, /数 GB 至数十 GB/); assert.match(bridge.questions.at(-1).detail, /非系统盘/);
  await begin(); assert.equal(bridge.questions.length, before + 1);
});

test('首次选择将尚未安装的环境也放在所选目录，重启与后续缓存迁移保留正确环境路径', async context => {
  const { storage, roots, services, parent, config, root } = await fixture(context);
  for (const location of Object.values(roots)) { await rm(join(location, 'runtime'), { recursive: true }); await rm(join(location, 'config.json')); }
  const bridge = storageBridge(storage, parent); assert.equal((await bridge.call('prepare')).result, true);
  for (const [id, service] of Object.entries(services)) {
    assert.equal(service.root, join(parent, 'RPEN-Audio', 'audio-' + id)); await service.configure(process.execPath);
    await assert.rejects(readFile(join(roots[id], 'config.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(service.root, 'config.json'), 'utf8')).python, process.execPath);
  }
  const resumed = await new AudioStorage(config, roots).initialize(); assert.equal(resumed.status().needsSetup, false); assert.deepEqual(resumed.roots, storage.roots);
  const second = join(root, 'later-cache-location'); await mkdir(second); await resumed.migrate(second);
  const restored = await new AudioStorage(config, roots).initialize(); assert.deepEqual(restored.roots, storage.roots); assert.equal(restored.paths.separation, join(second, 'RPEN-Audio', 'audio-separation'));
});

test('首次位置设置保留已安装环境和外部 Python 路径，原有迁移配置不重复引导', async context => {
  const { storage, roots, services, parent, config } = await fixture(context), bridge = storageBridge(storage, parent);
  assert.equal((await bridge.call('prepare')).result, true); assert.deepEqual(storage.roots, roots);
  for (const service of Object.values(services)) assert.equal(await service.configuredPython(), process.execPath);
  const saved = JSON.parse(await readFile(config, 'utf8')); delete saved.runtimeRoots; await writeFile(config, JSON.stringify(saved));
  const resumed = await new AudioStorage(config, roots).initialize(), later = storageBridge(resumed, parent); assert.equal((await later.call('prepare')).result, true); assert.equal(later.questions.length, 0);
});

test('全局清理覆盖不同谱面的声部分离、采音及下载缓存，模型、环境、谱面和原音乐保留', async context => {
  const { storage, roots, services } = await fixture(context), events = []; storage.progress = value => events.push(value);
  for (const location of Object.values(roots)) for (const chart of ['chart-A', 'chart-B']) { await mkdir(join(location, 'cache', chart)); await writeFile(join(location, 'cache', chart, 'derived.wav'), 'cached stem or onsets'); }
  for (const location of Object.values(roots)) { await writeFile(join(location, 'chart.json'), 'original chart'); await writeFile(join(location, 'music.wav'), 'original music'); }
  const result = await storage.clearCaches(); assert.equal(result.warnings.length, 0); assert.ok(result.files >= 18); assert.ok(result.bytes > 0); assert.equal(storage.cleaning, false);
  for (const [id, location] of Object.entries(roots)) {
    for (const name of ['cache/chart-A/derived.wav', 'cache/chart-B/derived.wav', 'pip-cache/package.whl', 'download-cache/fetched.bin', 'kernel-cache/compiled.bin']) await assert.rejects(lstat(join(location, name)), { code: 'ENOENT' });
    assert.equal((await readFile(join(location, 'models', '中文模型.bin'))).length, 2048); assert.equal(await readFile(join(location, 'runtime', 'keep.txt'), 'utf8'), 'runtime');
    assert.equal(await readFile(join(location, 'chart.json'), 'utf8'), 'original chart'); assert.equal(await readFile(join(location, 'music.wav'), 'utf8'), 'original music'); assert.equal(await readFile(join(location, 'unrelated.txt'), 'utf8'), 'user file');
    assert.equal(services[id].results.size, 0); assert.ok((await lstat(join(location, 'temp'))).isDirectory());
  }
  assert.equal(events.at(-1).stage, 'cleared');
});

test('清理按钮必须二次确认，取消不删除；清理与迁移、安装、未完成任务互斥', async context => {
  const { storage, services, parent, roots } = await fixture(context), choices = { response: 1 }, bridge = storageBridge(storage, parent, choices);
  assert.equal((await bridge.call('clear')).result, null); assert.ok((await lstat(join(roots.separation, 'cache', 'example', 'result.bin'))).isFile());
  assert.match(bridge.questions[0].detail, /所有谱面/); assert.equal(bridge.questions[0].defaultId, 1);
  services.mapper.jobs.set('active', {}); await assert.rejects(storage.clearCaches(), { name: 'StorageBusyError' }); assert.equal((await bridge.call('clear')).error.name, 'StorageBusyError'); services.mapper.jobs.clear();
  services.onsets.installing = true; await assert.rejects(storage.clearCaches(), { name: 'StorageBusyError' }); services.onsets.installing = false;
  storage.migrating = true; await assert.rejects(storage.clearCaches(), { name: 'StorageBusyError' }); storage.migrating = false;
  let release; const originalFault = storage.fault; storage.fault = async phase => { if (phase === 'beforeClearFile' && !release) await new Promise(resolve => { release = resolve; }); };
  choices.response = 0; const pending = bridge.call('clear'); while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(storage.access(() => {}), { name: 'StorageBusyError' }); await assert.rejects(storage.migrate(parent), { name: 'StorageBusyError' }); release();
  assert.equal((await pending).ok, true); storage.fault = originalFault;
});

test('全局清理拒绝越界目录链接，保留占用或变化的文件，并处理已知原目录的遗留缓存', async context => {
  const { storage, roots, parent, root } = await fixture(context), external = join(root, 'outside'); await mkdir(external); await writeFile(join(external, 'keep'), 'external data');
  const link = join(roots.separation, 'cache', 'outside'); await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(storage.clearCaches(), /链接/); assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'external data'); await rm(link);
  await storage.migrate(parent); await mkdir(join(roots.separation, 'cache')); await writeFile(join(roots.separation, 'cache', 'leftover'), 'old cache');
  storage.fault = async (phase, { source }) => { if (phase === 'beforeClearFile' && source.endsWith('result.bin')) throw Error('file is busy'); };
  const result = await storage.clearCaches(); assert.ok(result.warnings.some(warning => /busy/.test(warning))); assert.equal(storage.cleaning, false);
  await assert.rejects(readFile(join(roots.separation, 'cache', 'leftover')), { code: 'ENOENT' }); assert.equal((await readFile(join(storage.paths.separation, 'cache', 'example', 'result.bin'))).length, 512);
  assert.equal((await readFile(join(storage.paths.separation, 'models', '中文模型.bin'))).length, 2048);
});
