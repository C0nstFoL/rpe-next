import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';

export class PythonAudioRuntime {
  constructor(root, { script, python, dataRoot = root, progress = () => {}, launcher = spawn } = {}) {
    this.root = resolve(root); this.dataRoot = resolve(dataRoot); this.script = script; this.python = python; this.progress = progress; this.launcher = launcher;
  }
  environment() { return { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HOME: join(this.dataRoot, 'models', 'huggingface'), TORCH_HOME: join(this.dataRoot, 'models', 'torch'), TMP: join(this.dataRoot, 'temp'), TEMP: join(this.dataRoot, 'temp'), TMPDIR: join(this.dataRoot, 'temp'), PIP_CACHE_DIR: join(this.dataRoot, 'pip-cache'), TORCHINDUCTOR_CACHE_DIR: join(this.dataRoot, 'kernel-cache'), CUDA_CACHE_PATH: join(this.dataRoot, 'kernel-cache', 'cuda'), XDG_CACHE_HOME: join(this.dataRoot, 'download-cache'), HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_XET: '1', OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4' }; }
  async configuredPython() {
    if (this.python) return this.python;
    try { const value = JSON.parse(await readFile(join(this.root, 'config.json'), 'utf8')); if (isAbsolute(value.python)) return value.python; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const managed = join(this.root, 'runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    try { if ((await stat(managed)).isFile()) return managed; } catch {}
    throw Error('尚未配置本机音频工具环境，请选择已有的 Python 环境或安装独立环境');
  }
  async configure(python) {
    if (!isAbsolute(python) || !(await stat(python)).isFile()) throw Error('Python路径无效');
    await mkdir(this.root, { recursive: true }); await writeFile(join(this.root, 'config.json'), JSON.stringify({ python })); this.python = python;
  }
  run(executable, args, { signal, id, env = this.environment(), timeout = 60 * 60 * 1000, outputFormat = 'json' } = {}) {
    const aborted = () => Object.assign(Error('音频处理已取消'), { name: 'AbortError' });
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise((accept, reject) => {
      const child = this.launcher(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env }); let output = '', plain = '', errors = '', result, failure, settled = false;
      const kill = () => child.kill(); signal?.addEventListener('abort', kill, { once: true });
      const timer = setTimeout(() => { failure = '音频工具运行超时'; kill(); }, timeout);
      const line = value => { try { const data = JSON.parse(value); if (data.kind === 'result') result = data; else if (data.kind === 'error') failure = data.message; else if (data.kind === 'progress') this.progress({ id, ...data }); } catch { if (id) this.progress({ id, stage: 'environment', message: value.slice(-400) }); } };
      child.stdout.on('data', bytes => { if (outputFormat === 'text') { plain += bytes.toString(); if (plain.length > 16000) { failure = '音频工具输出过长'; kill(); } return; } output += bytes.toString(); let index; while ((index = output.indexOf('\n')) >= 0) { line(output.slice(0, index)); output = output.slice(index + 1); } if (output.length > 16000) output = output.slice(-16000); });
      child.stderr.on('data', bytes => { errors = (errors + bytes.toString()).slice(-6000); if (id) this.progress({ id, stage: 'log', message: bytes.toString().slice(-400) }); });
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', kill); if (error) reject(error); else accept(outputFormat === 'text' ? plain.trim() : result); };
      child.once('error', error => finish(error)); child.once('close', code => { if (output.trim()) line(output); finish(signal?.aborted ? aborted() : code ? Error(failure || errors.slice(-1800) || `音频工具退出：${code}`) : failure ? Error(failure) : null); });
    });
  }
}
