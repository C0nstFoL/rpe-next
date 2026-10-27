import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, lstat, realpath, statfs } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validDictationPcm } from '../src/core/dictation.mjs';
import { downloadSpeechFile } from './dictation-download.mjs';

export const DICTATION_MODEL = Object.freeze({
  id: 'x-asr-480ms-zh-en-punct-int8-2026-06-05',
  folder: 'sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2',
  sha256: 'fa5f63d618e5a01526e275a358bb7772e403f84808a4769fba52cffd8160bf74',
  bytes: 133895136,
  files: ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt'],
});
const wrapperIntegrity = 'c/FGNV77jNWENxReoMrL3LCPGQFP4nV/B1uWqqx5pC2gUEkfu3Wxa9B9NLjt9qrC0xe/57JgamkZyvAeI2Wifw==';
const platformIntegrity = {
  'win32-x64': 'AAVPXTcuIoYKmkim2yclCtgIzqqMd2yGjs1XSB2nG2pmnC/T+tKV5nqXMZlwbdZgsN+dWVQaorSpQ69U5s5xKw==',
  'darwin-x64': 'Vya3QygqyGRds0VSJGobKBqf4gd8kO2QWGMIdt/tqJxSCjeEMWzpXWk999lmKOpRUow3h+DCU9lTH1tq8P3oRw==',
  'darwin-arm64': '4+r/37ZBRaqyJGUf1W4HVcC6roRTFU27b/rZEMBSr6MQRJWX2D3s04fosOhbAi3zYFvEVbuY9xEWmvMUPquPAg==',
  'linux-x64': 'Pp2McNdxRIIref6+nXKgkh3yPk02zl5/9xsCIzJopypmdtCGoMBII2MMsnf9ibwnFTVTlz+lhCn6YlwV2p5RRA==',
  'linux-arm64': 'Uv1nJufU6fFQ/81La4Jlh5qRt70L5pr+oQaliQ8DlOWHqWmH45EcOXhSsq5061iMt1TjGyRsqbvlhWtHUHKw9g==',
  'win32-arm64': 'IfdKVT7tT5xAnlBqNkc70amt+bbn2Wkg0v3hwzKZIIyzlsWIUT0U1eQ+90pE8U4CR0SxVAN1kCmv7dmmQ4o0Qg==',
};
export function dictationPackages(platform = process.platform, arch = process.arch) {
  const integrity = platformIntegrity[platform + '-' + arch];
  if (!integrity) throw Error('This platform does not have a local speech runtime');
  const version = platform === 'win32' && arch === 'arm64' ? '1.13.8' : '2.0.0';
  const native = 'sherpa-onnx-' + (platform === 'win32' ? 'win' : platform) + '-' + arch;
  return [['sherpa-onnx-node', version === '2.0.0' ? wrapperIntegrity : 'MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag=='], [native, integrity]].map(([name, digest]) => ({ name, version, url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, mirror: `https://registry.npmmirror.com/${name}/-/${name}-${version}.tgz`, integrity: digest }));
}
const aborted = () => Object.assign(Error('Dictation cancelled'), { name: 'AbortError' });
const exists = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const checkpoint = signal => { if (signal.aborted) throw aborted(); };
async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID();
  try { await writeFile(temporary, JSON.stringify(value)); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function extractSpeechPackage(compressed, target) {
  const bytes = await promisify(gunzip)(compressed, { maxOutputLength: 128 * 1024 ** 2 });
  let offset = 0, files = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const name = field(0, 100), prefix = field(345, 500), path = prefix ? prefix + '/' + name : name;
    const size = Number.parseInt(field(124, 136).trim(), 8), type = field(156, 157);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length || ++files > 512) throw Error('Invalid speech runtime archive');
    offset += 512;
    if (!['x', 'g'].includes(type)) {
      if (!path.startsWith('package/') || /[\\:\x00-\x1f]/.test(path) || path.split('/').some(part => part === '..')) throw Error('Speech runtime archive path escaped package');
      const relative = path.slice(8).replace(/\/$/, '');
      if (relative && type !== '5') {
        if (type && type !== '0') throw Error('Speech runtime archive contains a link or special file');
        const destination = resolve(target, relative);
        if (!destination.startsWith(resolve(target) + sep)) throw Error('Speech runtime archive path escaped package');
        await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes.subarray(offset, offset + size), { flag: 'wx' });
      }
    }
    offset += Math.ceil(size / 512) * 512;
  }
}

