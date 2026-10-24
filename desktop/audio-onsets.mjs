import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp, open, rm, rename, readdir, lstat, stat } from 'node:fs/promises';
import { resolve, join, dirname, sep, isAbsolute } from 'node:path';
import { PythonAudioRuntime } from './python-audio-runtime.mjs';
import { withAudioStorage } from './audio-storage.mjs';

export const DDC_REVISION = 'd02aad36297a90e00848c32f6492fad1b43b7912';
const CHUNK = 1024 ** 2, VERSION = `ddc-${DDC_REVISION}-aligned-v1`;
const aborted = () => Object.assign(Error('起音检测已取消'), { name: 'AbortError' });

export class AudioOnsetService extends PythonAudioRuntime {
  constructor(root, options = {}) { super(root, options); this.jobs = new Map(); this.results = new Map(); this.maxDuration = options.maxDuration ?? 183; }
  async initialize() {
    await mkdir(join(this.dataRoot, 'temp'), { recursive: true });
    const parent = join(this.dataRoot, 'jobs'); let entries;
    try { entries = await readdir(parent, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && /^job-[a-zA-Z0-9]+$/.test(entry.name)) await rm(join(parent, entry.name), { recursive: true, force: true });
  }
  async probe() {
    try { const python = await this.configuredPython(), info = await this.run(python, ['-u', this.script, 'probe'], { timeout: 90000 }); if (info?.engine !== 'ddc' || info.frameRate !== 100) throw Error('DDC 模型未正确安装'); return { ...info, ready: true, pythonPath: python, revision: DDC_REVISION }; }
    catch (error) { return { ready: false, message: error.message }; }
  }
  async install(basePython) {
    if (this.jobs.size || this.installing || this.beginning) throw Error('已有起音检测或安装任务'); this.installing = true; this.installController = new AbortController(); const signal = this.installController.signal;
    try {
      if (!isAbsolute(basePython) || !(await stat(basePython)).isFile()) throw Error('请选择 Python 可执行文件');
      await mkdir(this.root, { recursive: true }); const runtime = join(this.root, 'runtime'), temporary = join(this.dataRoot, 'temp'); await mkdir(temporary, { recursive: true });
      await this.run(basePython, ['-m', 'venv', runtime], { signal, id: 'environment', timeout: 180000 });
      const python = join(runtime, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      await this.run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', `https://github.com/chrisdonahue/ddc_onset/archive/${DDC_REVISION}.zip`, 'scipy>=1.11,<2', 'numpy>=1.26,<3'], { signal, id: 'environment', env: this.environment() });
      await this.configure(python); return this.probe();
    } finally { this.installing = false; this.installController = null; }
  }
  async begin({ id, sampleRate, frames, device = 'auto' }) {
    if (this.jobs.size || this.beginning || this.installing) throw Error('已有起音检测任务');
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id) || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !Number.isSafeInteger(frames) || frames < 1 || frames > sampleRate * this.maxDuration || !['auto', 'cpu', 'cuda'].includes(device)) throw Error('起音检测参数无效');
    this.beginning = true;
    try {
      const python = await this.configuredPython(); await mkdir(join(this.dataRoot, 'jobs'), { recursive: true });
      const directory = await mkdtemp(join(this.dataRoot, 'jobs', 'job-')), token = randomUUID(), file = await open(join(directory, 'input.f32'), 'wx');
      this.jobs.set(token, { id, sampleRate, frames, device, python, directory, file, bytes: frames * 4, written: 0, hash: createHash('sha256'), controller: new AbortController() }); return token;
    } finally { this.beginning = false; }
  }
  async write(token, offset, bytes) {
    const job = this.jobs.get(token); if (!job || job.running || job.writing || !job.file || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CHUNK || offset !== job.written || offset + bytes.length > job.bytes) throw Error('起音音频分片无效');
    job.writing = true;
    try { let written = 0; while (written < bytes.length) { const result = await job.file.write(bytes, written, bytes.length - written, offset + written); if (!result.bytesWritten) throw Error('音频写入失败'); written += result.bytesWritten; } if (job.controller.signal.aborted) throw aborted(); job.hash.update(bytes); job.written += bytes.length; }
    finally { job.writing = false; if (job.controller.signal.aborted) await this.cleanup(token); }
  }
  async manifest(directory) {
    const result = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), info = await lstat(join(directory, 'salience.f32'));
    if (result.signatureVersion !== VERSION || result.engine !== 'ddc' || result.frameRate !== 100 || !Number.isInteger(result.frames) || result.frames < 1 || result.frames > 18300 || !info.isFile() || info.isSymbolicLink() || info.size !== result.frames * 4) throw Error('起音缓存无效');
    const bytes = await readFile(join(directory, 'salience.f32')), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let index = 0; index < result.frames; index++) { const value = view.getFloat32(index * 4, true); if (!Number.isFinite(value) || value < 0 || value > 1) throw Error('起音缓存数据无效'); }
    return result;
  }
  async execute(token) {
    const job = this.jobs.get(token); if (!job || job.running || job.writing || job.written !== job.bytes) throw Error('音频尚未完整上传'); job.running = true;
    try {
      await job.file.close(); job.file = null;
      const signature = createHash('sha256').update(`${job.hash.digest('hex')}:${job.sampleRate}:${VERSION}`).digest('hex'), directory = join(this.dataRoot, 'cache', signature);
      let result; try { result = await this.manifest(directory); } catch {}
      const cacheHit = Boolean(result);
      if (!result) {
        const request = { input: join(job.directory, 'input.f32'), output: join(job.directory, 'salience.f32'), sampleRate: job.sampleRate, frames: job.frames, device: job.device };
        await writeFile(join(job.directory, 'request.json'), JSON.stringify(request));
        result = await this.run(job.python, ['-u', this.script, 'analyze', '--request', join(job.directory, 'request.json')], { signal: job.controller.signal, id: job.id });
        if (job.controller.signal.aborted) throw aborted(); if (!result) throw Error('起音模型没有返回结果'); result.signatureVersion = VERSION;
        await writeFile(join(job.directory, 'manifest.json'), JSON.stringify(result)); await this.manifest(job.directory);
        await rm(request.input); await rm(join(job.directory, 'request.json')); await mkdir(dirname(directory), { recursive: true });
        if (dirname(directory) !== resolve(this.dataRoot, 'cache') || !/^[a-f0-9]{64}$/.test(signature)) throw Error('起音缓存路径异常');
        await rm(directory, { recursive: true, force: true }); await rename(job.directory, directory);
      }
      if (job.controller.signal.aborted) throw aborted(); const cacheId = randomUUID(); this.results.set(cacheId, directory); if (this.results.size > 32) this.results.delete(this.results.keys().next().value);
      return { ...result, cacheId, cacheHit, revision: DDC_REVISION };
    } finally { await this.cleanup(token); }
  }
  async read(cacheId) { const directory = this.results.get(cacheId); if (!directory) throw Error('起音缓存句柄无效'); await this.manifest(directory); return new Uint8Array(await readFile(join(directory, 'salience.f32'))); }
  async cleanup(token) { const job = this.jobs.get(token); if (!job) return; await job.file?.close().catch(() => {}); if (resolve(job.directory).startsWith(resolve(this.dataRoot, 'jobs') + sep)) await rm(job.directory, { recursive: true, force: true }).catch(() => {}); this.jobs.delete(token); }
  async cancel(token) { if (token === 'environment') { this.installController?.abort(); return; } const job = this.jobs.get(token); if (!job) return; job.controller.abort(); if (!job.running && !job.writing) await this.cleanup(token); }
  async clear() { if (this.jobs.size) throw Error('请先结束起音检测'); const directory = join(this.dataRoot, 'cache'); if (dirname(directory) !== this.dataRoot) throw Error('缓存路径异常'); await rm(directory, { recursive: true, force: true }); this.results.clear(); }
  async close() { this.installController?.abort(); await Promise.allSettled([...this.jobs.keys()].map(token => this.cancel(token))); }
}

