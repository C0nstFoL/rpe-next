import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { AudioSeparationService, installAudioSeparation } from '../desktop/audio-separation.mjs';
import { LocalAudioSeparator } from '../src/platform/audio-separation.mjs';
import { SEPARATION_MODELS } from '../src/core/audio-sources.mjs';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'rpen-separation-')); context.after(() => rm(root, { recursive: true, force: true }));
  const service = new AudioSeparationService(root, { python: process.execPath, script: 'fixture' }); let runs = 0;
  service.run = async (python, args) => {
    runs++; const request = JSON.parse(await readFile(args.at(-1), 'utf8')), sources = [];
    for (const id of SEPARATION_MODELS.find(model => model.id === request.model).stems) { await writeFile(join(request.output, id + '.wav'), Buffer.alloc(100, 1)); sources.push({ id, bytes: 100, frames: 12000, sampleRate: 12000 }); }
    return { sources, model: request.model, sampleRate: 12000, frames: 12000 };
  };
  const input = async (options = {}) => { const token = await service.begin({ id: 'test', bytes: 100, ...options }); await service.write(token, 0, new Uint8Array(100).fill(3)); return token; };
  return { root, service, input, runs: () => runs };
}

test('本机分离完整上传后才启动，相同音频及参数复用持久缓存，模型改变分别保存', async context => {
  const { service, input, runs, root } = await fixture(context), first = await service.execute(await input()); assert.equal(first.sources.length, 4); assert.equal(runs(), 1);
  const second = await service.execute(await input()); assert.equal(runs(), 1); assert.notEqual(first.cacheId, second.cacheId);
  assert.equal((await service.read(first.cacheId, 'drums', 0, 60)).length, 60);
  await service.execute(await input({ model: 'htdemucs_6s' })); assert.equal(runs(), 2); assert.equal((await readdir(join(root, 'cache'))).length, 2);
  assert.equal((await readdir(join(root, 'jobs'))).length, 0);
  await service.clear(); await assert.rejects(service.read(first.cacheId, 'drums', 0, 20), /无效/);
});

test('分片、路径和执行参数受限，取消清理临时音频，缓存损坏时重新计算', async context => {
  const { service, input, runs, root } = await fixture(context);
  await assert.rejects(service.begin({ id: '../bad', bytes: 100 }), /参数/);
  await assert.rejects(service.begin({ id: 'ok', model: '../bad', bytes: 100 }), /参数/);
  const token = await service.begin({ id: 'test', bytes: 100 }); await assert.rejects(service.execute(token), /完整/); await assert.rejects(service.write(token, 1, new Uint8Array(10)), /分片/); await assert.rejects(service.begin({ id: 'second', bytes: 100 }), /已有/); await service.cancel(token); assert.equal(service.jobs.size, 0);
  const result = await service.execute(await input()); await assert.rejects(service.read(result.cacheId, '../secret', 0, 20), /参数/); await assert.rejects(service.read('unknown', 'drums', 0, 20), /参数/);
  const directory = join(root, 'cache', (await readdir(join(root, 'cache')))[0]); await writeFile(join(directory, 'drums.wav'), 'damaged');
  const repaired = await service.execute(await input()); assert.equal(repaired.cacheHit, false); assert.equal(runs(), 2); assert.equal((await service.read(repaired.cacheId, 'drums', 0, 20)).length, 20);
});

test('子进程按参数启动且可停止，不执行shell；IPC拒绝非当前主框架和任意操作', async context => {
  const { root } = await fixture(context), service = new AudioSeparationService(root);
  const result = await service.run(process.execPath, ['-e', 'console.log(JSON.stringify({kind:"result",value:3}))']); assert.equal(result.value, 3);
  const controller = new AbortController(), pending = service.run(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { signal: controller.signal }); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  const handlers = new Map(), sender = { mainFrame: { url: 'rpe://app/' } }; installAudioSeparation({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, service, origin: 'rpe://app', window: () => ({ webContents: sender }), dialog: {} }); const handle = handlers.get('rpen-audio-separation');
  assert.equal((await handle({ sender: {}, senderFrame: {} }, { action: 'clear' })).ok, false);
  assert.equal((await handle({ sender, senderFrame: { url: 'rpe://app/' } }, { action: 'probe' })).ok, false);
  assert.equal((await handle({ sender, senderFrame: sender.mainFrame }, { action: 'exec', args: ['bad'] })).ok, false);
});

test('网页端明确要求导入声部，不通过频带筛选冒充分离；停止先于上传', async () => {
  const separator = new LocalAudioSeparator(null); await assert.rejects(separator.call('probe'), /桌面端/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(separator.separate({}, {}, controller.signal), { name: 'AbortError' });
});
