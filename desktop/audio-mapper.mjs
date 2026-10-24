import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, rename, lstat, stat } from 'node:fs/promises';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { AudioOnsetService } from './audio-onsets.mjs';
import { MAPPER_SOURCE_REVISION, MAPPER_MODELS, validateMapperSettings } from '../src/core/audio-mapper.mjs';

const VERSION = `mapper-${MAPPER_SOURCE_REVISION}-rhythm-v2`;
const aborted = () => Object.assign(Error('节奏生成已取消'), { name: 'AbortError' });

export class AudioMapperService extends AudioOnsetService {
  constructor(root, options = {}) { super(root, { ...options, maxDuration: 213 }); this.sourcePath = options.source; }
  environment() { return { ...super.environment(), TMP: join(this.root, 'temp'), TEMP: join(this.root, 'temp'), TORCHINDUCTOR_CACHE_DIR: join(this.root, 'kernel-cache') }; }
  async initialize() { await mkdir(join(this.root, 'temp'), { recursive: true }); await super.initialize(); }
  async source() {
    if (this.sourcePath) return this.sourcePath;
    try { const config = JSON.parse(await readFile(join(this.root, 'config.json'), 'utf8')); if (isAbsolute(config.source)) return config.source; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    throw Error('请先安装或选择 Mapperatorinator 环境及源码目录');
  }
  async configureExisting(python, source) {
    if (!isAbsolute(source) || !(await stat(join(source, 'osuT5/osuT5/inference/processor.py'))).isFile()) throw Error('Mapperatorinator 源码目录无效');
    await this.configure(python); await writeFile(join(this.root, 'config.json'), JSON.stringify({ python, source })); this.sourcePath = source;
  }
  async probe() {
    try { await mkdir(join(this.root, 'temp'), { recursive: true }); const python = await this.configuredPython(), source = await this.source(), info = await this.run(python, ['-u', this.script, 'probe', '--source', source], { timeout: 120000 }); if (info?.engine !== 'mapper') throw Error('Mapperatorinator 推理依赖未正确安装'); return { ...info, ready: true, pythonPath: python, sourcePath: source }; }
    catch (error) { return { ready: false, message: error.message }; }
  }
  async install(basePython, gpu = false) {
    if (this.jobs.size || this.installing || this.beginning) throw Error('已有节奏生成或安装任务'); this.installing = true; this.installController = new AbortController(); const signal = this.installController.signal;
    try {
      if (!isAbsolute(basePython) || !(await stat(basePython)).isFile()) throw Error('请选择 Python 可执行文件');
      const runtime = join(this.root, 'runtime'), temporary = join(this.root, 'temp'); await mkdir(temporary, { recursive: true });
      const env = { ...this.environment(), TMP: temporary, TEMP: temporary, PIP_CACHE_DIR: join(this.root, 'pip-cache') };
      await this.run(basePython, ['-m', 'venv', runtime], { signal, id: 'environment', env, timeout: 180000 });
      const python = join(runtime, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      const prepared = await this.run(python, ['-u', this.script, 'prepare', '--source', join(this.root, 'source')], { signal, id: 'environment', env });
      if (!prepared?.source || !prepared.slider) throw Error('推理源码未准备完成');
      const torchIndex = process.platform === 'darwin' ? [] : ['--index-url', gpu ? 'https://download.pytorch.org/whl/cu128' : 'https://download.pytorch.org/whl/cpu'];
      await this.run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', ...torchIndex, 'torch==2.10.0', 'torchaudio==2.10.0'], { signal, id: 'environment', env });
      await this.run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', prepared.slider, 'transformers==4.57.3', 'hydra-core==1.3.2', 'pandas==2.3.3', 'accelerate==1.12.0', 'rosu-pp-py==3.1.0', 'einops==0.8.1', 'pydub==0.25.1', 'scipy>=1.11,<2', 'numpy>=1.26,<3'], { signal, id: 'environment', env });
      await this.configureExisting(python, prepared.source); return this.probe();
    } finally { this.installing = false; this.installController = null; }
  }
  async begin(options) {
    validateMapperSettings(options);
    const { startSeconds, endSeconds, originSeconds, sourceDuration, timing } = options;
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || !(endSeconds > startSeconds) || endSeconds - startSeconds > 180 || !Number.isFinite(originSeconds) || originSeconds < 0 || originSeconds > startSeconds || endSeconds > originSeconds + options.frames / options.sampleRate + .001 || !Number.isFinite(sourceDuration) || sourceDuration < endSeconds - .001 || !Array.isArray(timing) || timing.length > 5000 || timing.some((point, index) => !Number.isFinite(point.seconds) || Math.abs(point.seconds) > 86400 || !Number.isFinite(point.bpm) || point.bpm <= 0 || point.bpm > 10000 || index && timing[index - 1].seconds > point.seconds)) throw Error('节奏生成时间或 BPM 上下文无效');
    const source = await this.source(), token = await super.begin(options); Object.assign(this.jobs.get(token), { options: { ...options, id: undefined }, source }); return token;
  }
  async manifest(directory) {
    const info = await lstat(join(directory, 'rhythm.json')); if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 ** 2) throw Error('节奏缓存无效');
    const result = JSON.parse(await readFile(join(directory, 'rhythm.json'), 'utf8')), model = MAPPER_MODELS.find(entry => entry.id === result.model);
    if (result.signatureVersion !== VERSION || result.engine !== 'mapper' || result.sourceRevision !== MAPPER_SOURCE_REVISION || !model || result.modelRevision !== model.revision || !Array.isArray(result.objects) || result.objects.length > 60000 || result.objects.some(object => !Number.isFinite(object.seconds) || Math.abs(object.seconds) > 86400 || !['circle', 'slider_head', 'hold_note', 'spinner', 'drumroll', 'denden'].includes(object.type))) throw Error('节奏缓存数据无效');
    return result;
  }
  async execute(token) {
    const job = this.jobs.get(token); if (!job || job.running || job.writing || job.written !== job.bytes) throw Error('音频尚未完整上传'); job.running = true;
    try {
      await job.file.close(); job.file = null;
      const { mapperModel: model, mapperMode: gamemode, difficulty, seed, startSeconds, endSeconds, originSeconds, sourceDuration, timing, useChartTiming } = job.options;
      const parameters = { model, gamemode, difficulty, seed, startSeconds, endSeconds, originSeconds, sourceDuration, timing: useChartTiming ? timing : [] };
      const signature = createHash('sha256').update(job.hash.digest('hex') + ':' + job.sampleRate + ':' + VERSION + ':' + JSON.stringify(parameters)).digest('hex'), directory = join(this.root, 'cache', signature);
      let result; try { result = await this.manifest(directory); } catch {} const cacheHit = Boolean(result);
      if (!result) {
        const request = { ...parameters, input: join(job.directory, 'input.f32'), output: join(job.directory, 'rhythm.json'), sampleRate: job.sampleRate, frames: job.frames, device: job.device };
        await writeFile(join(job.directory, 'request.json'), JSON.stringify(request));
        await this.run(job.python, ['-u', this.script, 'generate', '--source', job.source, '--request', join(job.directory, 'request.json')], { signal: job.controller.signal, id: job.id }); if (job.controller.signal.aborted) throw aborted();
        result = JSON.parse(await readFile(request.output, 'utf8')); result.signatureVersion = VERSION; await writeFile(request.output, JSON.stringify(result)); await this.manifest(job.directory);
        await rm(request.input); await rm(join(job.directory, 'request.json')); await mkdir(dirname(directory), { recursive: true });
        if (dirname(directory) !== resolve(this.root, 'cache') || !/^[a-f0-9]{64}$/.test(signature)) throw Error('节奏缓存路径异常'); await rm(directory, { recursive: true, force: true }); await rename(job.directory, directory);
      }
      if (job.controller.signal.aborted) throw aborted(); const cacheId = randomUUID(); this.results.set(cacheId, directory); if (this.results.size > 32) this.results.delete(this.results.keys().next().value);
      return { cacheId, cacheHit, engine: result.engine, model: result.model, device: result.device, objectCount: result.objects.length };
    } finally { await this.cleanup(token); }
  }
  async read(cacheId) { const directory = this.results.get(cacheId); if (!directory) throw Error('节奏缓存句柄无效'); await this.manifest(directory); return new Uint8Array(await readFile(join(directory, 'rhythm.json'))); }
}

