import { agentSchema, agentText, agentIndex } from '../core/agent-commands.mjs';
import { agentWorkspacePath, agentExecutableFile, agentDownloadUrl } from '../core/agent-files.mjs';
import { AgentWorkspace } from '../platform/agent-workspace.mjs';

export function registerAgentFileTools(commands, editor, workspace = new AgentWorkspace(() => editor.agentWorkspaceId)) {
  const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
  commands.register({ name: 'workspace_files', description: '管理本谱面独立的文件工作区：info/list/read/write/mkdir/move/delete。桌面端为真实本地目录，网页端为浏览器持久存储。支持文本、base64、分页；文件不会自动进入谱面包。path/to 为工作区相对路径。新建普通文件为编辑；覆盖、删除和可执行脚本为危险操作。可配合 workspace_download / workspace_import_asset / chart_script 完成任意文件与谱面工作流。', access: 'read', parameters: agentSchema({ action: { enum: ['info', 'list', 'read', 'write', 'mkdir', 'move', 'delete'] }, path: agentText, to: agentText, text: { type: 'string', maxLength: 2000000 }, base64: { type: 'string', maxLength: 3000000 }, format: { enum: ['info', 'text', 'base64'] }, overwrite: { type: 'boolean' }, recursive: { type: 'boolean' }, offset: agentIndex, limit: integer(1, 1000000) }, ['action']), prepare: async (args, { signal }) => {
    const session = editor.session, id = editor.agentWorkspaceId;
    const path = agentWorkspacePath(args.path, { root: ['info', 'list'].includes(args.action) });
    if (['info', 'list', 'read'].includes(args.action)) return { apply: () => workspace.call(args.action, { ...args, path }, signal) };
    const previous = await workspace.call('stat', { path }, signal), target = args.action === 'move' ? await workspace.call('stat', { path: agentWorkspacePath(args.to) }, signal) : null;
    if (args.action === 'write' && previous && !args.overwrite) throw Error('文件已存在；覆盖需明确指定 overwrite');
    const access = args.action === 'delete' || args.action === 'write' && (previous || agentExecutableFile(path)) || args.action === 'move' && (target || previous?.kind === 'directory' || agentExecutableFile(args.to)) ? 'dangerous' : 'edit';
    return { access, summary: `${args.action} 工作区文件 ${path}`, details: { ...args, previous, target, undoable: false }, valid: () => editor.session === session && editor.agentWorkspaceId === id,
      apply: () => workspace.call(args.action, { ...args, path, expectedHash: previous?.hash ?? null, destinationHash: target?.hash ?? null }, signal) };
  } });
  commands.register({ name: 'workspace_download', description: '把公开 HTTP/HTTPS 文件下载到本谱面工作区，不使用模型搜索接口传输二进制文件，也不附带 API Key。桌面端支持重定向，网页端受跨域限制。下载、覆盖按危险操作审批，文件不自动执行或进入谱面。', access: 'dangerous', parameters: agentSchema({ url: agentText, path: agentText, overwrite: { type: 'boolean' }, maxBytes: integer(1, 128 * 1024 ** 2) }, ['url', 'path']), prepare: async (args, { signal }) => {
    const url = agentDownloadUrl(args.url), path = agentWorkspacePath(args.path), session = editor.session, id = editor.agentWorkspaceId, previous = await workspace.call('stat', { path }, signal);
    if (previous && !args.overwrite) throw Error('文件已存在，下载覆盖需指定 overwrite');
    return { summary: '下载文件至工作区 ' + path, details: { url, path, previous, maximumBytes: args.maxBytes ?? 128 * 1024 ** 2, undoable: false }, valid: () => editor.session === session && editor.agentWorkspaceId === id,
      apply: () => workspace.call('download', { ...args, url, path, expectedHash: previous?.hash ?? null }, signal) };
  } });
  commands.register({ name: 'workspace_import_asset', description: '把工作区中的文件加入或替换谱面素材；binding=song/background 可绑定音乐或背景。需保存，不可用普通撤销恢复，按危险操作批准。读取二进制在本机完成，不把文件内容发给模型。', access: 'dangerous', parameters: agentSchema({ path: agentText, assetPath: agentText, overwrite: { type: 'boolean' }, binding: { enum: ['song', 'background'] } }, ['path', 'assetPath']), prepare: async (args, { signal }) => {
    const path = agentWorkspacePath(args.path), assetPath = agentWorkspacePath(args.assetPath), session = editor.session, previous = editor.assets.get(assetPath), source = await workspace.call('stat', { path }, signal);
    if (source?.kind !== 'file') throw Error('工作区文件不存在'); if (previous && !args.overwrite) throw Error('谱面素材已存在，替换需指定 overwrite');
    return { summary: '导入谱面素材 ' + assetPath, details: { path, assetPath, bytes: source.bytes, binding: args.binding, undoable: false, needsSave: true }, valid: () => editor.session === session && editor.assets.get(assetPath) === previous,
      apply: async () => { const current = await workspace.call('stat', { path }, signal); if (current?.hash !== source.hash) throw Error('工作区文件已变化，请重新读取'); return editor.agent.writeAsset(assetPath, await workspace.call('bytes', { path }, signal), args.binding); } };
  } });
  return workspace;
}
