import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, stat, realpath } from 'node:fs/promises';
import { join, resolve, sep, isAbsolute } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readZip } from '../src/platform/archive.mjs';

const UV_VERSION = '0.13.5', PYTHON_VERSION = '3.12.14';
const packages = Object.freeze({
  'win32/x64': ['x86_64-pc-windows-msvc.zip', 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a'],
  'win32/arm64': ['aarch64-pc-windows-msvc.zip', '09f47edf90726084a70f9426f6e3ca4f46e9bf7cbf23b1716ec64d60b055fae3'],
  'darwin/x64': ['x86_64-apple-darwin.tar.gz', 'b0f52b0e3945b4107d89024ea38e625683011fbfc05a0d98f9fa2d6dcee28c66'],
  'darwin/arm64': ['aarch64-apple-darwin.tar.gz', '743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73'],
  'linux/x64': ['x86_64-unknown-linux-gnu.tar.gz', 'f68d291c75783122dad58ab77def0e13f3233f358731db5d6d7e8715603b928f'],
  'linux/arm64': ['aarch64-unknown-linux-gnu.tar.gz', '4bb69cf95ed13f23713bb7bc09f241896ea0c75b7c557e615a20604b82f9c403'],
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const checkSignal = signal => { if (signal?.aborted) throw Object.assign(Error('环境安装已取消'), { name: 'AbortError' }); };

export function audioSetupTarget(platform = process.platform, arch = process.arch) {
  const entry = packages[platform + '/' + arch];
  return entry ? { filename: 'uv-' + entry[0], sha256: entry[1], platform, arch, pythonVersion: PYTHON_VERSION, url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${entry[0]}` } : null;
}

export function separationSetupSupport(platform = process.platform, arch = process.arch) {
  const supported = ['win32/x64', 'darwin/arm64', 'linux/x64'].includes(platform + '/' + arch);
  return { supported, platform, arch, message: supported ? '可一键准备独立声部分离环境' : '此平台暂无完整的预编译分离依赖，请选择已有环境，或导入其他工具分离出的声部。' };
}

export async function extractAudioSetupTool(archive, target) {
  if (digest(archive) !== target.sha256) throw Error('环境工具下载校验失败，请重新安装');
  if (target.filename.endsWith('.zip')) {
    const files = await readZip(archive, { maxFiles: 20, maxBytes: 160 * 1024 ** 2, maxFileBytes: 100 * 1024 ** 2, includeEntry: name => name === 'uv.exe' });
    const binary = files.get('uv.exe'); if (!binary?.length) throw Error('环境工具安装包缺少可执行文件'); return binary;
  }
  const tar = gunzipSync(archive, { maxOutputLength: 160 * 1024 ** 2 }), expected = target.filename.replace(/\.tar\.gz$/, '') + '/uv';
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512), name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, ''), prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8), path = prefix ? prefix + '/' + name : name;
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw Error('环境工具安装包损坏');
    if (path === expected && [0, 48].includes(header[156]) && size > 0 && size <= 100 * 1024 ** 2) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw Error('环境工具安装包缺少可执行文件');
}

async function downloadTool(target, signal, progress, fetcher) {
  const response = await fetcher(target.url, { signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(600000)]) });
  if (!response.ok || !response.body) throw Error(`下载环境工具失败（HTTP ${response.status}），请检查网络后重试`);
  const chunks = [], total = Number(response.headers.get('content-length')) || 0; let length = 0, lastReported = -1;
  const reader = response.body.getReader();
  try {
    while (true) {
      checkSignal(signal); const { value, done } = await reader.read(); if (done) break;
      length += value.length; if (length > 32 * 1024 ** 2) throw Error('环境工具下载大小异常'); chunks.push(value);
      const percent = total ? Math.floor(length / total * 100) : Math.floor(length / 1024 ** 2); if (percent !== lastReported) { lastReported = percent; progress({ id: 'environment', stage: 'bootstrap', message: `下载环境工具${total ? ' ' + percent + '%' : ' ' + percent + ' MiB'}…` }); }
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, length);
}

export async function prepareAudioPython(runtime, signal, { target = audioSetupTarget(), fetcher = fetch } = {}) {
  if (!target) throw Error('此系统暂不支持一键安装，请使用已有 Python 环境或导入外部分离的声部');
  checkSignal(signal); const directory = join(runtime.root, 'bootstrap', UV_VERSION), executable = join(directory, target.platform === 'win32' ? 'uv.exe' : 'uv'); await mkdir(directory, { recursive: true });
  let valid = false;
  try { const saved = JSON.parse(await readFile(join(directory, 'verified.json'), 'utf8')); valid = saved.archive === target.sha256 && saved.binary === digest(await readFile(executable)); } catch {}
  if (!valid) {
    const archive = await downloadTool(target, signal, runtime.progress, fetcher), binary = await extractAudioSetupTool(archive, target); checkSignal(signal);
    const pending = executable + '.pending'; await writeFile(pending, binary); await chmod(pending, 0o755); await rename(pending, executable); await writeFile(join(directory, 'verified.json'), JSON.stringify({ archive: target.sha256, binary: digest(binary) }));
  }
  const pythonRoot = join(runtime.root, 'python'), cache = join(runtime.dataRoot ?? runtime.root, 'download-cache'), temporary = join(runtime.dataRoot ?? runtime.root, 'temp'); await mkdir(temporary, { recursive: true });
  const env = { ...runtime.environment(), TEMP: temporary, TMP: temporary, UV_PYTHON_INSTALL_DIR: pythonRoot, UV_CACHE_DIR: cache, UV_PYTHON_BIN_DIR: join(runtime.root, 'python-bin'), UV_NO_PROGRESS: '1', UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'automatic' };
  runtime.progress({ id: 'environment', stage: 'python', message: `准备独立 Python ${PYTHON_VERSION}，无需修改系统 Python…` });
  await runtime.run(executable, ['python', 'install', PYTHON_VERSION, '--no-bin', ...(target.platform === 'win32' ? ['--no-registry'] : []), '--no-progress', '--no-config'], { signal, id: 'environment', env });
  const found = await runtime.run(executable, ['python', 'find', PYTHON_VERSION, '--managed-python', '--no-project', '--no-config'], { signal, env, outputFormat: 'text', timeout: 30000 });
  checkSignal(signal); if (typeof found !== 'string' || !isAbsolute(found)) throw Error('未找到安装后的独立 Python');
  const python = await realpath(found), parent = await realpath(pythonRoot), inside = target.platform === 'win32' ? python.toLowerCase().startsWith(parent.toLowerCase() + sep) : python.startsWith(parent + sep);
  if (!inside || !(await stat(python)).isFile()) throw Error('独立 Python 路径无效'); return python;
}
