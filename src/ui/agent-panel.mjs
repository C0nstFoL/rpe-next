import { AgentCommands, AGENT_API_VERSION } from '../core/agent-commands.mjs';
import { DEFAULT_AGENT_PROMPT } from '../core/agent-prompt.mjs';
import { EditorAgent } from '../application/agent.mjs';
import { createAgentEditorCommands } from '../application/agent-editor.mjs';
import { AgentProviders, createDeepSeekProvider } from '../platform/agent-provider.mjs';
import { localPreferences } from '../platform/local-preferences.mjs';
import { AgentControls } from './agent-controls.mjs';
import { AgentDialogues } from './agent-dialogues.mjs';
import { AgentCredentials } from '../platform/agent-credentials.mjs';
import { AgentWorkspace } from '../platform/agent-workspace.mjs';
import { AgentCapture } from './agent-capture.mjs';

const SETTINGS = 'rpe-next-agent-v1';
export const DEFAULT_AGENT_SETTINGS = Object.freeze({ provider: 'deepseek', model: 'deepseek-flash', permission: 'ask', thinking: true, maxTokens: 65536, maxRounds: 128, autoCompact: true, contextBudget: 0, fontSize: 14, rememberKey: true, prompt: DEFAULT_AGENT_PROMPT, uiVersion: 4 });
export function agentSettings(saved = {}) {
  const settings = Object.fromEntries(Object.entries(DEFAULT_AGENT_SETTINGS).map(([name, fallback]) => [name, typeof saved?.[name] === typeof fallback ? saved[name] : fallback]));
  if ((saved.uiVersion ?? 0) < 4) {
    if (saved.maxRounds === 24) settings.maxRounds = 128;
    if (saved.contextBudget === 131072) settings.contextBudget = 0;
  }
  if (!Number.isInteger(settings.maxRounds) || settings.maxRounds < 1 || settings.maxRounds > 4096) settings.maxRounds = 128;
  if (!Number.isInteger(settings.contextBudget) || settings.contextBudget !== 0 && (settings.contextBudget < 8192 || settings.contextBudget > 16777216)) settings.contextBudget = 0;
  settings.uiVersion = 4; return settings;
}
const text = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; };
const button = (label, action) => { const node = text('button', label); node.type = 'button'; node.onclick = action; return node; };
const dataUrl = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });

export class AgentPanel {
  constructor(editor, { activate, writeAsset, capture, notify, prependSilence }) {
    Object.assign(this, { editor, activate, notify }); this.commands = new AgentCommands(); this.providers = new AgentProviders(); this.providers.register(createDeepSeekProvider());
    let saved; try { saved = JSON.parse(localPreferences.getItem(SETTINGS) ?? '{}'); } catch { saved = {}; }
    this.settings = agentSettings(saved);
    if (!Number.isInteger(this.settings.fontSize) || this.settings.fontSize < 10 || this.settings.fontSize > 24) this.settings.fontSize = DEFAULT_AGENT_SETTINGS.fontSize;
    if (typeof saved?.prompt === 'string' && [3850, 4771, 5691, 5814, 6145, 6368, 6672, 6885, 8116, 8250].includes(saved.prompt.length)) { let fingerprint = 2166136261; for (const character of saved.prompt) fingerprint = Math.imul(fingerprint ^ character.charCodeAt(0), 16777619); if ([[3850, 2788652168], [4771, 365650397], [5691, 381708962], [5814, 3991041475], [6145, 993312695], [6368, 920097850], [6672, 694240356], [6885, 995422563], [8116, 2954976899], [8250, 3185019651]].some(([length, value]) => saved.prompt.length === length && (fingerprint >>> 0) === value)) this.settings.prompt = DEFAULT_AGENT_PROMPT; }
    if (!saved?.uiVersion && saved?.maxTokens === 8192) this.settings.maxTokens = 65536;
    this.key = ''; this.credentials = new AgentCredentials(); this.waiting = new Set(); this.host = document.querySelector('#ai-panel'); this.tab = document.querySelector('#ai-tab'); this.controls = new AgentControls();
    this.applyAppearance();
    this.dialogues = new AgentDialogues(this);
    const network = async (method, value, signal) => {
      const config = this.config(), provider = this.providers.get(config.provider); if (typeof provider[method] !== 'function') throw Error('此模型服务没有可用的联网工具');
      const result = await provider[method](config, value, signal), encoded = JSON.stringify(result);
      return encoded.length > 45000 ? { content: encoded.slice(0, 45000), truncated: true } : result;
    };
    this.workspace = new AgentWorkspace(() => editor.agentWorkspaceId);
    this.capture = new AgentCapture({ controls: this.controls, refresh: () => editor.invalidate() });
    this.adapter = createAgentEditorCommands(this.commands, editor, { controls: this.controls, network, ask: (args, signal) => this.dialogues.ask(args, signal), capture, captureEditor: (args, signal) => this.capture.capture(args, signal), prependSilence, workspace: this.workspace });
    editor.agent = { apiVersion: AGENT_API_VERSION, commands: this.commands, providers: this.providers, allowedPanes: () => [...document.querySelectorAll('[data-panel]')].map(node => node.dataset.panel),
      capabilities: () => this.capabilities(), workspace: this.workspace, flush: () => this.flush(), dataUrl, writeAsset, open: () => this.open() };
    this.agent = new EditorAgent({ commands: this.commands, providers: this.providers, context: () => ({ session: editor.hasDocument ? editor.session : null, summary: this.adapter.summary() }),
      config: () => this.config(), approve: (plan, signal) => this.dialogues.approve(plan, signal), prompt: () => this.settings.prompt });
    this.dialogues.bind(this.agent); this.dialogues.updateStatus();
    this.credentialsReady = this.settings.rememberKey ? this.credentials.read(this.settings.provider).then(key => { this.key = key; this.dialogues.updateStatus(); }).catch(error => this.notify(error.message, 'warning')) : Promise.resolve();
    this.credentialsReady.then(() => this.refreshCapabilities());
    Object.defineProperty(editor.agent, 'ready', { get: () => Promise.all([this.credentialsReady, this.dialogues.ready]) });
    document.querySelector('#ai-tool').onclick = () => this.open(); this.tab.onclick = () => this.open();
  }
  config() { return { ...this.settings, key: this.key }; }
  capabilities() {
    const config = this.settings, metadata = this.modelMetadata;
    return { ...this.providers.get(config.provider).capabilities?.(config.model), ...(metadata?.provider === config.provider && metadata.model === config.model ? metadata.value : {}) };
  }
  async refreshCapabilities() {
    const config = this.config(), provider = this.providers.get(config.provider), generation = this.metadataGeneration = (this.metadataGeneration ?? 0) + 1;
    try {
      const value = config.key && provider.modelInfo ? await provider.modelInfo(config) : {};
      if (generation !== this.metadataGeneration || this.key !== config.key) return;
      this.modelMetadata = { provider: config.provider, model: config.model, value }; this.dialogues.updateContextUsage();
    } catch { if (generation === this.metadataGeneration) this.dialogues.updateContextUsage(); }
  }
  applyAppearance() { this.host.style.setProperty('--agent-font-size', this.settings.fontSize + 'px'); }
  persist() { localPreferences.setItem(SETTINGS, JSON.stringify(this.settings)); }
  open() { this.tab.hidden = false; this.activate('ai'); this.input.focus({ preventScroll: true }); }
  attach(workspace) { return this.dialogues.attach(workspace); }
  flush() { return this.dialogues.flush(); }
  async stopAndFlush() {
    this.dialogues.pauseQueue();
    if (this.agent.busy) await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.agent.removeEventListener('state', changed); resolve(); };
      const changed = () => { if (!this.agent.busy) finish(); }, timer = setTimeout(finish, 10000);
      this.agent.addEventListener('state', changed); this.agent.stop();
    });
    await this.flush();
  }
  reset() { this.dialogues.detach(); this.agent?.reset(); for (const finish of [...this.waiting]) finish(false); this.dialogues.reset(); this.tab.hidden = true; }
  async configuration() {
    await this.credentialsReady;
    if (this.agent?.busy) return;
    this.dialog?.remove(); const dialog = document.createElement('dialog'); dialog.id = 'ai-config'; dialog.dataset.agentPrivate = 'true'; this.dialog = dialog;
    const heading = text('div', '', 'agent-heading'); heading.append(text('h2', 'AI 配置'), button('关闭', () => dialog.close())); dialog.append(heading);
    const form = document.createElement('form'); form.className = 'agent-config-form';
    const field = (label, control) => { const row = text('label', label, 'field'); if (!control.hasAttribute('aria-label')) control.setAttribute('aria-label', label); row.append(control); form.append(row); return control; };
    const provider = document.createElement('select'); provider.setAttribute('aria-label', 'AI 服务');
    for (const entry of this.providers.entries.values()) { const option = text('option', entry.name); option.value = entry.id; provider.append(option); }
    provider.value = this.providers.entries.has(this.settings.provider) ? this.settings.provider : 'deepseek'; field('服务', provider);
    const model = document.createElement('input'); model.type = 'text'; model.value = this.settings.model; model.setAttribute('aria-label', 'AI 模型'); model.setAttribute('list', 'ai-model-options');
    const models = document.createElement('datalist'); models.id = 'ai-model-options'; const updateModels = () => models.replaceChildren(...(this.providers.get(provider.value).models ?? []).map(name => { const option = document.createElement('option'); option.value = name; return option; })); updateModels();
    field('模型', model); form.append(models);
    const key = document.createElement('input'); key.type = 'password'; key.autocomplete = 'off'; key.value = this.key; key.setAttribute('aria-label', 'DeepSeek API Key'); field('API Key', key);
    const remember = document.createElement('input'); remember.type = 'checkbox'; remember.checked = this.settings.rememberKey; field('记住 API Key', remember);
    form.append(text('p', this.credentials.bridge ? '记住后在本机使用系统加密保存，更新程序后沿用。取消勾选会清除已保存的 Key。联网搜索可能产生额外 API 费用。' : '记住后保存在此浏览器的独立本地存储中。取消勾选会清除已保存的 Key。联网搜索可能产生额外 API 费用。', 'hint'));
    const forget = button('清除已保存的 Key', async () => {
      forget.disabled = true;
      try { await this.credentials.write(provider.value, ''); key.value = ''; drafts.delete(provider.value); if (provider.value === this.settings.provider) { this.key = ''; this.dialogues.updateStatus(); } error.textContent = ''; this.notify('已清除已保存的 API Key', 'success'); }
      catch (problem) { error.textContent = problem.message; }
      finally { forget.disabled = false; }
    }); form.append(forget);
    const thinking = document.createElement('input'); thinking.type = 'checkbox'; thinking.checked = this.settings.thinking; field('启用思考', thinking);
    const tokens = document.createElement('input'); tokens.type = 'number'; tokens.min = '1024'; tokens.max = '65536'; tokens.step = '1024'; tokens.value = this.settings.maxTokens; field('单次输出上限（tokens）', tokens);
    const rounds = document.createElement('input'); rounds.type = 'number'; rounds.min = '1'; rounds.max = '4096'; rounds.step = '1'; rounds.value = this.settings.maxRounds; rounds.title = '一次用户任务最多请求模型多少轮；每轮可调用多个工具，最终答复也计一轮。'; field('每任务最大模型请求轮数', rounds);
    const automatic = document.createElement('input'); automatic.type = 'checkbox'; automatic.checked = this.settings.autoCompact; field('自动压缩上下文', automatic);
    const budgetMode = document.createElement('select');
    for (const [value, label] of [['auto', '自动（模型上下文的 65%）'], ['custom', '自定义阈值']]) { const option = text('option', label); option.value = value; budgetMode.append(option); }
    budgetMode.value = this.settings.contextBudget ? 'custom' : 'auto'; field('压缩阈值', budgetMode);
    const budget = document.createElement('input'); budget.type = 'number'; budget.min = '8192'; budget.max = '16777216'; budget.step = '1'; budget.value = this.settings.contextBudget || Math.floor((this.capabilities().contextWindow ?? 1048576) * 0.65); budget.title = '自动模式优先读取模型服务提供的上下文长度；DeepSeek 获取失败时按 1M 计算，同时为输出预留空间。'; const budgetRow = field('自定义阈值（tokens）', budget).closest('label');
    const updateBudget = () => { budgetMode.disabled = !automatic.checked; budgetRow.hidden = budgetMode.value !== 'custom'; budget.disabled = !automatic.checked || budgetMode.value !== 'custom'; }; automatic.onchange = budgetMode.onchange = updateBudget; updateBudget();
    const font = document.createElement('input'); font.type = 'number'; font.min = '10'; font.max = '24'; font.step = '1'; font.value = this.settings.fontSize; field('面板字号（px）', font);
    const instructions = document.createElement('details'); instructions.append(text('summary', '查看 / 修改系统提示词'));
    const prompt = document.createElement('textarea'); prompt.rows = 16; prompt.className = 'agent-system-prompt'; prompt.value = this.settings.prompt; prompt.setAttribute('aria-label', 'Agent 系统提示词');
    instructions.append(prompt, button('恢复内置提示词', () => { if (confirm('恢复内置系统提示词？')) prompt.value = DEFAULT_AGENT_PROMPT; })); form.append(instructions);
    const error = text('p', '', 'agent-error'); form.append(error); const apply = button('应用配置', () => {}); apply.type = 'submit'; form.append(apply);
    const drafts = new Map(); let selectedProvider = provider.value, loading = 0;
    provider.onchange = async () => {
      drafts.set(selectedProvider, key.value); selectedProvider = provider.value; model.value = this.providers.get(provider.value).defaultModel; updateModels();
      const serial = ++loading; key.disabled = apply.disabled = forget.disabled = true;
      try { const value = drafts.has(selectedProvider) ? drafts.get(selectedProvider) : this.settings.rememberKey ? await this.credentials.read(selectedProvider) : ''; if (serial === loading) key.value = value; }
      catch (problem) { if (serial === loading) { key.value = ''; error.textContent = problem.message; } }
      finally { if (serial === loading) key.disabled = apply.disabled = forget.disabled = false; }
    };
    form.onsubmit = async event => {
      event.preventDefault(); const maxTokens = Number(tokens.value), maxRounds = Number(rounds.value), fontSize = Number(font.value), contextBudget = budgetMode.value === 'auto' ? 0 : Number(budget.value);
      if (!model.value.trim() || !prompt.value.trim() || !Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 65536 || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 4096 || !Number.isInteger(fontSize) || fontSize < 10 || fontSize > 24) { error.textContent = '请检查模型、系统提示词和数值范围'; return; }
      if (!Number.isInteger(contextBudget) || contextBudget !== 0 && (contextBudget < 8192 || contextBudget > 16777216)) { error.textContent = '上下文压缩阈值需在 8192–16777216 之间'; return; }
      const next = { ...this.settings, provider: provider.value, model: model.value.trim(), thinking: thinking.checked, maxTokens, maxRounds, autoCompact: automatic.checked, contextBudget, fontSize, rememberKey: remember.checked, prompt: prompt.value }, apiKey = key.value.trim();
      if (key.disabled || apply.disabled) return;
      const controls = [...form.querySelectorAll('input,select,textarea,button')]; controls.forEach(control => { control.disabled = true; });
      try {
        await this.credentials.write(next.provider, next.rememberKey ? apiKey : '');
        localPreferences.setItem(SETTINGS, JSON.stringify(next)); this.settings = next; this.key = apiKey;
        this.applyAppearance(); this.dialogues.updateStatus(); this.dialogues.updateContextUsage(); this.refreshCapabilities(); dialog.close();
      } catch (problem) { error.textContent = problem.message; }
      finally { controls.forEach(control => { control.disabled = false; }); updateBudget(); }
    };
    dialog.append(form); document.body.append(dialog); dialog.showModal();
  }
}
