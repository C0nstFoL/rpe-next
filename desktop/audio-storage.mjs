import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, open, rename, rm, readdir, lstat, stat, realpath, statfs, unlink, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const toolNames = { separation: '声部分离', onsets: '起音检测', mapper: 'AI 节奏生成' };
const directories = ['models', 'cache', 'pip-cache', 'download-cache', 'kernel-cache', 'temp', 'jobs'];
const cacheDirectories = directories.filter(name => name !== 'models');
const markerName = '.rpen-audio-storage.json';
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep); };
const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const digest = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); };
const busy = () => Object.assign(Error('音频工具正在使用或迁移数据，请等待任务结束后重试'), { name: 'StorageBusyError' });

async function readJson(path) {
  const info = await exists(path); if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw Error('音频存储配置文件类型异常');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function atomicJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), '.audio-write-' + randomUUID()); let file;
  try {
    file = await open(temporary, 'wx'); await file.writeFile(JSON.stringify(data)); await file.sync(); await file.close(); file = null;
    await rename(temporary, path);
  } finally { await file?.close(); await rm(temporary, { force: true }).catch(() => {}); }
}

async function inventory(paths, selectedDirectories = directories) {
  const files = [], folders = [];
  for (const [id, root] of Object.entries(paths)) {
    const rootInfo = await exists(root); if (!rootInfo) continue;
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('音频工具数据目录必须是普通文件夹：' + root);
    const canonical = await realpath(root);
    const walk = async (path, boundary) => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await realpath(path), targetInfo = await stat(target);
        if (!inside(boundary, target) || !targetInfo.isFile()) throw Error('模型或缓存包含指向目录外的链接，已停止迁移：' + path);
        files.push({ id, path, readPath: target, name: relative(root, path), size: targetInfo.size, modified: info.mtimeMs, entrySize: info.size, linked: true });
      } else if (info.isDirectory()) {
        const readPath = await realpath(path); if (!inside(canonical, readPath)) throw Error('音频数据目录越界：' + path);
        folders.push({ id, path, readPath, name: relative(root, path) });
        for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), boundary);
      } else if (info.isFile()) files.push({ id, path, readPath: await realpath(path), name: relative(root, path), size: info.size, entrySize: info.size, modified: info.mtimeMs, linked: false });
      else throw Error('模型或缓存中存在不支持的文件类型：' + path);
    };
    for (const name of selectedDirectories) {
      const path = join(root, name), info = await exists(path); if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('音频数据子目录必须是普通文件夹：' + path);
      await walk(path, await realpath(path));
    }
  }
  return { files, folders };
}

function sameInventory(first, second) {
  const signature = entry => JSON.stringify([entry.id, entry.name, entry.size, entry.entrySize, entry.modified, entry.linked]);
  return first.files.length === second.files.length && first.folders.length === second.folders.length && first.files.every((entry, index) => signature(entry) === signature(second.files[index])) && first.folders.every((entry, index) => entry.id === second.folders[index].id && entry.name === second.folders[index].name);
}

export async function withAudioStorage(service, task, action) {
  if (!service.storage) return task();
  if (['install', 'installManual', 'choosePython', 'begin'].includes(action) && !await service.storage.prepare()) throw Object.assign(Error('已取消音频存储设置，未启动音频任务'), { name: 'AbortError' });
  return service.storage.access(task);
}