export function installAudioOnsets({ ipcMain, service, origin, window: getWindow, dialog }) {
  ipcMain.handle('rpen-audio-onsets', async (event, { action, args = [] } = {}) => {
    try {
      if (event.sender !== getWindow()?.webContents || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith(origin + '/') || !Array.isArray(args)) throw Error('无权限');
      return await withAudioStorage(service, async () => {
        if (action === 'choosePython' || action === 'install') {
          if (action === 'install') { const answer = await dialog.showMessageBox(getWindow(), { type: 'question', message: '安装独立 DDC 采音环境？', detail: '选择本机 Python 3.10 或以上版本，另建虚拟环境安装 PyTorch、DDC 和 SciPy。可能下载数 GB，音频仅在本机分析。', buttons: ['安装', '取消'], defaultId: 1, cancelId: 1 }); if (answer.response !== 0) return { ok: true, result: null }; }
          const selected = await dialog.showOpenDialog(getWindow(), { title: action === 'install' ? '选择基础 Python' : '选择已安装 DDC onset 的 Python', properties: ['openFile'] }); if (selected.canceled) return { ok: true, result: null };
          if (action === 'install') return { ok: true, result: await service.install(selected.filePaths[0]) };
          await service.configure(selected.filePaths[0]); return { ok: true, result: await service.probe() };
        }
        if (!['probe', 'begin', 'write', 'execute', 'read', 'cancel', 'clear'].includes(action)) throw Error('不支持的起音检测操作');
        return { ok: true, result: await service[action](...args) };
      }, action);
    } catch (error) { return { ok: false, error: { name: error.name, message: error.message } }; }
  });
}
