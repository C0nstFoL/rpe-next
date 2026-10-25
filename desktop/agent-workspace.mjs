import { mkdir, lstat, readdir, readFile, writeFile, rename, rm, realpath, open } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { agentWorkspacePath, agentDownloadUrl } from '../src/core/agent-files.mjs';

const MAX_FILE = 128 * 1024 ** 2;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => { const path = relative(root, target); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')); };
const aborted = signal => { if (signal?.aborted) throw Object.assign(Error('文件操作已取消'), { name: 'AbortError' }); };
const publicAddress = address => {
  if (address.includes(':')) return !/^(::|f[cd]|fe[89ab]|ff)/i.test(address);
  const parts = address.split('.').map(Number), first = parts[0], second = parts[1];
  return first > 0 && first < 224 && ![10, 127].includes(first) && !(first === 169 && second === 254) && !(first === 172 && second >= 16 && second <= 31) && !(first === 192 && second === 168) && !(first === 100 && second >= 64 && second <= 127);
};

export class AgentWorkspaceService {
  constructor(root, { fetcher = fetch, openFolder, resolver = lookup } = {}) { this.root = resolve(root); this.fetcher = fetcher; this.openFolder = openFolder; this.resolver = resolver; }
  async directory(workspace) {
    if (typeof workspace !== 'string' || !workspace || workspace.length > 256) throw Error('工作区标识无效');
    await mkdir(this.root, { recursive: true }); const directory = join(await realpath(this.root), hash(workspace));
    await mkdir(directory, { recursive: true }); if ((await lstat(directory)).isSymbolicLink()) throw Error('工作区不能是符号链接'); return directory;
  }
  async target(workspace, name, { root = false } = {}) {
    name = agentWorkspacePath(name, { root }); const directory = await this.directory(workspace), target = resolve(directory, name);
    if (!inside(directory, target)) throw Error('路径超出工作区');
    let current = directory;
    for (const part of name.split('/').filter(Boolean)) {
      current = join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw Error('工作区不允许访问符号链接'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return target;
  }
  async stat(workspace, { path = '' } = {}) {
    const target = await this.target(workspace, path, { root: true });
    try { const info = await lstat(target); return { path, kind: info.isDirectory() ? 'directory' : 'file', bytes: info.size, modifiedAt: info.mtimeMs, hash: info.isFile() && info.size <= MAX_FILE ? hash(await readFile(target)) : null }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async info(workspace) { return { platform: 'desktop', root: await this.directory(workspace), maximumFileBytes: MAX_FILE }; }
  async list(workspace, { path = '', offset = 0, limit = 100, recursive = false } = {}) {
    await this.target(workspace, path, { root: true }); const entries = [];
    const visit = async prefix => {
      for (const entry of await readdir(await this.target(workspace, prefix, { root: true }), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const name = prefix ? prefix + '/' + entry.name : entry.name;
        const info = await lstat(await this.target(workspace, name)); entries.push({ path: name, kind: entry.isDirectory() ? 'directory' : 'file', bytes: info.size });
        if (entries.length > 20000) throw Error('工作区文件过多，请缩小目录范围');
        if (recursive && entry.isDirectory()) await visit(name);
      }
    };
    await visit(path); entries.sort((first, second) => first.path.localeCompare(second.path)); return { total: entries.length, entries: entries.slice(offset, offset + Math.min(200, limit)) };
  }
  async bytes(workspace, { path }) {
    const target = await this.target(workspace, path), info = await lstat(target); if (!info.isFile() || info.size > MAX_FILE) throw Error('文件类型无效或超过 128 MiB'); return new Uint8Array(await readFile(target));
  }
  async read(workspace, { path, format = 'text', offset = 0, limit = 12000 }) {
    if (format === 'info') return this.stat(workspace, { path });
    const bytes = await this.bytes(workspace, { path });
    if (format === 'base64') return { path, bytes: bytes.length, offset, offsetUnit: 'bytes', base64: Buffer.from(bytes.subarray(offset, offset + Math.min(limit, 1000000))).toString('base64'), nextOffset: Math.min(bytes.length, offset + limit) };
    if (bytes.length > 32 * 1024 ** 2) throw Error('文本文件超过 32 MiB，请读取文件信息或二进制片段');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), end = Math.min(text.length, offset + Math.min(limit, 1000000));
    return { path, bytes: bytes.length, characters: text.length, offset, offsetUnit: 'characters', text: text.slice(offset, end), nextOffset: end, eof: end >= text.length };
  }
  async check(workspace, path, expectedHash) {
    const current = await this.stat(workspace, { path });
    if (expectedHash !== undefined && (current?.hash ?? null) !== expectedHash) throw Error('文件已变化，请重新读取后生成方案'); return current;
  }
  async write(workspace, { path, text, base64, expectedHash, overwrite = false }, signal) {
    aborted(signal); const target = await this.target(workspace, path), previous = await this.check(workspace, path, expectedHash);
    if (previous && (!overwrite || previous.kind !== 'file')) throw Error('目标已存在；覆盖文件需明确指定 overwrite');
    if ((text !== undefined) === (base64 !== undefined)) throw Error('text 和 base64 必须且只能提供一个');
    const bytes = text !== undefined ? Buffer.from(text, 'utf8') : Buffer.from(base64, 'base64'); if (bytes.length > MAX_FILE) throw Error('文件超过 128 MiB');
    expectedHash ??= previous?.hash ?? null;
    await mkdir(dirname(target), { recursive: true }); await this.target(workspace, path);
    const temporary = target + '.agent-' + randomUUID();
    try { await writeFile(temporary, bytes, { flag: 'wx' }); aborted(signal); await this.check(workspace, path, expectedHash); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
    return this.stat(workspace, { path });
  }
  async mkdir(workspace, { path }) { const target = await this.target(workspace, path); await mkdir(target, { recursive: true }); return this.stat(workspace, { path }); }
  async delete(workspace, { path, recursive = false, expectedHash }) {
    const target = await this.target(workspace, path), previous = await this.check(workspace, path, expectedHash); if (!previous) throw Error('文件不存在');
    if (previous.kind === 'directory' && !recursive && (await readdir(target)).length) throw Error('目录非空，删除需要 recursive=true');
    await rm(target, { recursive: previous.kind === 'directory', force: false }); return { deleted: path };
  }
  async move(workspace, { path, to, overwrite = false, expectedHash, destinationHash }) {
    const source = await this.target(workspace, path), target = await this.target(workspace, to); await this.check(workspace, path, expectedHash);
    if (source === target || inside(source, target)) throw Error('目标不能是源路径或其子目录');
    const destination = await this.check(workspace, to, destinationHash); if (destination && (!overwrite || destination.kind !== 'file')) throw Error('移动目标已存在');
    await mkdir(dirname(target), { recursive: true }); await this.target(workspace, to); await rename(source, target); return this.stat(workspace, { path: to });
  }
  async download(workspace, { url, path, maxBytes = MAX_FILE, overwrite = false, expectedHash }, signal) {
    url = agentDownloadUrl(url); const target = await this.target(workspace, path), previous = await this.check(workspace, path, expectedHash); if (previous && (!overwrite || previous.kind !== 'file')) throw Error('目标文件已存在');
    expectedHash ??= previous?.hash ?? null;
    let response;
    for (let redirects = 0; redirects <= 5; redirects++) {
      aborted(signal); const addresses = await this.resolver(new URL(url).hostname, { all: true }); if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw Error('下载地址解析为本地或内网地址');
      aborted(signal);
      response = await this.fetcher(url, { signal, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { if (redirects === 5) throw Error('下载重定向过多'); await response.body?.cancel(); url = agentDownloadUrl(new URL(response.headers.get('location'), url).href); continue; } break;
    }
    if (!response.ok || !response.body) throw Error('下载失败：HTTP ' + response.status);
    const maximum = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(MAX_FILE, maxBytes) : MAX_FILE, reader = response.body.getReader(); let length = 0, handle;
    await mkdir(dirname(target), { recursive: true }); await this.target(workspace, path); const temporary = target + '.agent-' + randomUUID();
    try {
      handle = await open(temporary, 'wx');
      for (;;) { const { value, done } = await reader.read(); if (done) break; aborted(signal); length += value.length; if (length > maximum) throw Error('下载文件超出大小限制'); await handle.writeFile(value); }
      await handle.close(); handle = null; aborted(signal); await this.check(workspace, path, expectedHash); await rename(temporary, target);
    } finally { await handle?.close(); await reader.cancel().catch(() => {}); await rm(temporary, { force: true }); }
    const result = await this.stat(workspace, { path });
    return { ...result, url, contentType: response.headers.get('content-type') };
  }
  async open(workspace) { if (this.openFolder) await this.openFolder(await this.directory(workspace)); return this.info(workspace); }
}

export function installAgentWorkspace({ ipcMain, service, origin, window: getWindow }) {
  const controllers = new Map(), allowed = new Set(['info', 'stat', 'list', 'read', 'bytes', 'write', 'mkdir', 'move', 'delete', 'download', 'open']);
  const permitted = event => event.sender === getWindow()?.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(origin + '/');
  ipcMain.on('rpen-agent-workspace-cancel', (event, id) => { if (permitted(event)) controllers.get(id)?.abort(); });
  ipcMain.handle('rpen-agent-workspace', async (event, { id, workspace, action, args = {} } = {}) => {
    if (!permitted(event) || !allowed.has(action) || typeof id !== 'string' || controllers.has(id) || controllers.size >= 4) return { ok: false, message: '工作区请求无效' };
    const controller = new AbortController(); controllers.set(id, controller); const timer = setTimeout(() => controller.abort(), 600000);
    try { return { ok: true, result: await service[action](workspace, args, controller.signal) }; }
    catch (error) { return { ok: false, message: error.message, name: error.name }; }
    finally { clearTimeout(timer); controllers.delete(id); }
  });
  return () => { for (const controller of controllers.values()) controller.abort(); };
}
