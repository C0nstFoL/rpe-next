import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorkspaceService, installAgentWorkspace } from '../desktop/agent-workspace.mjs';
import { AgentWorkspace } from '../src/platform/agent-workspace.mjs';
import { AgentCommands } from '../src/core/agent-commands.mjs';
import { registerAgentFileTools } from '../src/application/agent-file-tools.mjs';
import { agentWorkspacePath, agentDownloadUrl } from '../src/core/agent-files.mjs';

test('工作区路径禁止越界、绝对路径和危险文件名，公开下载地址不附带本机地址或凭据', () => {
  for (const path of ['../secret', '/absolute', 'C:/secret', 'a\\b', 'a/../b', 'a//b', 'CON.txt', 'a/aux', 'a.']) assert.throws(() => agentWorkspacePath(path));
  assert.equal(agentWorkspacePath('素材/文本.json'), '素材/文本.json'); assert.equal(agentWorkspacePath('', { root: true }), '');
  for (const url of ['file:///secret', 'https://name:password@example.com/', 'http://127.0.0.1/', 'http://2130706433/', 'http://192.168.1.1/', 'http://[::1]/']) assert.throws(() => agentDownloadUrl(url));
});

function browserWorkspace() {
  const values = new Map(); let id = 'first';
  const workspace = new AgentWorkspace(() => id, { bridge: null, read: async key => structuredClone(values.get(key)), write: async (key, value) => values.set(key, structuredClone(value)), request: async () => new Response(new Uint8Array([1, 2, 3])) });
  return { workspace, switch: value => { id = value; }, values };
}

test('网页工作区支持文本和二进制、目录移动与删除，不同谱面隔离且不依赖 localStorage', async () => {
  const fixture = browserWorkspace(), workspace = fixture.workspace;
  const file = await workspace.call('write', { path: 'one/你好.txt', text: '你好🙂' }); assert.ok(file.hash);
  assert.equal((await workspace.call('read', { path: file.path })).text, '你好🙂');
  await assert.rejects(workspace.call('write', { path: file.path, text: 'replace' }), /覆盖/);
  await assert.rejects(workspace.call('write', { path: file.path, text: 'replace', overwrite: true, expectedHash: 'wrong' }), /变化/);
  await workspace.call('move', { path: 'one', to: 'two' }); assert.equal((await workspace.call('read', { path: 'two/你好.txt' })).text, '你好🙂');
  await assert.rejects(workspace.call('delete', { path: 'two' }), /非空/);
  await workspace.call('download', { path: 'asset.bin', url: 'https://example.com/file' }); assert.deepEqual([...await workspace.call('bytes', { path: 'asset.bin' })], [1, 2, 3]);
  fixture.switch('second'); assert.equal((await workspace.call('list')).total, 0); fixture.switch('first');
  await workspace.call('delete', { path: 'two', recursive: true }); assert.equal(await workspace.call('stat', { path: 'two/你好.txt' }), null);
});

test('桌面工作区真实读写、重定向下载和取消均限定在独立目录，失败不破坏旧文件', async context => {
  const root = await mkdtemp(join(tmpdir(), 'rpen-agent-files-')); context.after(() => rm(root, { recursive: true, force: true })); let fetches = 0;
  const service = new AgentWorkspaceService(join(root, 'workspaces'), { resolver: async () => [{ address: '93.184.216.34' }], fetcher: async (url, options) => {
    fetches++; assert.equal(options.headers, undefined);
    return url.endsWith('/redirect') ? new Response(null, { status: 302, headers: { location: 'https://example.com/file' } }) : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } });
  } });
  const first = await service.write('chart-a', { path: 'folder/test.txt', text: 'old' }); assert.equal((await service.read('chart-a', { path: first.path })).text, 'old');
  await assert.rejects(service.write('chart-a', { path: first.path, text: 'new', overwrite: true, expectedHash: 'outdated' }), /变化/);
  assert.equal((await service.read('chart-a', { path: first.path })).text, 'old');
  const result = await service.download('chart-a', { url: 'https://example.com/redirect', path: 'download.bin' }); assert.equal(result.bytes, 3); assert.equal(fetches, 2);
  assert.deepEqual([...await service.bytes('chart-a', { path: 'download.bin' })], [1, 2, 3]);
  await assert.rejects(service.download('chart-a', { url: 'https://example.com/file', path: 'large.bin', maxBytes: 2 }), /大小/); assert.equal(await service.stat('chart-a', { path: 'large.bin' }), null);
  const controller = new AbortController(); controller.abort(); await assert.rejects(service.download('chart-a', { url: 'https://example.com/file', path: 'cancel.bin' }, controller.signal), /取消/);
  assert.equal((await service.list('chart-b')).total, 0);
  await service.move('chart-a', { path: 'folder', to: 'renamed' }); assert.equal((await service.read('chart-a', { path: 'renamed/test.txt' })).text, 'old');
  await assert.rejects(service.delete('chart-a', { path: '' }), /路径/);
  const outside = join(root, 'outside'); await mkdir(outside);
  try { await symlink(outside, join(await service.directory('chart-a'), 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; return; }
  await assert.rejects(service.write('chart-a', { path: 'link/outside.txt', text: 'bad' }), /链接/);
});