export class DictationService {
  constructor(configPath, { utilityProcess, progress = () => {}, fetcher = globalThis.fetch, permission = async () => true } = {}) {
    Object.assign(this, { configPath, utilityProcess, progress, fetcher, permission });
    this.pending = new Map(); this.controller = null; this.job = null;
  }
  async initialize() {
    const config = await readFile(this.configPath, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
    if (config) {
      if (config.version !== 1 || typeof config.root !== 'string' || resolve(config.root) !== config.root) throw Error('Invalid local dictation directory');
      this.root = config.root;
    }
    return this;
  }
  async status() {
    let ready = false;
    if (this.root) {
      try {
        const info = await lstat(this.root); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Speech directory is unavailable');
        const manifest = JSON.parse(await readFile(join(this.root, 'installed.json'), 'utf8'));
        ready = manifest.model === DICTATION_MODEL.id && manifest.platform === process.platform && manifest.arch === process.arch;
        for (const name of DICTATION_MODEL.files) { const file = await lstat(join(this.root, 'models', name)); if (!file.isFile() || file.isSymbolicLink() || !file.size) ready = false; }
      } catch { ready = false; }
    }
    return { ready, root: this.root ?? null, installing: Boolean(this.controller), installation: this.installation ?? null, recording: Boolean(this.job), model: DICTATION_MODEL.id, downloadBytes: DICTATION_MODEL.bytes, local: true };
  }
  publishProgress(value) { this.installation = value; this.progress(value); }
  async download(urls, path, algorithm, expected, signal, details = {}) {
    await downloadSpeechFile({ urls, path, algorithm, expected, signal, fetcher: this.fetcher, ...details, progress: value => this.publishProgress({ ...details.label, ...value }) });
  }
  async install(parent) {
    if (this.controller || this.job || this.loading) throw Error('Local dictation is busy');
    const packages = dictationPackages();
    this.closeWorker(); this.controller = new AbortController(); const signal = this.controller.signal;
    let stage, destination, committed = false, moved = false, failure;
    this.publishProgress({ stage: 'connecting' });
    try {
      parent = await realpath(parent); const parentInfo = await lstat(parent); if (!parentInfo.isDirectory()) throw Error('Choose a directory');
      const space = await statfs(parent, { bigint: true }); if (space.bavail * space.bsize < 800n * 1024n ** 2n) throw Error('At least 800 MiB of free space is required');
      checkpoint(signal);
      stage = join(parent, '.rpen-dictation-' + randomUUID()); destination = join(parent, 'RPEN-Dictation-' + randomUUID().slice(0, 8));
      await mkdir(stage);
      for (const [index, entry] of packages.entries()) {
        const archive = join(stage, entry.name + '.tgz');
        await this.download([entry.mirror, entry.url], archive, 'sha512', entry.integrity, signal, { maximum: 64 * 1024 ** 2, label: { kind: 'runtime', index: index + 1, count: 3, file: entry.name } });
        checkpoint(signal); this.publishProgress({ stage: 'extract', kind: 'runtime', index: index + 1, count: 3, file: entry.name });
        await extractSpeechPackage(await readFile(archive), join(stage, 'runtime/node_modules', entry.name)); checkpoint(signal); await rm(archive);
      }
      const archive = join(stage, 'model.tar.bz2');
      await this.download([DICTATION_MODEL.url], archive, 'sha256', DICTATION_MODEL.sha256, signal, { expectedBytes: DICTATION_MODEL.bytes, label: { kind: 'model', index: 3, count: 3 } });
      this.publishProgress({ stage: 'extract', kind: 'model', index: 3, count: 3 });
      await promisify(execFile)('tar', ['-xjf', archive, '-C', stage, ...DICTATION_MODEL.files.map(name => DICTATION_MODEL.folder + '/' + name)], { windowsHide: true, timeout: 120000, maxBuffer: 1024 ** 2, signal });
      checkpoint(signal);
      await rename(join(stage, DICTATION_MODEL.folder), join(stage, 'models')); await rm(archive);
      const manifest = { version: 1, model: DICTATION_MODEL.id, platform: process.platform, arch: process.arch, hashes: {} };
      for (const name of DICTATION_MODEL.files) {
        checkpoint(signal);
        const bytes = await readFile(join(stage, 'models', name)); manifest.hashes[name] = createHash('sha256').update(bytes).digest('hex');
      }
      await atomicJson(join(stage, 'installed.json'), manifest); checkpoint(signal);
      this.publishProgress({ stage: 'install', cancellable: false });
      await rename(stage, destination); moved = true; await atomicJson(this.configPath, { version: 1, root: destination });
      this.root = destination; committed = true;
    } catch (error) { failure = signal.aborted ? aborted() : error; }
    finally {
      try {
        for (const path of [stage, moved && !committed ? destination : null]) if (path) {
          const boundary = resolve(parent).endsWith(sep) ? resolve(parent) : resolve(parent) + sep;
          if (!resolve(path).startsWith(boundary)) throw Error('Speech cleanup path escaped its directory');
          await rm(path, { recursive: true, force: true });
        }
      } catch (error) { failure = error; }
      this.controller = null;
      this.publishProgress({ stage: failure ? failure.name === 'AbortError' ? 'cancelled' : 'error' : 'ready', error: failure?.name !== 'AbortError' ? failure?.message : undefined });
    }
    if (failure) throw failure;
    return this.status();
  }
  async load() {
    if (this.loading) return this.loading;
    if (this.worker) return;
    this.loading = (async () => {
      if (!(await this.status()).ready) throw Object.assign(Error('Prepare the local speech model in Settings first'), { code: 'DICTATION_NOT_READY' });
      const manifest = JSON.parse(await readFile(join(this.root, 'installed.json'), 'utf8'));
      for (const name of DICTATION_MODEL.files) if (createHash('sha256').update(await readFile(join(this.root, 'models', name))).digest('hex') !== manifest.hashes[name]) throw Error('Speech model is damaged; prepare it again');
      const native = dictationPackages()[1].name, library = join(this.root, 'runtime/node_modules', native);
      const worker = this.utilityProcess.fork(fileURLToPath(new URL('./dictation-worker.cjs', import.meta.url)), [], { serviceName: 'RPEN local dictation', stdio: 'pipe', env: { ...process.env, LD_LIBRARY_PATH: library, DYLD_LIBRARY_PATH: library } });
      this.worker = worker;
      let diagnostics = ''; worker.stderr?.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-2000); });
      worker.on('message', message => { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); clearTimeout(pending.timer); message.ok ? pending.resolve(message.result) : pending.reject(Error(message.error)); });
      worker.on('exit', code => { if (this.worker !== worker) return; this.worker = null; for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('Local speech process stopped (' + code + ')' + (diagnostics ? ': ' + diagnostics : ''))); } this.pending.clear(); this.job = null; });
      await this.request('load', { root: this.root });
    })().catch(error => { this.closeWorker(); throw error; }).finally(() => { this.loading = null; });
    return this.loading;
  }
  request(action, data = {}) {
    if (!this.worker) return Promise.reject(Error('Local speech process is unavailable'));
    const id = randomUUID();
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(Error('Local speech recognition timed out')); this.closeWorker(); }, 90000); this.pending.set(id, { resolve, reject, timer }); this.worker.postMessage({ id, action, ...data }); });
  }
  async begin() {
    if (this.job || this.controller) throw Error('Local dictation is busy');
    await this.load();
    if (this.job) throw Error('Local dictation is busy');
    const token = randomUUID(); this.job = { token, samples: 0, writing: false };
    try { await this.request('begin', { session: token }); return token; } catch (error) { this.job = null; throw error; }
  }
  async write(token, samples, sampleRate) {
    const job = this.job;
    if (!job || job.token !== token || job.writing || !validDictationPcm(samples) || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || job.samples + samples.length > sampleRate * 121) throw Error('Invalid microphone audio');
    job.writing = true; job.samples += samples.length;
    try { return await this.request('write', { session: token, samples, sampleRate }); } finally { job.writing = false; }
  }
  async finish(token) {
    if (this.job?.token !== token || this.job.writing) throw Error('Dictation session expired');
    try { return await this.request('finish', { session: token }); } finally { this.job = null; }
  }
  cancel(token) {
    if (token === 'install') {
      if (!this.controller || this.installation?.cancellable === false) return { cancelled: false };
      this.controller.abort(); this.publishProgress({ stage: 'cancelling', cancellable: false }); return { cancelled: true };
    }
    if (this.job?.token === token) { this.job = null; return this.request('cancel', { session: token }).catch(() => {}); }
  }
  closeWorker() { this.worker?.kill(); this.worker = null; this.job = null; for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(aborted()); } this.pending.clear(); }
  close() { this.controller?.abort(); this.closeWorker(); }
}

