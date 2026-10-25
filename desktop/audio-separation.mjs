import { PythonAudioRuntime } from './python-audio-runtime.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp, open, rm, rename, lstat, stat, readdir } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute, sep } from 'node:path';
import { SEPARATION_MODELS } from '../src/core/audio-sources.mjs';
import { separationSetupSupport, prepareAudioPython } from './audio-setup.mjs';
import { withAudioStorage } from './audio-storage.mjs';

const MAX_INPUT = 1024 ** 3, CHUNK = 1024 ** 2;
const aborted = () => Object.assign(Error('声部分离已取消'), { name: 'AbortError' });
export class AudioSeparationService extends PythonAudioRuntime {
  constructor(root, options = {}) {
    super(root, options); this.jobs = new Map(); this.results = new Map(); this.preparePython = options.preparePython ?? prepareAudioPython; this.setupFetch = options.fetcher;
  }
  async initialize() {
    await mkdir(join(this.dataRoot, 'temp'), { recursive: true });
    const parent = resolve(this.dataRoot, 'jobs'); let entries;
    try { entries = await readdir(parent, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && /^job-[a-zA-Z0-9]+$/.test(entry.name)) { const directory = resolve(parent, entry.name); if (dirname(directory) === parent) await rm(directory, { recursive: true, force: true }); }
  }
  async checkEnvironment(python) {
    await mkdir(join(this.dataRoot, 'temp'), { recursive: true }); const info = await this.run(python, ['-u', this.script, 'probe'], { timeout: 90000 });
    if (!info || info.demucs !== '4.1.0') throw Error('分离环境不完整，需要 Demucs 4.1；可一键安装或选择匹配的已有环境');
    const setup = separationSetupSupport(); return { ...info, ready: true, pythonPath: python, autoInstallSupported: setup.supported, setup };
  }
  async probe() { try { return await this.checkEnvironment(await this.configuredPython()); } catch (error) { const setup = separationSetupSupport(); return { ready: false, autoInstallSupported: setup.supported, setup, message: error.message }; } }
  async install(basePython, signal, gpu = false) {
    if (this.jobs.size || this.installing || this.beginning) throw Error('已有分离或安装任务'); this.installing = true; this.installController = new AbortController();
    const externalSignal = signal, cancel = () => this.installController?.abort(); externalSignal?.addEventListener('abort', cancel, { once: true }); if (externalSignal?.aborted) cancel(); signal = this.installController.signal;
    try {
      const automatic = !basePython;
      if (automatic) { const setup = separationSetupSupport(); if (!setup.supported) throw Error(setup.message); basePython = await this.preparePython(this, signal, { fetcher: this.setupFetch }); }
      if (!isAbsolute(basePython) || !(await stat(basePython)).isFile()) throw Error('请选择Python可执行文件');
      const runtime = join(this.root, automatic ? 'managed-runtime-v1' : 'runtime'); await mkdir(this.root, { recursive: true });
      this.progress({ id: 'environment', stage: 'environment', message: '创建独立声部分离环境…' });
      await this.run(basePython, ['-m', 'venv', runtime], { signal, id: 'environment', timeout: 180000 });
      const python = join(runtime, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      const temporary = join(this.dataRoot, 'temp'); await mkdir(temporary, { recursive: true });
      const env = this.environment();
      this.progress({ id: 'environment', stage: 'dependencies', message: gpu ? '安装 NVIDIA 加速推理库，下载可能较大…' : '安装 CPU 推理库，首次下载可能需要几分钟…' });
      const index = process.platform === 'darwin' ? [] : ['--index-url', gpu ? 'https://download.pytorch.org/whl/cu128' : 'https://download.pytorch.org/whl/cpu'];
      const torchPackage = process.platform === 'darwin' ? process.arch === 'x64' ? 'torch==2.2.2' : 'torch==2.10.0' : gpu ? 'torch==2.10.0+cu128' : 'torch==2.10.0+cpu';
      await this.run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', ...index, torchPackage], { signal, id: 'environment', env });
      this.progress({ id: 'environment', stage: 'dependencies', message: '安装 Demucs 声部分离工具…' });
      await this.run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', 'demucs==4.1.0', process.platform === 'darwin' && process.arch === 'x64' ? 'numpy>=1.26,<2' : 'numpy>=1.26,<3'], { signal, id: 'environment', env });
      this.progress({ id: 'environment', stage: 'checking', message: '检查声部分离环境…' });
      const info = await this.checkEnvironment(python); if (signal.aborted) throw aborted(); await this.configure(python); return info;
    } finally { externalSignal?.removeEventListener('abort', cancel); this.installing = false; this.installController = null; }
  }
  async begin({ id, model = 'htdemucs', device = 'auto', shifts = 1, bytes }) {
    if (this.jobs.size || this.installing) throw Error('已有声部分离任务正在运行');
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id) || !SEPARATION_MODELS.some(entry => entry.id === model) || !['auto', 'cpu', 'cuda'].includes(device) || !Number.isInteger(shifts) || shifts < 0 || shifts > 4 || !Number.isSafeInteger(bytes) || bytes < 44 || bytes > MAX_INPUT) throw Error('分离参数或音频大小无效');
    const python = await this.configuredPython(); if (this.jobs.size || this.beginning || this.installing) throw Error('已有声部分离任务'); this.beginning = true;
    try {
    await mkdir(join(this.dataRoot, 'jobs'), { recursive: true });
    const directory = await mkdtemp(join(this.dataRoot, 'jobs', 'job-')), token = randomUUID(), file = await open(join(directory, 'input.wav'), 'wx');
    this.jobs.set(token, { id, model, device, shifts, bytes, written: 0, directory, file, python, hash: createHash('sha256'), controller: new AbortController() }); return token;
    } finally { this.beginning = false; }
  }
  async write(token, offset, bytes) {
    const job = this.jobs.get(token); if (!job || job.running || !job.file || job.writing) throw Error('分离任务或上传状态无效');
    const data = bytes instanceof Uint8Array ? bytes : null;
    if (!data || !data.length || data.length > CHUNK || offset !== job.written || offset + data.length > job.bytes) throw Error('音频分片无效');
    job.writing = true; try { let written = 0; while (written < data.length) { const result = await job.file.write(data, written, data.length - written, offset + written); if (!result.bytesWritten) throw Error('音频上传写入失败'); written += result.bytesWritten; } if (job.controller.signal.aborted) throw aborted(); job.hash.update(data); job.written += data.length; } finally { job.writing = false; if (job.controller.signal.aborted) await this.cleanup(token); }
  }
  async execute(token) {
    const job = this.jobs.get(token); if (!job || job.running || job.writing || job.written !== job.bytes) throw Error('音频尚未完整上传'); job.running = true;
    try {
      await job.file.close(); job.file = null;
      const signature = createHash('sha256').update(job.hash.digest('hex') + ':' + job.model + ':' + job.shifts + ':demucs4.1:aligned-v1').digest('hex');
      const cache = join(this.dataRoot, 'cache', signature); let result;
      try { result = await this.manifest(cache); } catch {}
      const cacheHit = Boolean(result);
      if (!result) {
        const request = { input: join(job.directory, 'input.wav'), output: job.directory, model: job.model, device: job.device, shifts: job.shifts };
        await writeFile(join(job.directory, 'request.json'), JSON.stringify(request));
        result = await this.run(job.python, ['-u', this.script, 'separate', '--request', join(job.directory, 'request.json')], { signal: job.controller.signal, id: job.id });
        if (!result?.sources?.length || job.controller.signal.aborted) throw aborted();
        await rm(join(job.directory, 'input.wav')); await rm(join(job.directory, 'request.json'));
        await writeFile(join(job.directory, 'manifest.json'), JSON.stringify(result)); await this.manifest(job.directory);
        await mkdir(dirname(cache), { recursive: true });
        if (dirname(cache) !== resolve(this.dataRoot, 'cache') || !/^[a-f0-9]{64}$/.test(signature)) throw Error('分离缓存路径异常');
        await rm(cache, { recursive: true, force: true });
        try { await rename(job.directory, cache); } catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error; await this.manifest(cache); }
      }
      if (job.controller.signal.aborted) throw aborted();
      const cacheId = randomUUID(); this.results.set(cacheId, cache); if (this.results.size > 64) this.results.delete(this.results.keys().next().value); return { ...result, cacheId, cacheHit };
    } finally { await this.cleanup(token); }
  }
  async manifest(directory) {
    const result = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), model = SEPARATION_MODELS.find(entry => entry.id === result.model);
    if (!model || !Array.isArray(result.sources) || result.sources.length !== model.stems.length || new Set(result.sources.map(source => source.id)).size !== model.stems.length) throw Error('分离缓存无效');
    for (const source of result.sources) {
      if (!model.stems.includes(source.id)) throw Error('声部名称无效');
      const info = await lstat(join(directory, source.id + '.wav'));
      if (!model.stems.includes(source.id) || !info.isFile() || info.isSymbolicLink() || info.size !== source.bytes || info.size > MAX_INPUT || !Number.isFinite(source.sampleRate) || source.sampleRate < 8000 || source.sampleRate > 192000 || !Number.isSafeInteger(source.frames) || source.frames <= 0) throw Error('声部文件不完整');
    }
    return result;
  }
  async read(cacheId, stem, offset, length) {
    const directory = this.results.get(cacheId); if (!directory || !/^(vocals|drums|bass|other|guitar|piano)$/.test(stem) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > CHUNK) throw Error('声部读取参数无效');
    const file = await open(join(directory, stem + '.wav'), 'r'); try { const output = Buffer.alloc(length), result = await file.read(output, 0, length, offset); return new Uint8Array(output.subarray(0, result.bytesRead)); } finally { await file.close(); }
  }
  async cleanup(token) {
    const job = this.jobs.get(token); if (!job) return;
    await job.file?.close().catch(() => {}); const directory = resolve(job.directory), parent = resolve(this.dataRoot, 'jobs') + sep;
    if (directory.startsWith(parent)) await rm(directory, { recursive: true, force: true }).catch(() => {});
    this.jobs.delete(token);
  }
  async cancel(token) { if (token === 'environment') { this.installController?.abort(); return; } const job = this.jobs.get(token); if (!job) return; job.controller.abort(); if (!job.running && !job.writing) await this.cleanup(token); }
  async clear() { if (this.jobs.size) throw Error('请先结束分离任务'); const directory = resolve(this.dataRoot, 'cache'); if (dirname(directory) !== this.dataRoot) throw Error('缓存路径异常'); await rm(directory, { recursive: true, force: true }); this.results.clear(); }
  async close() { this.installController?.abort(); await Promise.allSettled([...this.jobs.keys()].map(token => this.cancel(token))); }
}