test('文件工具遵守三种权限，覆盖/删除/可执行文件为危险操作，素材导入不发送二进制到模型', async () => {
  const { workspace } = browserWorkspace(), commands = new AgentCommands(), session = {}, assets = new Map();
  const editor = { session, agentWorkspaceId: 'first', assets, agent: { writeAsset: (path, bytes) => { assets.set(path, bytes); return { needsSave: true }; } } };
  registerAgentFileTools(commands, editor, workspace);
  let approvals = 0;
  const execute = (args, permission = 'dangerous', approved = true) => commands.execute('workspace_files', args, { permission, approve: async () => { approvals++; return approved; } });
  await execute({ action: 'write', path: 'new.txt', text: 'hello' }); assert.equal(approvals, 0);
  const denied = await execute({ action: 'write', path: 'script.js', text: 'code' }, 'dangerous', false); assert.equal(denied.denied, true); assert.equal(await workspace.call('stat', { path: 'script.js' }), null);
  await execute({ action: 'write', path: 'new.txt', text: 'replace', overwrite: true }); assert.equal(approvals, 2);
  await execute({ action: 'write', path: 'ask.txt', text: 'no' }, 'ask', false); assert.equal(await workspace.call('stat', { path: 'ask.txt' }), null);
  const imported = await commands.execute('workspace_import_asset', { path: 'new.txt', assetPath: 'notes/data.txt' }, { permission: 'full' }); assert.equal(imported.result.needsSave, true); assert.equal(new TextDecoder().decode(assets.get('notes/data.txt')), 'replace');
  const removed = await execute({ action: 'delete', path: 'new.txt' }, 'dangerous', false); assert.equal(removed.denied, true); assert.ok(await workspace.call('stat', { path: 'new.txt' }));
});

test('桌面文件 IPC 只接受当前主窗口及已知操作', async () => {
  let handler, calls = 0; const sender = { mainFrame: { url: 'rpe://app/' } };
  installAgentWorkspace({ ipcMain: { on() {}, handle(name, callback) { handler = callback; } }, service: { info: async () => { calls++; return {}; } }, origin: 'rpe://app', window: () => ({ webContents: sender }) });
  const valid = { sender, senderFrame: sender.mainFrame };
  assert.equal((await handler(valid, { id: 'a', workspace: 'first', action: 'info' })).ok, true);
  assert.equal((await handler({ sender: {}, senderFrame: {} }, { id: 'b', workspace: 'first', action: 'info' })).ok, false);
  assert.equal((await handler(valid, { id: 'c', workspace: 'first', action: 'execute_shell' })).ok, false); assert.equal(calls, 1);
});

test('原生文件请求可立即取消，不会等未结束的桥接调用', async () => {
  let cancelled = false;
  const workspace = new AgentWorkspace(() => 'test', { bridge: { call: () => new Promise(() => {}), cancel() { cancelled = true; } } });
  const controller = new AbortController(), task = workspace.call('download', { path: 'x', url: 'https://example.com/' }, controller.signal); controller.abort();
  await assert.rejects(task, /停止/); assert.equal(cancelled, true);
});
