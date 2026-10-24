import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { audioSetupTarget, extractAudioSetupTool, prepareAudioPython, separationSetupSupport } from '../desktop/audio-setup.mjs';
import { AudioSeparationService, installAudioSeparation } from '../desktop/audio-separation.mjs';
import { PythonAudioRuntime } from '../desktop/python-audio-runtime.mjs';
import { writeZip } from '../src/platform/archive.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(context) { const root = await mkdtemp(join(tmpdir(), 'rpen-setup-')); context.after(() => rm(root, { recursive: true, force: true })); return root; }

test('安装工具固定每个平台的版本与哈希，未知平台不假装支持', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) for (const arch of ['x64', 'arm64']) { const target = audioSetupTarget(platform, arch); assert.match(target.sha256, /^[a-f0-9]{64}$/); assert.ok(target.url.startsWith('https://github.com/astral-sh/uv/releases/download/0.13.5/')); assert.equal(target.pythonVersion, '3.12.14'); }
  assert.equal(audioSetupTarget('linux', 'ia32'), null);
  assert.equal(separationSetupSupport('win32', 'x64').supported, true); assert.equal(separationSetupSupport('darwin', 'arm64').supported, true); assert.equal(separationSetupSupport('darwin', 'x64').supported, false); assert.equal(separationSetupSupport('linux', 'arm64').supported, false);
  const binary = new Uint8Array([1, 2, 3]), zip = new Uint8Array(await writeZip(new Map([['uv.exe', binary], ['uvx.exe', new Uint8Array([9])]])).arrayBuffer()), target = { filename: 'uv-test.zip', sha256: hash(zip) };
  assert.deepEqual(await extractAudioSetupTool(zip, target), binary); await assert.rejects(extractAudioSetupTool(zip, { ...target, sha256: '0'.repeat(64) }), /校验/);
  const tar = Buffer.alloc(2048); tar.write('uv-test/uv', 0); tar.write('00000000003\0', 124); tar[156] = 48; tar.set(binary, 512); const archive = gzipSync(tar); assert.deepEqual([...await extractAudioSetupTool(archive, { filename: 'uv-test.tar.gz', sha256: hash(archive) })], [...binary]);
});

test('自动Python只安装在私有目录，不改PATH/注册表；已校验工具复用，错误和取消可中止', async context => {
  const root = await fixture(context), binary = new Uint8Array([1, 2, 3]), archive = new Uint8Array(await writeZip(new Map([['uv.exe', binary]])).arrayBuffer()), target = { ...audioSetupTarget('win32', 'x64'), sha256: hash(archive) }, calls = []; let downloads = 0;
  const python = join(root, 'python', 'cpython-3.12', 'python.exe'); await mkdir(join(root, 'python', 'cpython-3.12'), { recursive: true }); await writeFile(python, 'fixture');
  const runtime = { root, progress: () => {}, environment: () => ({ PATH: 'original' }), run: async (executable, args, options) => { calls.push({ executable, args, options }); if (args[1] === 'find') return python; } }, fetcher = async () => { downloads++; return new Response(archive); };
  assert.equal(await prepareAudioPython(runtime, undefined, { target, fetcher }), python); assert.equal(downloads, 1);
  const install = calls.find(call => call.args[1] === 'install'); assert.ok(install.args.includes('--no-bin')); assert.ok(install.args.includes('--no-registry')); assert.equal(install.options.env.PATH, 'original'); assert.equal(install.options.env.UV_PYTHON_INSTALL_DIR, join(root, 'python'));
  await prepareAudioPython(runtime, undefined, { target, fetcher }); assert.equal(downloads, 1);
  const controller = new AbortController(); controller.abort(); await assert.rejects(prepareAudioPython(runtime, controller.signal, { target, fetcher }), { name: 'AbortError' });
  await assert.rejects(prepareAudioPython(runtime, undefined, { target: null, fetcher }), /暂不支持/);
  await writeFile(join(root, 'bootstrap', '0.13.5', 'uv.exe'), 'modified'); await prepareAudioPython(runtime, undefined, { target, fetcher }); assert.equal(downloads, 2);
});

