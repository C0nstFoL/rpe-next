import { agentSchema, agentText } from '../core/agent-commands.mjs';

const components = ['session', 'timeline', 'preview', 'realtimePreview', 'audio', 'audioSources', 'audioAnalysis', 'audioOnsets', 'noiseEditor', 'globalEvents', 'globalEventRegistry', 'linePanel', 'trajectoryPanel', 'textLinesPanel', 'noiseFitPanel', 'noiseTrackingPanel', 'multiEdit', 'batchControls', 'collaboration', 'noteSkins', 'editorSkins', 'versionControl'];
const privateName = name => /^(?:__.*|constructor|prototype|key|raw|agent)$/i.test(name) || /password|passwd|secret|token|authorization|credential|api.?key/i.test(name);
function properties(target) {
  const entries = new Map();
  for (let current = target; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) for (const name of Object.getOwnPropertyNames(current)) if (!privateName(name) && !entries.has(name)) entries.set(name, Object.getOwnPropertyDescriptor(current, name));
  return entries;
}
function snapshot(value, depth = 0, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 12000 ? value.slice(0, 12000) + '…' : value;
  if (typeof value !== 'object') return typeof value;
  if (seen.has(value)) return '[引用]'; seen.add(value);
  if (value instanceof Blob) return { type: value.type, bytes: value.size, name: value.name };
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return { type: value.constructor.name, bytes: value.byteLength };
  if (value instanceof Map || value instanceof Set) return { type: value.constructor.name, size: value.size };
  if (value.nodeType) return { element: value.tagName, id: value.id };
  if (depth >= 3) return { type: value.constructor?.name ?? 'object', keys: Object.keys(value).filter(name => !privateName(name)).slice(0, 30) };
  if (Array.isArray(value)) return { length: value.length, items: value.slice(0, 30).map(entry => snapshot(entry, depth + 1, seen)) };
  return Object.fromEntries(Object.keys(value).filter(name => !privateName(name)).slice(0, 40).map(name => { const descriptor = Object.getOwnPropertyDescriptor(value, name); return [name, descriptor.get ? '[访问器]' : snapshot(descriptor.value, depth + 1, seen)]; }));
}

export function registerAgentComponentTools(commands, editor, workspace) {
  commands.register({ name: 'editor_api', description: '编辑器组件的通用底层入口，用于专用命令未覆盖的功能。describe 列出可用 target 与现有方法/属性，get 读取数据属性；call 调用现有方法，set 修改现有可写属性。修改/调用统一按危险操作审批，行为与相应原生方法一致，不保证可撤销；应先 editor_source 核查参数与语义，优先使用结构化命令。arguments/value 中 {$workspaceFile:"相对路径",name:"文件名"} 由宿主解析为本地 File，支持原生导入方法，不把二进制发给模型。不可访问凭据、Agent 自身、原型构造器或任意全局对象。', access: 'read', parameters: agentSchema({ action: { enum: ['describe', 'get', 'set', 'call'] }, target: agentText, member: agentText, arguments: { type: 'array', maxItems: 40 }, value: {} }, ['action']), prepare: async (args, { signal }) => {
    if (!args.target && args.action === 'describe') return { apply: () => ({ targets: components.filter(name => editor[name]) }) };
    if (!components.includes(args.target) || !editor[args.target]) throw Error('组件不存在；先 describe 查询 target');
    const target = editor[args.target], entries = properties(target);
    if (args.action === 'describe') return { apply: () => ({ target: args.target, members: [...entries].map(([name, descriptor]) => ({ name, kind: descriptor.get ? 'accessor' : typeof descriptor.value === 'function' ? 'method' : 'property', writable: Boolean(descriptor.writable || descriptor.set) })) }) };
    const descriptor = entries.get(args.member); if (!descriptor || privateName(args.member)) throw Error('组件成员不可用');
    if (args.action === 'get') { if (descriptor.get || typeof descriptor.value === 'function') throw Error('get 只读取数据属性；访问器需查阅源码或使用专用命令'); return { apply: () => snapshot(descriptor.value) }; }
    if (args.action === 'call' && typeof descriptor.value !== 'function') throw Error('成员不是方法');
    if (args.action === 'set' && (descriptor.get && !descriptor.set || !descriptor.get && !descriptor.writable || typeof descriptor.value === 'function')) throw Error('属性不可写');
    const sources = [];
    const resolve = async (value, depth = 0) => {
      if (depth > 30) throw Error('参数嵌套过深');
      if (!value || typeof value !== 'object') return value;
      if (typeof value.$workspaceFile === 'string') {
        if (!workspace) throw Error('文件工作区不可用'); const info = await workspace.call('stat', { path: value.$workspaceFile }, signal); if (info?.kind !== 'file') throw Error('工作区文件不存在');
        sources.push(info); return new File([await workspace.call('bytes', { path: info.path }, signal)], value.name ?? info.path.split('/').at(-1), { type: value.type ?? '' });
      }
      if (Array.isArray(value)) return Promise.all(value.map(entry => resolve(entry, depth + 1)));
      return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([name, entry]) => [name, await resolve(entry, depth + 1)])));
    };
    const values = await resolve(args.action === 'call' ? args.arguments ?? [] : args.value), session = editor.session;
    return { access: 'dangerous', summary: `${args.action === 'call' ? '调用' : '修改'} ${args.target}.${args.member}`, details: { ...args, files: sources, undoable: '由原生方法决定' }, valid: () => editor.session === session && editor[args.target] === target && (descriptor.get || target[args.member] === descriptor.value),
      apply: async () => {
        for (const file of sources) if ((await workspace.call('stat', { path: file.path }, signal))?.hash !== file.hash) throw Error('工作区文件已变化，请重新读取');
        const result = args.action === 'call' ? await descriptor.value.apply(target, values) : (Reflect.set(target, args.member, values), target[args.member]);
        editor.render?.(); editor.invalidate?.(); return { target: args.target, member: args.member, result: snapshot(result) };
      } };
  } });
}