export function installAudioMapper({ ipcMain, service, origin, window: getWindow, dialog }) {
  ipcMain.handle('rpen-audio-mapper', async (event, { action, args = [] } = {}) => {
    try {
      if (event.sender !== getWindow()?.webContents || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith(origin + '/') || !Array.isArray(args)) throw Error('无权限');
      if (action === 'install' || action === 'choosePython') {
        let gpu = false;
        if (action === 'install') { const answer = await dialog.showMessageBox(getWindow(), { type: 'question', message: '安装独立 Mapperatorinator 环境？', detail: '选择 Python 3.10–3.12，新建推理环境。NVIDIA 加速需下载数 GB；首次生成另行下载所选模型。音频留在本机。', buttons: ['NVIDIA 加速', 'CPU', '取消'], defaultId: 1, cancelId: 2 }); if (answer.response === 2) return { ok: true, result: null }; gpu = answer.response === 0; }
        const selected = await dialog.showOpenDialog(getWindow(), { title: '选择 Python 可执行文件', properties: ['openFile'] }); if (selected.canceled) return { ok: true, result: null };
        if (action === 'install') return { ok: true, result: await service.install(selected.filePaths[0], gpu) };
        const source = await dialog.showOpenDialog(getWindow(), { title: '选择 Mapperatorinator 源码根目录', properties: ['openDirectory'] }); if (source.canceled) return { ok: true, result: null };
        await service.configureExisting(selected.filePaths[0], source.filePaths[0]); return { ok: true, result: await service.probe() };
      }
      if (!['probe', 'begin', 'write', 'execute', 'read', 'cancel', 'clear'].includes(action)) throw Error('不支持的节奏生成操作'); return { ok: true, result: await service[action](...args) };
    } catch (error) { return { ok: false, error: { name: error.name, message: error.message } }; }
  });
}