test('一键安装成功后才更新配置，失败保留旧环境，手动安装与运行任务互斥', async context => {
  const root = await fixture(context), stages = [], service = new AudioSeparationService(root, { script: 'fixture', preparePython: async () => process.execPath, progress: value => stages.push(value.stage) });
  const calls = []; service.run = async (executable, args) => { calls.push(args); if (args[1] === 'venv') { const directory = join(args.at(-1), process.platform === 'win32' ? 'Scripts' : 'bin'); await mkdir(directory, { recursive: true }); await writeFile(join(directory, process.platform === 'win32' ? 'python.exe' : 'python'), 'fixture'); } if (args[0] === '-u') return { demucs: '4.1.0', python: '3.12.14', cuda: false }; };
  await service.configure(process.execPath); const before = await readFile(join(root, 'config.json'), 'utf8');
  const installed = await service.install(); assert.equal(installed.ready, true); assert.ok(installed.pythonPath.includes('managed-runtime-v1')); assert.ok(calls.some(args => args.includes('torch==2.10.0+cpu') && args.includes('https://download.pytorch.org/whl/cpu'))); assert.ok(stages.includes('checking'));
  service.python = process.execPath; await service.configure(process.execPath); service.run = async () => { throw Error('download failed'); }; await assert.rejects(service.install(), /download failed/); assert.equal(await readFile(join(root, 'config.json'), 'utf8'), before); assert.equal(service.installing, false);
  service.jobs.set('busy', {}); await assert.rejects(service.install(), /已有/); service.jobs.clear();
  const controller = new AbortController(); service.preparePython = async (runtime, signal) => { assert.equal(signal.aborted, true); throw Object.assign(Error('cancelled'), { name: 'AbortError' }); }; controller.abort(); await assert.rejects(service.install(undefined, controller.signal), { name: 'AbortError' });
});

test('点击一键安装只需原生确认，无需用户选择Python；取消不下载，选择已有环境先验证', async () => {
  const handlers = new Map(), sender = { mainFrame: { url: 'rpe://app/' } }, calls = [], service = { install: async (...args) => { calls.push(['install', ...args]); return { ready: true }; }, checkEnvironment: async () => { throw Error('not valid'); }, configure: async () => { calls.push(['configure']); } }; let response = 0, pickers = 0;
  installAudioSeparation({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, service, origin: 'rpe://app', window: () => ({ webContents: sender }), dialog: { showMessageBox: async () => ({ response }), showOpenDialog: async () => { pickers++; return { canceled: false, filePaths: [process.execPath] }; } } });
  const handle = (action, event = { sender, senderFrame: sender.mainFrame }) => handlers.get('rpen-audio-separation')(event, { action });
  assert.equal((await handle('install')).ok, true); assert.deepEqual(calls[0], ['install', undefined, undefined, false]); assert.equal(pickers, 0);
  response = 2; assert.equal((await handle('install')).result, null); assert.equal(calls.length, 1);
  assert.equal((await handle('choosePython')).ok, false); assert.equal(calls.length, 1); assert.equal((await handle('install', { sender: {}, senderFrame: {} })).ok, false);
});

test('Python工具可读取受限纯文本路径输出且不影响JSON推理消息', async context => {
  const root = await fixture(context), runtime = new PythonAudioRuntime(root), text = await runtime.run(process.execPath, ['-e', 'process.stdout.write("C:/private/python.exe\\n")'], { outputFormat: 'text' }); assert.equal(text, 'C:/private/python.exe');
  assert.equal((await runtime.run(process.execPath, ['-e', 'console.log(JSON.stringify({kind:"result",ready:true}))'])).ready, true);
});