export class AudioStorage {
  constructor(configPath, roots, { progress = () => {}, fault = () => {}, availableSpace = async path => { const info = await statfs(path, { bigint: true }); return info.bavail * info.bsize; } } = {}) {
    this.configPath = resolve(configPath); this.roots = Object.fromEntries(Object.entries(roots).map(([id, root]) => [id, resolve(root)])); this.paths = { ...this.roots };
    this.services = new Map(); this.active = 0; this.progress = progress; this.fault = fault; this.availableSpace = availableSpace; this.warnings = [];
  }
  async initialize() {
    const config = await readJson(this.configPath);
    if (config) {
      if (config.version !== 1 || !isAbsolute(config.root ?? '') || !/^[a-f0-9-]{36}$/.test(config.id ?? '')) throw Error('音频存储配置无效');
      if (config.runtimeRoots) {
        if (Object.keys(config.runtimeRoots).length !== Object.keys(this.roots).length || Object.keys(this.roots).some(id => !Object.hasOwn(config.runtimeRoots, id) || !isAbsolute(config.runtimeRoots[id] ?? ''))) throw Error('音频运行环境位置配置无效');
        this.roots = Object.fromEntries(Object.entries(config.runtimeRoots).map(([id, root]) => [id, resolve(root)]));
      }
      this.location = resolve(config.root); this.paths = Object.fromEntries(Object.keys(this.roots).map(id => [id, join(this.location, 'audio-' + id)]));
      try {
        const marker = await readJson(join(this.location, markerName));
        if (marker?.id !== config.id || marker?.format !== 'rpen-audio-storage' || marker?.version !== 1 || marker?.complete !== true) throw Error('目录标识不匹配');
        if ((await lstat(this.location)).isSymbolicLink()) throw Error('存储目录已被替换为链接');
        for (const root of Object.values(this.paths)) {
          if ((await lstat(root)).isSymbolicLink()) throw Error('工具目录已被替换为链接');
          for (const name of directories) if ((await exists(join(root, name)))?.isSymbolicLink()) throw Error('音频数据子目录已被替换为链接');
        }
      } catch (error) { this.error = '音频模型与缓存目录不可用，请恢复该目录或连接对应磁盘：' + this.location + '（' + error.message + '）'; }
    }
    const pending = await readJson(this.configPath + '.migration');
    if (pending?.destination) this.warnings.push((this.location === pending.destination ? '上次迁移已切换至新目录；部分原缓存可能尚未清理。' : '上次迁移未完成，仍使用原目录；未完成的副本保留于：') + pending.destination);
    return this;
  }
  attach(id, service) { if (!(id in this.roots)) throw Error('音频工具不存在'); this.services.set(id, service); service.root = this.roots[id]; service.dataRoot = this.paths[id]; service.storage = this; }
  assertIdle() { if (this.error) throw Error(this.error); if (this.active || [...this.services.values()].some(service => service.jobs?.size || service.installing || service.beginning)) throw busy(); }
  async access(task) {
    if (this.migrating || this.cleaning) throw busy(); if (this.error) throw Error(this.error);
    this.active++; try { return await task(); } finally { this.active--; }
  }
  status() {
    return { migrating: Boolean(this.migrating), cleaning: Boolean(this.cleaning), needsSetup: !this.location, error: this.error ?? null, warnings: [...this.warnings], tools: Object.entries(this.paths).map(([id, root]) => ({ id, name: toolNames[id], root, models: join(root, 'models'), cache: join(root, 'cache'), downloads: join(root, 'pip-cache'), runtime: this.roots[id] })) };
  }
  async prepare() {
    if (this.error) throw Error(this.error); if (this.location) return true;
    if (!this.requestSetup) throw Error('请先在音频分析中选择本机音频工具的存放位置');
    if (!this.preparing) this.preparing = Promise.resolve().then(() => this.requestSetup()).finally(() => { this.preparing = null; });
    return this.preparing;
  }
  async directory(id, kind) {
    if (!Object.hasOwn(this.paths, id) || !['root', 'models', 'cache', 'pip-cache'].includes(kind)) throw Error('音频目录参数无效');
    const root = this.paths[id], path = kind === 'root' ? root : join(root, kind);
    const info = await exists(path); if (info?.isSymbolicLink() || info && !info.isDirectory()) throw Error('音频目录类型异常');
    await mkdir(path, { recursive: true }); if (!inside(await realpath(root), await realpath(path))) throw Error('音频目录越界'); return path;
  }
  async migrate(parent, { firstUse = false } = {}) {
    if (this.migrating || this.cleaning) throw busy(); this.assertIdle(); this.migrating = true;
    const previous = { ...this.paths }, id = randomUUID(); let destination, created = false, committed = false;
    try {
      if (typeof parent !== 'string' || !isAbsolute(parent)) throw Error('请选择有效的目标文件夹');
      parent = await realpath(parent); if (!(await stat(parent)).isDirectory()) throw Error('目标不是文件夹');
      destination = join(parent, 'RPEN-Audio');
      for (const root of new Set([...Object.values(this.roots), ...Object.values(previous)])) {
        const canonical = await exists(root) ? await realpath(root) : resolve(root);
        if (inside(canonical, destination) || inside(destination, canonical)) throw Error('目标目录不能与原音频目录重叠或相互包含');
      }
      if (await exists(destination)) throw Error('目标中的 RPEN-Audio 已存在，请选择其他文件夹；不会覆盖已有文件');
      this.progress({ stage: 'scan', message: '正在检查模型、缓存和目标磁盘空间…' });
      const source = await inventory(previous), bytes = source.files.reduce((sum, entry) => sum + entry.size, 0);
      const free = await this.availableSpace(parent), required = BigInt(bytes) + BigInt(Math.max(64 * 1024 ** 2, Math.ceil(bytes * .05)));
      if (BigInt(free) < required) throw Error('目标磁盘空间不足，需保留迁移数据及至少 5% 或 64 MiB 的余量');
      await mkdir(destination); created = true;
      await atomicJson(join(destination, markerName), { format: 'rpen-audio-storage', version: 1, id, complete: false });
      await atomicJson(this.configPath + '.migration', { version: 1, id, destination });
      const next = Object.fromEntries(Object.keys(previous).map(tool => [tool, join(destination, 'audio-' + tool)]));
      const runtimeRoots = { ...this.roots };
      if (firstUse) for (const [tool, root] of Object.entries(this.roots)) {
        const existing = await Promise.all(['config.json', 'runtime', 'managed-runtime-v1', 'python', 'source', 'bootstrap'].map(name => exists(join(root, name))));
        if (!existing.some(Boolean)) runtimeRoots[tool] = next[tool];
      }
      for (const root of Object.values(next)) await mkdir(join(root, 'temp'), { recursive: true });
      for (const folder of source.folders) await mkdir(join(next[folder.id], folder.name), { recursive: true });
      let copied = 0, lastReport = 0;
      const report = () => { if (Date.now() - lastReport >= 100 || copied === bytes) { this.progress({ stage: 'copy', copied, total: bytes, message: '正在复制并校验模型与缓存…' }); lastReport = Date.now(); } };
      for (const entry of source.files) {
        const target = join(next[entry.id], entry.name), hash = createHash('sha256');
        await mkdir(dirname(target), { recursive: true });
        await pipeline(createReadStream(entry.readPath), new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); copied += chunk.length; report(); callback(null, chunk); } }), createWriteStream(target, { flags: 'wx' }));
        const handle = await open(target, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
        entry.hash = hash.digest('hex'); await this.fault('copied', { source: entry.path, target });
        if ((await lstat(target)).size !== entry.size || await digest(target) !== entry.hash) throw Error('迁移副本校验失败，原文件保留：' + entry.name);
      }
      if (!sameInventory(source, await inventory(previous))) throw Error('原文件在迁移期间发生变化，已停止切换，原目录仍在使用');
      await atomicJson(join(destination, markerName), { format: 'rpen-audio-storage', version: 1, id, complete: true });
      await this.fault('beforeCommit', { destination });
      await atomicJson(this.configPath, { version: 1, id, root: destination, runtimeRoots }); committed = true;
      this.paths = next; this.roots = runtimeRoots; this.location = destination; this.warnings = [];
      for (const [tool, service] of this.services) {
        service.root = runtimeRoots[tool]; service.dataRoot = next[tool];
        for (const [key, path] of service.results ?? []) if (inside(previous[tool], path)) service.results.set(key, join(next[tool], relative(previous[tool], path)));
      }
      this.progress({ stage: 'cleanup', copied: bytes, total: bytes, message: '已切换至新目录，正在清理已校验的原缓存…' });
      try {
        await this.fault('afterCommit', { destination });
        for (const entry of [...source.files.filter(entry => entry.linked), ...source.files.filter(entry => !entry.linked)]) {
          const info = await lstat(entry.path);
          if (info.mtimeMs !== entry.modified || info.size !== entry.entrySize || info.isSymbolicLink() !== entry.linked || await realpath(entry.path) !== entry.readPath || await digest(entry.path) !== entry.hash) throw Error('原文件已变化，保留剩余原缓存：' + entry.path);
          if (await digest(join(next[entry.id], entry.name)) !== entry.hash) throw Error('新副本已变化，保留剩余原缓存：' + entry.path);
          await unlink(entry.path);
        }
        for (const folder of [...source.folders].reverse()) { try { if (await realpath(folder.path) === folder.readPath) await rmdir(folder.path); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; } }
        await rm(this.configPath + '.migration', { force: true });
      } catch (error) { this.warnings.push('迁移已完成，部分原缓存保留，可核对后清理：' + error.message); }
      this.progress({ stage: 'done', copied: bytes, total: bytes, message: this.warnings.length ? '迁移完成，部分原缓存已保留' : '模型与缓存已迁移' });
      return { ...this.status(), migrating: false, bytes, files: source.files.length };
    } catch (error) {
      if (created && !committed) { this.warnings.push('未完成的迁移副本保留于：' + destination); error.message += '\n未切换存储位置，原文件保留。未完成副本：' + destination; }
      this.progress({ stage: 'error', message: error.message }); throw error;
    } finally { this.migrating = false; }
  }
  async clearCaches() {
    if (this.migrating || this.cleaning) throw busy(); this.assertIdle(); this.cleaning = true;
    let bytes = 0, files = 0, invalidated = false; const warnings = [];
    try {
      const paths = {};
      for (const [id, root] of Object.entries(this.paths)) { paths[id] = root; if (root !== this.roots[id]) paths[id + '-runtime'] = this.roots[id]; }
      this.progress({ stage: 'clear-scan', message: '正在检查全部谱面的音频缓存…' });
      const source = await inventory(paths, cacheDirectories);
      for (const service of this.services.values()) service.results?.clear();
      invalidated = true;
      for (const entry of [...source.files.filter(entry => entry.linked), ...source.files.filter(entry => !entry.linked)]) {
        try {
          await this.fault('beforeClearFile', { source: entry.path }); const info = await lstat(entry.path);
          if (info.mtimeMs !== entry.modified || info.size !== entry.entrySize || info.isSymbolicLink() !== entry.linked || await realpath(entry.path) !== entry.readPath) throw Error('文件已变化，保留：' + entry.path);
          await unlink(entry.path); bytes += entry.size; files++;
        } catch (error) { if (error.code !== 'ENOENT') warnings.push(error.message); }
      }
      for (const folder of [...source.folders].reverse()) {
        try { if (await realpath(folder.path) === folder.readPath) await rmdir(folder.path); }
        catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) warnings.push(error.message); }
      }
      for (const service of this.services.values()) await mkdir(join(service.dataRoot, 'temp'), { recursive: true });
      this.progress({ stage: 'cleared', message: warnings.length ? '音频缓存已清理，部分文件保留' : '全部谱面的音频缓存已清理', files, bytes, warnings });
      return { files, bytes, warnings };
    } catch (error) {
      if (invalidated) this.progress({ stage: 'cleared', message: '部分音频缓存已清理：' + error.message, files, bytes, warnings: [...warnings, error.message] });
      throw error;
    } finally { this.cleaning = false; }
  }
}