export function installAudioSeparation({ ipcMain, service, origin, window: getWindow, dialog }) {
  const permitted = event => event.sender === getWindow()?.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(origin + '/');
  ipcMain.handle('rpen-audio-separation', async (event, { action, args = [] } = {}) => {
    try {
      if (!permitted(event) || !Array.isArray(args)) throw Error('无权限');
      return await withAudioStorage(service, async () => {
        if (action === 'choosePython' || action === 'install' || action === 'installManual') {
          if (action !== 'choosePython') {
            const gpuAvailable = process.platform !== 'darwin' && process.arch === 'x64', buttons = gpuAvailable ? ['安装（CPU）', '安装（NVIDIA 加速）', '取消'] : ['安装（CPU）', '取消'];
            const answer = await dialog.showMessageBox(getWindow(), { type: 'question', message: '准备声部分离环境', detail: action === 'install' ? '自动下载独立 Python 和 Demucs，无需预先安装 Python，也不改变系统环境。首次下载需要网络和数 GB 可用空间，之后可复用。CPU 适用于所有支持的桌面系统；NVIDIA 加速需要兼容显卡和驱动。音频只在本机处理。' : '选择 Python 3.10–3.12，创建独立 Demucs 环境，不向系统 Python 安装依赖。首次安装和模型下载需要联网。', buttons, defaultId: 0, cancelId: buttons.length - 1 });
            if (answer.response === buttons.length - 1) return { ok: true, result: null };
            if (action === 'install') return { ok: true, result: await service.install(undefined, undefined, gpuAvailable && answer.response === 1) };
            const selected = await dialog.showOpenDialog(getWindow(), { title: '选择基础 Python 3.10–3.12', properties: ['openFile'] }); if (selected.canceled) return { ok: true, result: null };
            return { ok: true, result: await service.install(selected.filePaths[0], undefined, gpuAvailable && answer.response === 1) };
          }
          const selected = await dialog.showOpenDialog(getWindow(), { title: '选择已安装 Demucs 4.1 的 Python', properties: ['openFile'] });
          if (selected.canceled) return { ok: true, result: null };
          const info = await service.checkEnvironment(selected.filePaths[0]); await service.configure(selected.filePaths[0]); return { ok: true, result: info };
        }
        if (!['probe', 'begin', 'write', 'execute', 'read', 'cancel', 'clear'].includes(action)) throw Error('不支持的分离操作');
        return { ok: true, result: await service[action](...args) };
      }, action);
    } catch (error) { return { ok: false, error: { name: error.name, message: error.message } }; }
  });
}
