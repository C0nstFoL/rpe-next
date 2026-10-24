import { readLibraryRecord, writeLibraryRecord, writeLibraryRecords } from './library.mjs';
import { agentWorkspacePath, agentDownloadUrl } from '../core/agent-files.mjs';
import { checkAgentSignal } from '../core/agent-commands.mjs';

const MAX_FILE = 128 * 1024 ** 2;
const base64 = bytes => { let text = ''; for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, offset + 32768)); return btoa(text); };
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');

export class AgentWorkspace {
  constructor(getId, { bridge = globalThis.rpenAgentWorkspace, read = readLibraryRecord, write = writeLibraryRecord, batch, request = (...args) => fetch(...args) } = {}) { Object.assign(this, { getId, bridge, readRecord: read, writeRecord: write, request }); this.writeBatch = batch ?? (write === writeLibraryRecord ? writeLibraryRecords : async records => { for (const record of records) await write(record.key, record.value); }); }
  async call(action, args = {}, signal) {
    checkAgentSignal(signal); const workspace = this.getId(); if (!workspace) throw Error('请先打开谱面');
    if (this.bridge) {
      const id = crypto.randomUUID(); let cancelled;
      const cancellation = new Promise((resolve, reject) => { cancelled = reject; }), abort = () => { this.bridge.cancel(id); cancelled(new DOMException('文件操作已停止', 'AbortError')); }; signal?.addEventListener('abort', abort, { once: true });
      try { const response = await Promise.race([this.bridge.call(id, workspace, action, args), cancellation]); checkAgentSignal(signal); if (!response.ok) throw Object.assign(Error(response.message), { name: response.name || 'Error' }); return response.result; }
      finally { signal?.removeEventListener('abort', abort); }
    }
    return this.browser(workspace, action, args, signal);
  }
  async browser(workspace, action, args, signal) {
    const prefix = 'agent-files-v1:' + workspace + ':', index = await this.readRecord(prefix + 'index') ?? [], originalIndex = structuredClone(index), writes = [];
    const path = agentWorkspacePath(args.path, { root: ['info', 'open', 'stat', 'list'].includes(action) });
    const existing = index.find(entry => entry.path === path), read = name => this.readRecord(prefix + 'file:' + name), write = async (name, value) => { writes.push({ key: prefix + 'file:' + name, value }); };
    const check = (entry, expected) => { if (expected !== undefined && (entry?.hash ?? null) !== expected) throw Error('文件已变化，请重新读取'); };
    const saveIndex = () => this.writeBatch([...writes, { key: prefix + 'index', value: index }], { guard: { key: prefix + 'index', value: originalIndex } });
    const directories = name => {
      const parts = name.split('/');
      for (let length = 1; length < parts.length; length++) { const path = parts.slice(0, length).join('/'), previous = index.find(entry => entry.path === path); if (previous && previous.kind !== 'directory') throw Error('父路径不是目录'); if (!previous) index.push({ path, kind: 'directory', bytes: 0 }); }
    };
    if (action === 'info' || action === 'open') return { platform: 'browser', root: '本谱面 AI 工作区（浏览器存储）', maximumFileBytes: MAX_FILE };
    if (action === 'stat') return path ? existing ?? null : { path: '', kind: 'directory', bytes: 0 };
    if (action === 'list') {
      if (path && existing?.kind !== 'directory') throw Error('目录不存在或路径不是目录');
      const entries = index.filter(entry => !path || entry.path.startsWith(path + '/')).filter(entry => args.recursive || !(path ? entry.path.slice(path.length + 1) : entry.path).includes('/')).sort((first, second) => first.path.localeCompare(second.path));
      return { total: entries.length, entries: entries.slice(args.offset ?? 0, (args.offset ?? 0) + Math.min(200, args.limit ?? 100)) };
    }
    if (action === 'read' || action === 'bytes') {
      if (existing?.kind !== 'file') throw Error('文件不存在');
      if (args.format === 'info') return existing;
      const value = await read(path), bytes = value.bytes;
      if (action === 'bytes') return bytes;
      const offset = args.offset ?? 0, limit = args.limit ?? 12000;
      if (args.format === 'base64') return { path, bytes: bytes.length, offset, offsetUnit: 'bytes', base64: base64(bytes.subarray(offset, offset + limit)), nextOffset: Math.min(bytes.length, offset + limit) };
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), end = Math.min(text.length, offset + limit);
      return { path, bytes: bytes.length, text: text.slice(offset, end), offset, offsetUnit: 'characters', nextOffset: end, eof: end >= text.length };
    }
    if (action === 'download') {
      const response = await this.request(agentDownloadUrl(args.url), { signal, redirect: 'error' }); if (!response.ok || !response.body) throw Error('下载失败：HTTP ' + response.status);
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; checkAgentSignal(signal); length += value.length; if (length > Math.min(MAX_FILE, args.maxBytes ?? MAX_FILE)) throw Error('下载文件超出大小限制'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return this.browser(workspace, 'write', { path, base64: base64(bytes), overwrite: args.overwrite, expectedHash: args.expectedHash }, signal);
    }
    check(existing, args.expectedHash);
    if (action === 'write') {
      if (existing && (!args.overwrite || existing.kind !== 'file')) throw Error('文件已存在；覆盖需指定 overwrite');
      if ((args.text !== undefined) === (args.base64 !== undefined)) throw Error('text 和 base64 必须且只能提供一个');
      const bytes = args.text !== undefined ? new TextEncoder().encode(args.text) : Uint8Array.from(atob(args.base64), value => value.charCodeAt(0)); if (bytes.length > MAX_FILE) throw Error('文件超过 128 MiB');
      directories(path); const entry = { path, kind: 'file', bytes: bytes.length, hash: await hash(bytes), modifiedAt: Date.now() };
      checkAgentSignal(signal); await write(path, { bytes }); if (existing) index.splice(index.indexOf(existing), 1); index.push(entry); await saveIndex(); return entry;
    }
    if (action === 'mkdir') { if (existing && existing.kind !== 'directory') throw Error('路径已是文件'); directories(path); if (!existing) index.push({ path, kind: 'directory', bytes: 0 }); await saveIndex(); return index.find(entry => entry.path === path); }
    if (action === 'delete') {
      if (!existing) throw Error('文件不存在'); const entries = index.filter(entry => entry.path === path || entry.path.startsWith(path + '/'));
      if (entries.length > 1 && !args.recursive) throw Error('目录非空，需要 recursive=true');
      for (const entry of entries) { await write(entry.path, null); index.splice(index.indexOf(entry), 1); } await saveIndex(); return { deleted: path };
    }
    if (action === 'move') {
      if (!existing) throw Error('文件不存在'); const destination = agentWorkspacePath(args.to), target = index.find(entry => entry.path === destination); check(target, args.destinationHash);
      if (destination === path || destination.startsWith(path + '/')) throw Error('目标不能是源路径或其子目录');
      if (target && (!args.overwrite || target.kind !== 'file')) throw Error('移动目标已存在');
      const entries = index.filter(entry => entry.path === path || entry.path.startsWith(path + '/')); directories(destination);
      for (const entry of entries) { const next = destination + entry.path.slice(path.length); if (entry.kind === 'file') { await write(next, await read(entry.path)); await write(entry.path, null); } entry.path = next; }
      if (target) index.splice(index.indexOf(target), 1); await saveIndex(); return { path: destination, moved: entries.length };
    }
    throw Error('不支持的工作区操作');
  }
}