export function installAudioStorage({ ipcMain, service, origin, window: getWindow, dialog, shell }) {
  service.requestSetup = async () => {
    if (service.migrating || service.cleaning) throw busy(); service.assertIdle();
    const window = getWindow(), answer = await dialog.showMessageBox(window, { type: 'info', message: '首次使用本机音频工具：选择存放位置', detail: '声部分离与 AI 采音需要下载运行环境和模型，可能占用数 GB 至数十 GB；处理结果、安装包和临时缓存也会继续增长。\n\n请选择有足够空间的文件夹，建议使用非系统盘。新安装的环境、模型和缓存将存放于所选文件夹的 RPEN-Audio 中；已有运行环境保留原位，模型与缓存会安全迁移。以后可在“音频分析 → 模型与缓存位置”中查看和迁移，或清理全部谱面的音频缓存。', buttons: ['选择存放位置', '取消'], defaultId: 0, cancelId: 1 });
    if (answer.response !== 0) return false;
    const selected = await dialog.showOpenDialog(window, { title: '选择音频环境、模型与缓存的存放位置', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled) return false;
    await service.migrate(selected.filePaths[0], { firstUse: true }); return true;
  };
  ipcMain.handle('rpen-audio-storage', async (event, { action, id, kind } = {}) => {
    try {
      const window = getWindow();
      if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith(origin + '/')) throw Error('无权限');
      if (action === 'status') return { ok: true, result: service.status() };
      if (action === 'prepare') return { ok: true, result: await service.prepare() };
      if (action === 'open') return await service.access(async () => { const error = await shell.openPath(await service.directory(id, kind)); if (error) throw Error(error); return { ok: true, result: true }; });
      if (action === 'clear') {
        if (service.migrating || service.cleaning) throw busy(); service.assertIdle();
        const answer = await dialog.showMessageBox(window, { type: 'warning', message: '清理全部谱面的音频缓存？', detail: '将清理本机声部分离、起音检测和 AI 节奏生成的结果缓存，以及安装下载、推理和临时缓存。范围包含所有谱面，不限于当前谱面。\n\n保留已下载的模型、Python 运行环境、原音乐和谱面文件。当前会话的分离音源和采音预览也将清除，需要时可重新生成；安装下载缓存清理后，更新环境可能需要重新下载。', buttons: ['清理全部音频缓存', '取消'], defaultId: 1, cancelId: 1 });
        if (answer.response !== 0) return { ok: true, result: null };
        return { ok: true, result: await service.clearCaches() };
      }
      if (action !== 'migrate') throw Error('不支持的音频存储操作');
      if (service.migrating || service.cleaning) throw busy(); service.assertIdle();
      const selected = await dialog.showOpenDialog(window, { title: '选择模型与缓存的目标文件夹（将在其中创建 RPEN-Audio）', properties: ['openDirectory', 'createDirectory'] });
      if (selected.canceled) return { ok: true, result: null };
      const answer = await dialog.showMessageBox(window, { type: 'question', message: '迁移音频模型与缓存？', detail: '目标：' + join(selected.filePaths[0], 'RPEN-Audio') + '\n\n迁移三套音频工具的模型、结果、下载及临时缓存。复制并逐文件校验后才切换位置和清理原缓存；不会覆盖已有目标。Python 运行环境保留原位，谱面与原音乐不变。', buttons: ['迁移', '取消'], defaultId: 1, cancelId: 1 });
      if (answer.response !== 0) return { ok: true, result: null };
      return { ok: true, result: await service.migrate(selected.filePaths[0]) };
    } catch (error) { return { ok: false, error: { name: error.name, message: error.message } }; }
  });
}
