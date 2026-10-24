export const AGENT_API_VERSION = 1;
export const AGENT_PERMISSIONS = ['ask', 'dangerous', 'full'];
export const agentAbort = () => new DOMException('任务已停止', 'AbortError');
export function checkAgentSignal(signal) { if (signal?.aborted) throw agentAbort(); }

export function validateAgentValue(value, schema = {}, path = 'arguments', depth = 0) {
  if (depth > 40) throw Error('参数嵌套过深');
  if (schema.anyOf) {
    let matched = false;
    for (const option of schema.anyOf) { try { validateAgentValue(value, option, path, depth + 1); matched = true; break; } catch {} }
    if (!matched) throw Error(path + ' 不符合允许的参数类型');
  }
  if (schema.enum && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) throw Error(path + ' 不在允许值中');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(path + ' 必须为对象');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw Error(path + '.' + key + ' 为必填项');
    for (const [key, entry] of Object.entries(value)) {
      const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : null;
      if (!property && schema.additionalProperties === false) throw Error(path + '.' + key + ' 是未知参数');
      validateAgentValue(entry, property ?? {}, path + '.' + key, depth + 1);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 10000) || value.length < (schema.minItems ?? 0)) throw Error(path + ' 数组长度无效');
    value.forEach((entry, index) => validateAgentValue(entry, schema.items, path + '[' + index + ']', depth + 1));
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (!Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw Error(path + ' 数值无效');
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? 100000)) throw Error(path + ' 文本无效');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw Error(path + ' 必须为布尔值');
}

export class AgentCommands extends EventTarget {
  constructor() { super(); this.entries = new Map(); this.running = false; }
  register(definition, owner = 'rpen') {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(definition.name) || this.entries.has(definition.name)) throw Error('命令名无效或重复');
    if (!['read', 'edit', 'dangerous'].includes(definition.access) || typeof definition.prepare !== 'function') throw Error('命令需要权限级别和 prepare');
    const entry = Object.freeze({ ...definition, owner }); this.entries.set(entry.name, entry); this.dispatchEvent(new Event('change'));
    return () => { if (this.entries.get(entry.name) === entry) { this.entries.delete(entry.name); this.dispatchEvent(new Event('change')); } };
  }
  tools() { return [...this.entries.values()].map(entry => ({ type: 'function', function: { name: entry.name, description: entry.description, parameters: entry.parameters } })); }
  async execute(name, args, { permission = 'ask', approve, signal, guard = () => true } = {}) {
    if (this.running) throw Error('已有命令执行中');
    if (!AGENT_PERMISSIONS.includes(permission)) throw Error('权限模式无效');
    const entry = this.entries.get(name); if (!entry) throw Error('命令不存在：' + name);
    validateAgentValue(args, entry.parameters); checkAgentSignal(signal); this.running = true;
    try {
      const prepared = await entry.prepare(structuredClone(args), { signal }); checkAgentSignal(signal);
      const access = entry.access === 'dangerous' || prepared.access === 'dangerous' ? 'dangerous' : entry.access === 'read' && prepared.access === 'edit' ? 'edit' : prepared.access === 'read' ? 'read' : entry.access;
      const plan = { command: name, owner: entry.owner, access, summary: prepared.summary ?? entry.description, details: prepared.details ?? args };
      if (access !== 'read' && (permission === 'ask' || permission === 'dangerous' && access === 'dangerous')) {
        if (!approve || !await approve(plan, signal)) return { ok: false, denied: true, message: '用户拒绝了此操作；不得换命令绕过拒绝。' };
      }
      checkAgentSignal(signal);
      if (!guard() || prepared.valid && !prepared.valid() || this.entries.get(name) !== entry) throw Error('编辑器状态已变化或命令已卸载，请重新读取后生成方案');
      const result = await prepared.apply({ signal, permission }); checkAgentSignal(signal);
      return { ok: true, result: result ?? null };
    } finally { this.running = false; }
  }
}

export const agentSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const agentNumber = { type: 'number' };
export const agentText = { type: 'string' };
export const agentIndex = { type: 'integer', minimum: 0 };
