import { AgentConversations, conversationMessages } from '../application/agent-conversations.mjs';
import { renderAgentMarkdown } from './agent-markdown.mjs';
import { AgentConversationRepository } from '../platform/agent-store.mjs';
import { showAgentExchange } from './agent-inspector.mjs';
import { AGENT_CORE_TOOLS, agentContextPolicy, agentContextUsage, agentContextSignature, estimateAgentTokens, prepareAgentHistory } from '../core/agent-context.mjs';

const text = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; };
const button = (label, action) => { const node = text('button', label); node.type = 'button'; node.onclick = action; return node; };
const detail = label => { const node = document.createElement('details'); node.append(text('summary', label)); return node; };
const pretty = value => JSON.stringify(value, null, 2);
const time = milliseconds => (milliseconds / 1000).toFixed(2) + ' s';
export function agentUsageText(stats) {
  if (!stats) return '';
  return [stats.model, stats.startedAt ? new Date(stats.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '', time(stats.durationMs ?? 0), stats.usageKnown ? `输入 ${stats.promptTokens} · 输出 ${stats.completionTokens} · 共 ${stats.totalTokens} tokens` : '用量未返回', stats.reasoningTokens ? `思考 ${stats.reasoningTokens}` : '', stats.cachedTokens ? `缓存 ${stats.cachedTokens}` : '', stats.requests ? `${stats.requests} 次请求` : '', stats.tools ? `${stats.tools} 次工具调用` : ''].filter(Boolean).join(' · ');
}

export class AgentDialogues {
  constructor(panel) {
    this.panel = panel; this.store = new AgentConversations(); this.views = new Map(); this.scrollStates = new Map(); this.running = null; this.round = null;
    this.dirtyTurns = new Set(); this.dirtyMemories = new Set(); this.traceOwners = new Map(); this.activeExchanges = new Map(); this.runs = new Map(); this.turnViews = new WeakMap(); this.ready = Promise.resolve(); this.generation = 0; this.autoQueue = false;
    this.render(); this.show(this.store.current.id);
  }
  async attach(workspace) {
    if (workspace === this.workspace) return this.ready;
    this.detach(); this.workspace = workspace; this.loading = true; this.updateBusy(); const generation = ++this.generation, repository = this.repository = new AgentConversationRepository(workspace);
    this.ready = repository.load().then(store => {
      if (generation !== this.generation) return;
      this.store = store; this.views.clear(); this.scrollStates.clear(); this.visibleId = null; this.show(store.selected);
    }).catch(error => { if (generation === this.generation) this.repository = null; this.panel.notify('读取 AI 对话失败：' + error.message, 'error'); }).finally(() => { if (generation === this.generation) { this.loading = false; this.updateBusy(); this.updateStatus(); } });
    return this.ready;
  }
  save(turn, memory) {
    if (!this.repository) return;
    if (turn) this.dirtyTurns.add(turn); if (memory) this.dirtyMemories.add(memory);
    clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.flush().catch(error => this.panel.notify('保存 AI 对话失败：' + error.message, 'error')), 300);
  }
  async flush() {
    clearTimeout(this.saveTimer); this.saveTimer = null;
    const repository = this.repository; if (!repository) return;
    const turns = [...this.dirtyTurns], memories = [...this.dirtyMemories]; this.dirtyTurns.clear(); this.dirtyMemories.clear();
    try { await repository.save(this.store, { turns, memories }); await repository.flush(); }
    catch (error) { if (this.repository === repository) { for (const turn of turns) this.dirtyTurns.add(turn); for (const memory of memories) this.dirtyMemories.add(memory); } throw error; }
  }
  detach() {
    this.autoQueue = false;
    if (this.running) { this.running.turn.status = 'stopped'; this.running.turn.error ??= '切换谱面时已停止任务，已完成的操作保留。'; this.running.turn.messages = structuredClone(this.panel.agent?.turnMessages ?? this.running.turn.messages); this.dirtyTurns.add(this.running.turn); }
    this.flush().catch(error => this.panel.notify('保存 AI 对话失败：' + error.message, 'error'));
    this.generation++; this.workspace = null; this.repository = null;
  }
  render() {
    const panel = this.panel, heading = text('div', '', 'agent-heading');
    panel.configure = button('配置', () => panel.configuration()); heading.append(panel.configure);
    if (globalThis.rpenAgentWorkspace) heading.append(button('工作区', () => panel.workspace.call('open').catch(error => panel.notify(error.message, 'error'))));
    const row = text('div', '', 'agent-conversations'); this.select = document.createElement('select'); this.select.setAttribute('aria-label', 'AI 对话'); this.select.onchange = () => this.show(this.select.value);
    panel.clear = button('＋ 新对话', () => this.show(this.store.create().id));
    const manage = button('管理', () => this.manage()); manage.title = '管理对话与显示'; row.append(this.select, panel.clear, manage);
    const topbar = text('div', '', 'agent-topbar'); topbar.append(row, heading);
    const context = text('div', '', 'agent-context'); const label = text('label', '');
    this.contextMode = document.createElement('select'); this.contextMode.setAttribute('aria-label', '本对话上下文');
    for (const [value, name] of [['all', '全部上下文'], ['last', '最近轮次'], ['none', '仅本次消息']]) { const option = text('option', name); option.value = value; this.contextMode.append(option); }
    this.contextCount = document.createElement('input'); this.contextCount.type = 'number'; this.contextCount.min = '1'; this.contextCount.max = '10000'; this.contextCount.step = '1'; this.contextCount.setAttribute('aria-label', '携带最近几轮对话');
    const changeContext = () => { const count = Number(this.contextCount.value); if (!Number.isSafeInteger(count) || count < 1 || count > 10000) return; this.store.setContext(this.store.selected, this.contextMode.value, count); this.contextCount.hidden = this.contextMode.value !== 'last'; this.updateStatus(); this.updateContextUsage(); };
    this.contextMode.onchange = this.contextCount.onchange = () => { changeContext(); this.save(); }; label.append(this.contextMode); context.append(label, this.contextCount);
    this.compactButton = button('压缩', () => this.compact()); this.compactButton.title = '压缩模型上下文；完整对话与请求记录仍保留'; context.append(this.compactButton);
    this.usage = text('div', '', 'agent-context-usage'); this.usage.setAttribute('role', 'meter'); this.usage.setAttribute('aria-label', '上下文用量'); this.usage.setAttribute('aria-valuemin', '0');
    this.usageRing = text('span', '', 'agent-context-ring'); this.usageRing.setAttribute('aria-hidden', 'true'); this.usageNumber = text('span', '', 'agent-context-number'); this.usage.append(this.usageRing, this.usageNumber); context.append(this.usage);
    const permissions = text('label', '', 'agent-permission'); panel.permission = document.createElement('select'); panel.permission.setAttribute('aria-label', 'AI 访问权限');
    for (const [value, name] of [['ask', '请求批准'], ['dangerous', '危险操作批准'], ['full', '完全访问权限']]) { const option = text('option', name); option.value = value; panel.permission.append(option); }
    panel.permission.value = panel.settings.permission; panel.permission.onchange = () => { panel.settings.permission = panel.permission.value; panel.persist(); }; permissions.append(panel.permission);
    const controls = text('div', '', 'agent-controls'); controls.append(context, permissions);
    panel.status = text('p', '', 'agent-status'); panel.status.setAttribute('role', 'status');
    this.background = button('', () => { if (this.running) this.show(this.running.record.id); }); this.background.className = 'agent-background-task'; this.background.hidden = true;
    this.viewport = text('div', '', 'agent-messages'); this.viewport.setAttribute('role', 'log'); this.viewport.setAttribute('aria-label', 'AI 对话与执行记录');
    this.viewport.addEventListener('scroll', () => this.trackScroll(), { passive: true });
    this.viewport.addEventListener('wheel', event => {
      if (!event.deltaY || event.ctrlKey || event.target.closest('textarea,input,select,[contenteditable=true]')) return;
      const state = this.scrollState(); state.direction = Math.sign(event.deltaY);
      if (event.deltaY < 0 && this.viewport.scrollHeight > this.viewport.clientHeight + 2) { state.follow = false; state.top = this.viewport.scrollTop; state.bottom = this.viewport.scrollHeight - this.viewport.clientHeight; }
      else if (event.deltaY > 0 && this.viewport.scrollHeight - this.viewport.clientHeight - this.viewport.scrollTop <= 96) state.follow = true;
    }, { passive: true });
    this.viewport.addEventListener('pointerdown', () => { this.scrollState().direction = 0; }, { passive: true });
    this.viewport.addEventListener('keydown', event => {
      if (event.target.closest('textarea,input,select,[contenteditable=true]')) return;
      const state = this.scrollState();
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) { state.direction = -1; state.follow = false; }
      else if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) { state.direction = 1; if (event.key === 'End') state.follow = true; }
    });
    this.composer = document.createElement('form'); this.composer.className = 'agent-composer'; panel.input = document.createElement('textarea'); panel.input.rows = 2; panel.input.placeholder = '描述目标，Shift+Enter 换行…'; panel.input.setAttribute('aria-label', '给 AI 的任务');
    panel.input.oninput = () => { this.store.current.draft = panel.input.value; this.save(); this.updateBusy(); };
    panel.input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.composer.requestSubmit(); } };
    const actions = text('div', '', 'agent-composer-actions'); panel.send = button('发送', () => {}); panel.send.type = 'submit'; panel.stop = button('停止', () => { this.pauseQueue(); panel.agent.stop(); }); panel.stop.hidden = true;
    this.interruptButton = button('插话', () => this.interrupt(panel.input.value)); this.interruptButton.hidden = true; actions.append(panel.status, panel.send, this.interruptButton, panel.stop);
    this.resumeQueue = button('继续队列', () => { for (const { turn } of this.queued()) { turn.paused = false; this.save(turn); } this.autoQueue = true; this.drain(); }); this.resumeQueue.className = 'agent-queue-resume'; this.resumeQueue.hidden = true;
    this.composer.append(panel.input, actions); this.composer.onsubmit = event => { event.preventDefault(); this.send(panel.input.value); };
    panel.host.append(topbar, controls, this.background, this.viewport, this.resumeQueue, this.composer);
  }
  bind(agent) {
    agent.addEventListener('user', event => { if (this.running) { this.running.runId = event.detail.runId; this.running.turn.startedAt = event.detail.startedAt; this.runs.set(event.detail.runId, this.running); } });
    agent.addEventListener('context-usage', event => {
      if (!this.running) return;
      this.running.record.contextUsage = { ...event.detail, signature: agentContextSignature(this.panel.settings, this.running.record.context) };
      this.updateContextUsage(); this.save();
    });
    agent.addEventListener('exchange-start', event => {
      const current = this.running; if (!current) return;
      const trace = event.detail; current.turn.exchanges ??= []; current.turn.exchanges.push({ id: trace.id, model: trace.model, purpose: trace.purpose, status: trace.status, startedAt: trace.startedAt });
      this.activeExchanges.set(trace.id, trace); this.traceOwners.set(trace.id, current); current.view.inspect.disabled = false; this.save(current.turn);
    });
    agent.addEventListener('exchange-end', event => {
      const trace = event.detail, current = this.traceOwners.get(trace.id); if (!current) return;
      const metadata = current.turn.exchanges.find(entry => entry.id === trace.id); Object.assign(metadata, { status: trace.status, durationMs: trace.durationMs });
      this.activeExchanges.set(trace.id, trace);
      current.repository?.saveTrace(trace).then(() => this.activeExchanges.delete(trace.id)).catch(error => this.panel.notify('保存请求记录失败：' + error.message, 'error'));
      this.traceOwners.delete(trace.id);
      if (this.running === current) this.save(current.turn);
    });
    agent.addEventListener('assistant-start', event => {
      const turn = this.running?.view; if (!turn) return;
      this.round = this.modelRound(turn.workContent); this.round.model = event.detail.model; this.updateStatus('正在思考…');
    });
    agent.addEventListener('text', event => { if (this.round) { this.round.source += event.detail.delta; this.scheduleRound(); } });
    agent.addEventListener('reasoning', event => { if (this.round) { this.round.thinking += event.detail.delta; this.round.reasoning.hidden = false; this.scheduleRound(); } });
    agent.addEventListener('assistant-cancelled', event => {
      if (!this.running || !this.round) return;
      this.renderRound(this.round, true); this.round.element.append(text('small', event.detail.reason === 'interrupted' ? '已被插话中断' : '请求未完成', 'agent-round-meta'));
      this.running.turn.process.push({ kind: 'model', text: this.round.source, reasoning: this.round.thinking, interrupted: true }); this.round = null;
    });
    agent.addEventListener('compaction-start', () => { this.updateStatus('正在压缩上下文…'); });
    agent.addEventListener('compaction-end', event => {
      if (!this.running) return;
      this.running.turn.process.push({ kind: 'compaction', ...event.detail }); this.running.view.workContent.append(this.jsonDetail('上下文已压缩', event.detail)); this.updateStatus('继续处理…'); this.save(this.running.turn);
    });
    agent.addEventListener('compaction-only', event => { if (this.running) { this.running.view.answer.hidden = false; renderAgentMarkdown(this.running.view.answerContent, event.detail.text); } });
    agent.addEventListener('steering', event => {
      if (!this.running) return;
      const pending = this.running.turn.process.find(entry => entry.kind === 'steering' && entry.pending && entry.text === event.detail.text);
      if (pending) { pending.pending = false; this.running.view.workContent.querySelector(`[data-steering-id="${CSS.escape(pending.id)}"]`)?.querySelector('.agent-message-role').replaceChildren(document.createTextNode('补充说明')); }
      else { this.running.turn.process.push({ kind: 'steering', text: event.detail.text }); this.running.view.workContent.append(this.message('补充说明', event.detail.text, 'agent-user-message')); }
      this.save(this.running.turn); this.scroll();
    });
    agent.addEventListener('assistant-end', event => {
      const view = this.running?.view, round = this.round; if (!view || !round) return;
      round.source = event.detail.text; round.thinking = event.detail.reasoning || round.thinking; this.renderRound(round, true);
      const usage = event.detail.usage, stats = { model: event.detail.model, durationMs: event.detail.durationMs, usageKnown: Boolean(usage), promptTokens: usage?.prompt_tokens ?? 0, completionTokens: usage?.completion_tokens ?? 0, totalTokens: usage?.total_tokens ?? 0, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0 };
      this.roundMetrics(round, stats);
      if (event.detail.final) { view.answer.hidden = false; renderAgentMarkdown(view.answerContent, event.detail.text); if (event.detail.text) round.content.remove(); }
      if (!round.thinking && (event.detail.final || !round.source)) round.element.remove();
      this.running.turn.process.push({ kind: 'model', text: event.detail.final ? '' : event.detail.text, reasoning: round.thinking, statistics: stats }); this.round = null;
      this.save(this.running.turn);
      this.scroll();
    });
    agent.addEventListener('tool-start', event => {
      const view = this.running?.view; if (!view) return;
      const entry = this.jsonDetail('执行 · ' + event.detail.name, event.detail.arguments); entry.dataset.callId = event.detail.id; view.workContent.append(entry); this.updateStatus('执行 ' + event.detail.name); this.scroll();
      this.running.turn.process.push({ kind: 'tool', id: event.detail.id, name: event.detail.name, arguments: structuredClone(event.detail.arguments) });
    });
    agent.addEventListener('tool-end', event => {
      const entry = this.running?.view.workContent.querySelector(`[data-call-id="${CSS.escape(event.detail.id)}"]`);
      if (entry) { entry.classList.toggle('agent-tool-error', !event.detail.result.ok); entry.querySelector('summary').textContent = `${event.detail.result.denied ? '已拒绝' : event.detail.result.ok ? '完成' : '失败'} · ${event.detail.name}`; entry.append(text('pre', pretty(event.detail.result))); }
      const process = this.running?.turn.process.find(entry => entry.id === event.detail.id); if (process) process.result = structuredClone(event.detail.result); this.scroll();
      if (this.running) this.save(this.running.turn);
    });
    agent.addEventListener('error', event => {
      const view = this.running?.view; if (!view) return;
      view.answer.hidden = false; view.answerContent.append(text('p', event.detail.message, 'agent-error')); this.running.turn.error = event.detail.message;
      this.scroll();
    });
    agent.addEventListener('turn-end', event => {
      const current = this.runs.get(event.detail.runId); if (!current) return;
      this.runs.delete(event.detail.runId);
      const { contextMessages, compacted, runId, ...result } = event.detail;
      Object.assign(current.turn, result); current.turn.answer = current.view.answerContent.dataset.markdownSource ?? '';
      if (compacted && current.contextMode === 'all') current.record.memory = { through: current.turn.id, messages: contextMessages };
      current.view.work.open = false; current.view.meta.textContent = agentUsageText(event.detail.statistics); current.view.actions.hidden = false;
      current.view.meta.title = `总用时包含等待批准/回答；模型请求用时 ${time(event.detail.statistics.requestMs)}`;
      current.view.work.querySelector('summary').textContent = `工作过程 · ${event.detail.statistics.requests} 次请求 / ${event.detail.statistics.tools} 次调用`;
      if (this.running !== current) { current.repository?.saveTurns([current.turn]).catch(error => this.panel.notify(error.message, 'error')); return; }
      this.save(current.turn, compacted && current.contextMode === 'all' ? current.record : undefined);
      if (event.detail.status === 'completed') this.panel.notify('AI 已完成：' + current.record.title, 'info');
      else if (event.detail.status === 'failed') { this.pauseQueue(); this.panel.notify('AI 任务未完成：' + (current.turn.error ?? current.record.title), 'error'); }
      this.scroll(); this.running = null; this.round = null; this.updateChoices(); this.updateStatus(); this.updateContextUsage();
      clearInterval(this.elapsedTimer); this.elapsedTimer = null;
    });
    agent.addEventListener('state', () => { this.updateBusy(); this.updateStatus(); if (!agent.busy) queueMicrotask(() => this.drain()); });
  }
  scheduleRound() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => { this.renderTimer = null; if (this.round) this.renderRound(this.round); }, 80);
  }
  modelRound(parent) {
    const element = text('div', '', 'agent-model-round'), reasoning = detail(''); reasoning.className = 'agent-reasoning'; reasoning.hidden = true;
    const summary = reasoning.querySelector('summary'); summary.append(text('span', '思考', 'agent-reasoning-label')); const preview = text('span', '', 'agent-reasoning-preview'); summary.append(preview); summary.title = '展开或收起模型思考';
    const reasoningText = text('div', '', 'agent-content'), content = text('div', '', 'agent-content'); reasoning.append(reasoningText); element.append(reasoning, content); parent.append(element);
    const round = { element, content, reasoning, reasoningText, preview, source: '', thinking: '' };
    reasoning.addEventListener('toggle', () => { if (reasoning.open) renderAgentMarkdown(reasoningText, round.thinking); }); return round;
  }
  roundMetrics(round, statistics) {
    const value = agentUsageText(statistics); round.element.title = value;
    if (round.thinking) round.reasoning.append(text('small', value, 'agent-round-meta'));
  }
  renderRound(round, complete = false) {
    if (!complete && round.source.length > 40000) round.content.textContent = round.source; else renderAgentMarkdown(round.content, round.source);
    if (round.thinking) {
      round.reasoning.hidden = false; round.preview.textContent = round.thinking.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();
      if (round.reasoning.open) { if (!complete && round.thinking.length > 40000) round.reasoningText.textContent = round.thinking; else renderAgentMarkdown(round.reasoningText, round.thinking); }
    } this.scroll();
  }
  jsonDetail(label, value) { const node = detail(label); node.className = 'agent-tool'; node.append(text('pre', pretty(value))); return node; }
  recordView(record) {
    if (this.views.has(record.id)) return this.views.get(record.id);
    const node = text('div', '', 'agent-conversation-view'); this.views.set(record.id, node);
    if (!record.turns.length) node.append(text('p', '告诉我你想怎样编辑这张谱面。对话可独立设置上下文范围；只有执行成功的命令才会修改谱面。', 'agent-intro'));
    for (const turn of record.turns) this.turnView(record, turn, node);
    return node;
  }
  turnView(record, turn, parent = this.recordView(record)) {
    const root = text('article', '', 'agent-turn'); root.dataset.turnId = turn.id;
    root.hidden = turn.status === 'steered' && Boolean(turn.linkedTurn);
    const inspect = button('↗', () => {
      const target = turn.linkedTurn ? record.turns.find(entry => entry.id === turn.linkedTurn) ?? turn : turn;
      showAgentExchange(target, id => this.activeExchanges.get(id) ?? this.repository?.trace(id));
    }); inspect.className = 'agent-turn-inspect'; inspect.title = '查看本轮完整请求与返回'; inspect.setAttribute('aria-label', inspect.title); inspect.disabled = !turn.exchanges?.length && !turn.linkedTurn; root.append(inspect);
    const user = this.message('你', turn.text, 'agent-user-message'); root.append(user);
    const work = detail('工作过程'); work.className = 'agent-turn-work'; work.open = turn.status === 'running'; const workContent = text('div', '', 'agent-work-content'); work.append(workContent);
    const answer = this.message('AI', '', 'agent-turn-answer'); answer.hidden = !turn.answer && !turn.error; const answerContent = answer.querySelector('.agent-message-body');
    if (turn.answer) renderAgentMarkdown(answerContent, turn.answer);
    if (turn.error) answerContent.append(text('p', turn.error, 'agent-error'));
    const meta = text('small', agentUsageText(turn.statistics), 'agent-turn-meta'); const actions = text('div', '', 'agent-turn-actions'); actions.hidden = turn.status === 'running';
    if (turn.status === 'queued') {
      meta.textContent = turn.paused ? '队列已暂停' : '等待执行'; work.hidden = true;
      actions.append(button('插话', () => this.interrupt(turn.text, turn, record)), button('取消排队', () => { turn.status = 'cancelled'; this.save(turn); this.refreshTurn(record, turn); this.updateBusy(); }));
    } else {
      if (turn.status === 'steered') { meta.textContent = '已作为插话补充到正在执行的任务'; work.hidden = true; }
      if (turn.status === 'cancelled') { meta.textContent = '已取消排队'; work.hidden = true; }
      actions.append(button('编辑后重发', () => this.edit(record, turn, user)), button('重试', () => turn.compactOnly ? this.compact() : this.resend(record, turn, turn.text)));
      for (const action of actions.children) action.title = '创建独立对话分支；已执行的谱面修改不会自动撤销。';
    }
    for (const entry of turn.process ?? []) {
      if (entry.kind === 'tool') workContent.append(this.jsonDetail(entry.name, { arguments: entry.arguments, result: entry.result }));
      else if (entry.kind === 'question') { const question = detail('提问与回答'); question.append(text('p', entry.question), text('p', entry.answer)); workContent.append(question); }
      else if (entry.kind === 'steering') { const message = this.message(entry.pending ? '补充说明 · 待发送' : '补充说明', entry.text, 'agent-user-message'); if (entry.id) message.dataset.steeringId = entry.id; workContent.append(message); }
      else if (entry.kind === 'compaction') workContent.append(this.jsonDetail('上下文压缩', entry));
      else {
        if (!entry.text && !entry.reasoning) continue;
        const round = this.modelRound(workContent); round.source = entry.text ?? ''; round.thinking = entry.reasoning ?? ''; this.renderRound(round, true); this.roundMetrics(round, entry.statistics);
      }
    }
    root.append(work, answer, meta, actions); parent.querySelector('.agent-intro')?.remove(); parent.append(root);
    const view = { root, user, work, workContent, answer, answerContent, meta, actions, inspect }; this.turnViews.set(turn, view); return view;
  }
  refreshTurn(record, turn) {
    const parent = this.recordView(record), previous = this.turnViews.get(turn), next = previous?.root.nextSibling;
    previous?.root.remove(); const view = this.turnView(record, turn, parent); if (next?.parentNode === parent) parent.insertBefore(view.root, next); return view;
  }
  message(role, source, className) {
    const node = text('section', '', className), body = text('div', source, 'agent-content agent-message-body'), toggle = button('', () => this.expandMessage(node, body.hidden));
    toggle.className = 'agent-message-toggle'; toggle.setAttribute('aria-expanded', 'true'); toggle.append(text('span', role, 'agent-message-role'), text('span', '', 'agent-message-preview')); node.append(toggle, body); return node;
  }
  expandMessage(node, open) {
    const body = node.querySelector('.agent-message-body'), toggle = node.querySelector('.agent-message-toggle'); body.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('.agent-message-preview').textContent = open ? '' : body.textContent.replace(/\s+/g, ' ').trim();
  }
  show(id) {
    const previous = this.store.records.get(this.visibleId); if (previous) previous.draft = this.panel.input.value;
    const previousScroll = this.scrollStates.get(this.visibleId); if (previousScroll) previousScroll.top = this.viewport.scrollTop;
    const record = this.store.select(id); this.viewport.replaceChildren(this.recordView(record)); this.panel.input.value = record.draft;
    this.visibleId = id;
    this.contextMode.value = record.context.mode; this.contextCount.value = record.context.turns; this.contextCount.hidden = record.context.mode !== 'last'; this.updateChoices(); this.updateStatus(); this.updateContextUsage();
    const state = this.scrollState(); this.viewport.scrollTop = state.follow ? this.viewport.scrollHeight : state.top; state.top = this.viewport.scrollTop; state.bottom = Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight); state.direction = 0;
    if (!this.loading) this.save(); this.updateBusy();
  }
  updateChoices() {
    this.select.replaceChildren(...[...this.store.records.values()].map(record => { const node = text('option', (this.running?.record === record ? '● ' : '') + record.title); node.value = record.id; return node; })); this.select.value = this.store.selected;
  }
  updateBusy() {
    const busy = Boolean(this.panel.agent?.busy), loading = Boolean(this.loading);
    this.panel.send.hidden = false; this.panel.send.textContent = busy ? '排队发送' : '发送'; this.panel.send.disabled = loading;
    this.panel.stop.hidden = !busy; this.interruptButton.hidden = !busy; this.interruptButton.disabled = !this.panel.input.value.trim() || this.running?.record !== this.store.current;
    this.panel.configure.disabled = this.panel.permission.disabled = busy || loading; this.panel.input.disabled = loading;
    this.contextMode.disabled = this.contextCount.disabled = this.select.disabled = this.panel.clear.disabled = loading;
    this.compactButton.disabled = busy || loading || !this.store.current.turns.some(turn => turn.messages?.length);
    for (const record of this.store.records.values()) for (const turn of record.turns) {
      const view = this.turnViews.get(turn); if (!view) continue;
      for (const node of view.actions.children) node.disabled = loading || (turn.status === 'queued' ? node.textContent === '插话' && (!busy || this.running?.record !== record) : busy);
    }
    const queued = this.queued(); this.resumeQueue.hidden = !queued.length || this.autoQueue && !queued.some(entry => entry.turn.paused);
  }
  updateStatus(value) {
    if (!this.panel.agent) return;
    if (value) this.phase = value;
    const busy = this.panel.agent.busy;
    this.panel.status.textContent = this.loading ? '正在读取本谱面对话…' : busy ? (this.running?.record.title ?? '任务') + ' · ' + (this.phase ?? '处理中') : '就绪 · ' + (this.panel.key ? this.panel.settings.model : '请先配置 API Key');
    this.background.hidden = !busy || !this.running || this.running.record === this.store.current;
    if (!this.background.hidden) this.background.textContent = `查看“${this.running.record.title}”的${this.phase ?? '进行中任务'}`;
  }
  updateContextUsage() {
    if (!this.usage || !this.panel.agent) return;
    const config = this.panel.settings, record = this.store.current, stored = record.contextUsage;
    const compatible = stored?.signature === agentContextSignature(config, record.context), capabilities = this.panel.capabilities();
    const policy = agentContextPolicy(config, { ...capabilities, contextWindow: capabilities.source === 'provider' ? capabilities.contextWindow : compatible ? stored.contextWindow : capabilities.contextWindow });
    const running = this.running?.record === record && this.panel.agent.busy;
    let usage = running && this.panel.agent.contextUsage ? this.panel.agent.contextUsage : compatible ? agentContextUsage(stored.tokens, policy, stored.estimated) : null;
    if (!usage) {
      const messages = prepareAgentHistory(conversationMessages(record)), selected = new Set(AGENT_CORE_TOOLS);
      for (const message of messages) for (const call of message.tool_calls ?? []) selected.add(call.function.name);
      const system = config.prompt + '\n当前环境（宿主生成的数据，可能随编辑变化，需要时重新读取）：\n' + JSON.stringify(this.panel.adapter.summary()) + '\n当前权限模式：' + config.permission + '\n模型能力：' + JSON.stringify(capabilities);
      usage = agentContextUsage(estimateAgentTokens({ system, tools: this.panel.commands.tools().filter(tool => selected.has(tool.function.name)), messages }), policy);
    }
    const ratio = Math.max(0, usage.ratio), percentage = (ratio * 100).toFixed(1) + '%';
    const number = usage.tokens >= 1000000 ? (usage.tokens / 1000000).toFixed(2) + 'M' : usage.tokens >= 1000 ? (usage.tokens / 1000).toFixed(1) + 'K' : String(usage.tokens);
    this.usageRing.style.setProperty('--agent-context-progress', Math.min(100, ratio * 100) + '%');
    this.usageNumber.textContent = number + ' ' + percentage; this.usage.classList.toggle('agent-context-warning', usage.tokens >= usage.threshold);
    this.usage.title = `${usage.estimated ? '估算' : '接口统计'} ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens；${policy.automatic ? '自动压缩阈值 ' + policy.threshold.toLocaleString() : '自动压缩已关闭'}`;
    this.usage.setAttribute('aria-valuemax', String(usage.contextWindow)); this.usage.setAttribute('aria-valuenow', String(usage.tokens)); this.usage.setAttribute('aria-valuetext', this.usage.title);
  }
  async send(source, instruction = '', { compactOnly = false } = {}) {
    const generation = this.generation, selected = this.store.selected; await Promise.all([this.panel.credentialsReady, this.ready]); if (generation !== this.generation) return;
    const panel = this.panel, record = this.store.records.get(selected) ?? this.store.current, value = compactOnly ? '压缩上下文' : source.trim(); if (!value) return;
    if (!panel.key) { panel.configuration(); return; }
    const turn = { id: crypto.randomUUID(), text: value, instruction, compactOnly, status: 'queued', process: [], messages: compactOnly ? [] : [{ role: 'user', content: value }], answer: '', createdAt: Date.now(), queueOrder: Date.now() + (this.sequence = (this.sequence ?? 0) + 1) / 1000 };
    if (!record.turns.length && record.title === '新对话') record.title = value.replace(/\s+/g, ' ').slice(0, 24);
    const parent = this.recordView(record); record.turns.push(turn); this.turnView(record, turn, parent); if (this.store.current === record && !compactOnly) panel.input.value = ''; record.draft = ''; this.save(turn); this.autoQueue = true; this.updateChoices(); this.updateBusy(); this.scroll(true); this.drain();
  }
  queued() { return [...this.store.records.values()].flatMap(record => record.turns.filter(turn => turn.status === 'queued').map(turn => ({ record, turn }))).sort((first, second) => (first.turn.queueOrder ?? first.turn.createdAt) - (second.turn.queueOrder ?? second.turn.createdAt)); }
  pauseQueue() { this.autoQueue = false; for (const { turn, record } of this.queued()) { turn.paused = true; this.save(turn); this.refreshTurn(record, turn); } this.updateBusy(); }
  async drain() {
    if (this.draining || !this.autoQueue || this.panel.agent.busy || this.loading) return;
    const next = this.queued().find(entry => !entry.turn.paused); if (!next) { this.updateBusy(); return; }
    this.draining = true; try { await this.start(next.record, next.turn); } finally { this.draining = false; if (this.autoQueue) queueMicrotask(() => this.drain()); }
  }
  compact() { if (!this.panel.agent.busy) return this.send('', '', { compactOnly: true }); }
  interrupt(source, queued, record = this.store.current) {
    const value = source.trim(); if (!value || this.running?.record !== record || !this.panel.agent.steer(value)) return;
    let supplement = queued;
    if (queued) { queued.status = 'steered'; queued.messages = []; queued.linkedTurn = this.running.turn.id; this.save(queued); this.refreshTurn(record, queued); }
    else {
      const turn = { id: crypto.randomUUID(), text: value, status: 'steered', linkedTurn: this.running.turn.id, process: [], messages: [], answer: '', createdAt: Date.now() };
      const parent = this.recordView(record); record.turns.push(turn); this.turnView(record, turn, parent); this.panel.input.value = ''; record.draft = ''; this.save(turn); supplement = turn;
    }
    const entry = { kind: 'steering', id: supplement.id, text: value, pending: true }; this.running.turn.process.push(entry);
    const message = this.message('补充说明 · 待发送', value, 'agent-user-message'); message.dataset.steeringId = entry.id; this.running.view.workContent.append(message); this.running.view.work.open = true; this.save(this.running.turn);
    this.updateBusy(); this.updateStatus('正在插话…');
  }
  async start(record, turn) {
    const panel = this.panel, history = conversationMessages(record); turn.status = turn.compactOnly ? 'compacting' : 'running'; turn.startedAt = Date.now();
    const view = this.refreshTurn(record, turn); view.actions.hidden = true; view.work.hidden = false; view.work.open = true;
    this.running = { record, turn, view, store: this.store, repository: this.repository, contextMode: record.context.mode }; this.save(turn); this.updateChoices(); this.updateBusy();
    this.elapsedTimer = setInterval(() => { if (this.running?.turn === turn) view.meta.textContent = `${panel.settings.model} · 已运行 ${time(panel.agent.elapsedMs())}`; }, 250);
    try { await panel.agent.run(turn.compactOnly ? '' : turn.text, { history, instruction: turn.instruction, compactOnly: turn.compactOnly }); }
    catch (error) { clearInterval(this.elapsedTimer); this.elapsedTimer = null; turn.status = 'failed'; turn.error = error.message; view.answer.hidden = false; view.answerContent.textContent = error.message; view.actions.hidden = false; view.work.open = false; this.running = null; this.pauseQueue(); this.save(turn); this.updateBusy(); this.updateStatus(); }
  }
  edit(record, turn, user) {
    if (this.panel.agent.busy || user.querySelector('textarea')) return;
    const edit = document.createElement('textarea'); edit.className = 'agent-history-editor'; edit.value = turn.text; edit.setAttribute('aria-label', '编辑历史消息'); const actions = text('div', '', 'agent-actions');
    const hint = text('small', '重发将创建分支；已完成的谱面修改保留。', 'hint');
    actions.append(button('重新发送', () => this.resend(record, turn, edit.value)), button('取消', () => { edit.remove(); actions.remove(); hint.remove(); })); this.expandMessage(user, true); user.querySelector('.agent-message-body').append(edit, hint, actions); edit.focus();
  }
  resend(record, turn, source) {
    if (this.panel.agent.busy || !source.trim()) return;
    const next = this.store.branch(record.id, record.turns.indexOf(turn)); this.show(next.id);
    return this.send(source, '本次是历史消息的编辑重发或重试。旧回复所执行的谱面操作仍保留，未自动撤销；务必先重新读取当前状态，不要重复生成已有物件。');
  }
  fold(open) { for (const turn of this.recordView(this.store.current).querySelectorAll('.agent-turn')) { this.expandMessage(turn.querySelector('.agent-user-message'), open); this.expandMessage(turn.querySelector('.agent-turn-answer'), open); turn.querySelector('.agent-turn-work').open = open; } }
  manage() {
    const dialog = document.createElement('dialog'); dialog.className = 'agent-manage-dialog'; dialog.id = 'ai-conversation-manager'; dialog.dataset.agentPrivate = 'true';
    const record = this.store.current, name = document.createElement('input'); name.value = record.title; name.setAttribute('aria-label', '对话名称');
    dialog.append(text('h3', '管理对话'), name, button('重命名', () => { if (!name.value.trim()) return; this.store.rename(record.id, name.value); this.updateChoices(); this.save(); dialog.close(); }), button('删除此对话', () => { if (this.running?.record === record) { this.panel.notify('请先停止此对话的任务', 'warning'); return; } if (!confirm('删除此对话？已执行的谱面修改会保留。')) return; this.views.delete(record.id); this.scrollStates.delete(record.id); this.store.remove(record.id); this.show(this.store.selected); this.save(); dialog.close(); }), button('折叠全部', () => { this.fold(false); dialog.close(); }), button('展开全部', () => { this.fold(true); dialog.close(); }), button('关闭', () => dialog.close()));
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  }
  pending(signal, create, phase) {
    const task = this.running; this.updateStatus(phase);
    return new Promise(resolve => {
      let done = false, card;
      const finish = value => { if (done) return; done = true; signal?.removeEventListener('abort', abort); this.panel.waiting.delete(finish); if (card) { card.classList.add('agent-resolved'); card.querySelector('strong').textContent = value === true ? '已批准' : value?.answer ? '已回答' : signal?.aborted ? '已停止' : '已拒绝'; for (const node of card.querySelectorAll('button,input,textarea')) node.disabled = true; } resolve(value); };
      const abort = () => finish(false); this.panel.waiting.add(finish); signal?.addEventListener('abort', abort, { once: true }); card = create(finish);
      if (!task) { finish(false); return; }
      task.view.work.open = true; task.view.workContent.append(card); this.panel.tab.hidden = false;
      this.scroll(); if (signal?.aborted) finish(false);
    });
  }
  approve(plan, signal) {
    this.panel.notify('AI 等待批准：' + plan.summary, 'warning');
    return this.pending(signal, finish => { const card = text('div', '', 'agent-approval'); card.append(text('strong', plan.access === 'dangerous' ? '关键操作 · 等待批准' : '编辑操作 · 等待批准'), text('p', plan.summary), this.jsonDetail('查看完整变更', plan.details)); const actions = text('div', '', 'agent-actions'); actions.append(button('批准本次', () => finish(true)), button('拒绝', () => finish(false))); card.append(actions); return card; }, '等待批准');
  }
  ask(args, signal) {
    this.panel.notify('AI 需要回答：' + args.question.replace(/\s+/g, ' ').slice(0, 120), 'warning');
    return this.pending(signal, finish => { const card = text('form', '', 'agent-question'); card.append(text('strong', '需要补充信息')); const question = text('div', '', 'agent-content'); renderAgentMarkdown(question, args.question); card.append(question);
      const input = document.createElement('textarea'); input.rows = 3; input.setAttribute('aria-label', '回答 AI 的问题'); const reply = value => { this.running?.turn.process.push({ kind: 'question', question: args.question, answer: value }); if (this.running) this.save(this.running.turn); card.append(text('p', value)); finish({ answer: value }); };
      const choices = text('div', '', 'agent-actions agent-question-choices'); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', '回答选项'); for (const choice of args.choices ?? []) choices.append(button(choice, () => reply(choice))); card.append(choices, input, button('回答并继续', () => { if (input.value.trim()) reply(input.value.trim()); })); card.onsubmit = event => { event.preventDefault(); if (input.value.trim()) reply(input.value.trim()); }; return card;
    }, '等待回答');
  }
  scrollState() { if (!this.scrollStates.has(this.visibleId)) this.scrollStates.set(this.visibleId, { top: 0, bottom: Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight), follow: true, direction: 0 }); return this.scrollStates.get(this.visibleId); }
  trackScroll() {
    const state = this.scrollState(), top = this.viewport.scrollTop, bottom = Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
    if (top < state.top - 2 && state.direction <= 0 && bottom - top > 2) state.follow = false;
    else if (state.direction >= 0 && (bottom - top <= 2 || top > state.top + 2 && state.bottom - top <= 96)) state.follow = true;
    state.top = top; state.bottom = bottom;
  }
  scroll(force = false) {
    if (this.running && this.running.record !== this.store.current) return;
    const state = this.scrollState(), top = this.viewport.scrollTop;
    if (force) { state.follow = true; state.direction = 0; }
    else if (!state.follow && state.direction >= 0 && top > state.top + 2 && state.bottom - top <= 96) state.follow = true;
    if (state.follow) this.viewport.scrollTop = this.viewport.scrollHeight;
    state.top = this.viewport.scrollTop; state.bottom = Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
  }
  reset() { this.panel.agent?.stop(); clearTimeout(this.renderTimer); clearInterval(this.elapsedTimer); this.elapsedTimer = this.renderTimer = null; this.round = null; this.running = null; this.loading = false; this.ready = Promise.resolve(); this.autoQueue = false; this.store = new AgentConversations(); this.views.clear(); this.turnViews = new WeakMap(); this.scrollStates.clear(); this.visibleId = null; this.show(this.store.selected); }
}