export function installDictation({ ipcMain, service, window: getWindow, origin, dialog, shell, microphone }) {
  const permitted = event => event.sender === getWindow()?.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(origin + '/');
  ipcMain.handle('rpen-dictation', async (event, { action, args = [] } = {}) => {
    try {
      if (!permitted(event) || !Array.isArray(args)) throw Error('Dictation request is not permitted');
      let result;
      if (action === 'install') {
        const answer = await dialog.showMessageBox(getWindow(), { type: 'question', message: '准备本地语音输入 / Prepare local dictation', detail: '下载约 150 MiB 的运行库和中英双语模型，识别仅在本机进行。请选择空间充足的存放位置；录音不会上传或保存。\nDownloads about 150 MiB. Recognition stays local; recordings are not uploaded or saved.', buttons: ['选择位置并下载 / Download', '取消 / Cancel'], defaultId: 1, cancelId: 1 });
        if (answer.response !== 0) return { ok: true, result: null };
        const selected = await dialog.showOpenDialog(getWindow(), { title: '语音模型存放位置 / Speech model location', properties: ['openDirectory', 'createDirectory'] });
        result = selected.canceled ? null : await service.install(selected.filePaths[0]);
      } else if (['permission', 'permissionStatus', 'openMicrophoneSettings'].includes(action)) {
        if (!microphone) throw Error('Microphone permission service is unavailable');
        result = action === 'permission' ? await microphone.request(args[0] === true) : action === 'permissionStatus' ? microphone.status() : await microphone.openSettings();
      } else if (action === 'open') {
        if (!service.root) throw Error('Speech model is not installed');
        const failure = await shell.openPath(await realpath(service.root)); if (failure) throw Error(failure); result = true;
      } else {
        if (!['status', 'load', 'begin', 'write', 'finish', 'cancel'].includes(action)) throw Error('Unknown dictation request');
        result = await service[action](...args);
      }
      return { ok: true, result };
    } catch (error) { return { ok: false, error: { name: error.name, message: error.message, code: error.code } }; }
  });
}
