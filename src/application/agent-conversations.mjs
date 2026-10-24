export const DEFAULT_AGENT_CONTEXT = Object.freeze({ mode: 'all', turns: 6 });

export function conversationMessages(conversation) {
  const context = conversation.context ?? DEFAULT_AGENT_CONTEXT;
  if (context.mode === 'none') return [];
  const available = conversation.turns.filter(turn => !['queued', 'steered', 'cancelled'].includes(turn.status));
  let turns = context.mode === 'last' ? available.slice(-Math.max(1, context.turns)) : available;
  const memory = context.mode === 'all' && conversation.memory;
  const boundary = memory ? turns.findIndex(turn => turn.id === memory.through) : -1;
  if (boundary >= 0) turns = turns.slice(boundary + 1);
  return [...(boundary >= 0 ? structuredClone(memory.messages ?? []) : []), ...turns.flatMap(turn => structuredClone(turn.messages ?? []))];
}

export class AgentConversations {
  constructor(snapshot) {
    this.records = new Map();
    for (const record of snapshot?.records ?? []) {
      if (typeof record?.id !== 'string' || !record.id || !Array.isArray(record.turns)) continue;
      const restored = structuredClone(record); restored.context ??= { ...DEFAULT_AGENT_CONTEXT }; restored.draft ??= '';
      for (const turn of restored.turns) if (['running', 'compacting'].includes(turn.status)) { turn.status = 'stopped'; turn.error ??= '上次任务未完成；已完成的操作保留，可继续对话。'; }
      for (const turn of restored.turns) if (turn.status === 'queued') turn.paused = true;
      this.records.set(restored.id, restored);
    }
    if (!this.records.size) this.create(); else this.selected = this.records.has(snapshot.selected) ? snapshot.selected : this.records.keys().next().value;
  }
  get current() { return this.records.get(this.selected); }
  create(title = '') {
    const record = { id: crypto.randomUUID(), title: title || '新对话', context: { ...DEFAULT_AGENT_CONTEXT }, turns: [], draft: '', createdAt: Date.now() };
    this.records.set(record.id, record); this.selected = record.id; return record;
  }
  select(id) { if (!this.records.has(id)) throw Error('对话不存在'); this.selected = id; return this.current; }
  rename(id, title) { const record = this.records.get(id); if (!record || !title.trim()) throw Error('对话名称不能为空'); record.title = title.trim().slice(0, 100); }
  remove(id) { this.records.delete(id); if (!this.records.size) return this.create(); if (this.selected === id) this.selected = this.records.keys().next().value; return this.current; }
  branch(id, turnIndex) {
    const source = this.records.get(id); if (!source || !source.turns[turnIndex]) throw Error('历史轮次不存在');
    const record = this.create(source.title + ' · 重发'); record.context = { ...source.context };
    record.turns = structuredClone(source.turns.slice(0, turnIndex)); return record;
  }
  snapshot({ turns = true, memory = true } = {}) {
    return { version: 1, selected: this.selected, records: [...this.records.values()].map(record => ({
      ...structuredClone(Object.fromEntries(Object.entries(record).filter(([key]) => !['turns', 'memory'].includes(key)))),
      ...(turns ? { turns: structuredClone(record.turns) } : { turnIds: record.turns.map(turn => turn.id) }),
      ...(record.memory ? { memory: memory ? structuredClone(record.memory) : { through: record.memory.through } } : {}),
    })) };
  }
  setContext(id, mode, turns = 6) {
    if (!['all', 'last', 'none'].includes(mode) || !Number.isSafeInteger(turns) || turns < 1 || turns > 10000) throw Error('上下文范围无效');
    this.records.get(id).context = { mode, turns };
  }
}
