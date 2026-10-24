import { SEPARATION_MODELS } from '../core/audio-sources.mjs';
import { localPreferences } from '../platform/local-preferences.mjs';
import { pcmWave } from '../platform/pcm-wave.mjs';
import { download } from '../platform/files.mjs';
import { AudioOnsetsPanel } from './audio-onsets.mjs';
import { showAudioSeparationGuide } from './audio-separation-guide.mjs';
import { showAudioStorage, clearAudioCaches } from './audio-storage.mjs';
import { prepareAudioStorage } from '../platform/audio-storage.mjs';

const node = (tag, text = '', className = '') => { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; };
export class AudioSourcesPanel {
  constructor(sources, notify = () => {}, onsets) {
    this.sources = sources; this.notify = notify; this.host = node('div', '', 'audio-sources-panel');
    try { this.options = JSON.parse(localPreferences.getItem('rpe-next-audio-separation-v1') ?? '{}'); } catch { this.options = {}; }
    if (onsets) this.onsetPanel = new AudioOnsetsPanel(onsets, sources, notify);
    sources.addEventListener('change', () => this.render()); sources.addEventListener('progress', () => this.progress()); this.render();
    sources.separator.bridge?.onProgress(value => {
      if (value.id !== 'environment' || !this.configuring) return;
      this.installLog = [...(this.installLog ?? []), value.message ?? ''].slice(-40);
      if (value.stage !== 'log' && value.stage !== 'environment' || !this.statusText) this.statusText = value.message ?? '正在安装分离环境…';
      if (this.message) this.message.textContent = this.statusText; if (this.logOutput) this.logOutput.textContent = this.installLog.join('\n');
    });
    globalThis.rpenAudioStorage?.onProgress?.(value => {
      if (value.stage !== 'cleared') return;
      this.cacheReset = this.resetAudioCaches().catch(error => this.notify(error.message, 'error'));
    });
  }
  async resetAudioCaches() {
    this.sources.controller?.abort();
    const onsets = this.onsetPanel?.onsets; onsets?.cancel(); if (onsets) { onsets.cache = new WeakMap(); onsets.clearPreview(); }
    if (this.sources.original) await this.sources.select('original');
    for (const entry of this.sources.list()) if (entry.kind === 'separated') await this.sources.remove(entry.id);
    this.statusText = '全部谱面的音频缓存已清理；分离音源和采音预览已清除。'; this.render();
  }
  async action(task) { try { return await task(); } catch (error) { if (error.name === 'AbortError' && this.sources.selecting) return; this.statusText = error.name === 'AbortError' ? '操作已取消，可重新开始。' : error.message; this.notify(this.statusText, error.name === 'AbortError' ? 'warning' : 'error'); if (this.message) this.message.textContent = this.statusText; } finally { this.render(); } }
  async refreshEnvironment() {
    if (!this.sources.separator.bridge || this.checkedEnvironment || this.configuring) return;
    this.checkedEnvironment = true; await this.action(async () => {
      if (!await prepareAudioStorage()) { this.checkedEnvironment = false; this.statusText = '尚未选择音频工具存放位置，未启动安装或分离。'; return; }
      await this.environment('probe');
    });
  }
  async environment(action) {
    if (this.configuring) return; this.configuring = true; this.installLog = []; this.statusText = action === 'probe' ? '正在检查分离环境…' : '正在准备声部分离环境…'; this.render();
    try {
      const info = await this.sources.separator.call(action);
      if (info) { this.environmentInfo = info; this.statusText = info.ready ? `分离环境已就绪 · ${info.cuda ? 'NVIDIA 加速可用' : 'CPU'}，可以分离当前音乐。` : '尚未就绪：' + info.message; }
      else this.statusText = this.environmentInfo?.ready ? '已保留现有分离环境。' : '尚未安装分离环境。点击“一键准备分离环境”继续。';
    }
    finally { this.configuring = false; this.render(); }
  }
  saveOptions() { localPreferences.setItem('rpe-next-audio-separation-v1', JSON.stringify(this.options)); }
  button(text, task) { const button = node('button', text); button.type = 'button'; button.onclick = () => this.action(task); return button; }
  render() {
    const sources = this.sources, entries = sources.list(), desktop = Boolean(sources.separator.bridge); this.host.replaceChildren(); this.host.append(node('h3', '声部与分析音源'));
    const guide = node('div', '', 'audio-source-guide');
    guide.append(node('p', desktop ? '首次：准备环境 → 分离音乐 → 选择声部。安装只做一次，不需要先装 Python。' : '网页端：先用桌面端或外部工具分离 → 导入声部 → 选择音源。这里不会自动上传音乐。', 'hint'));
    const guideActions = node('div', '', 'audio-source-actions'); guideActions.append(this.button('使用指南', () => showAudioSeparationGuide(desktop)));
    if (globalThis.rpenAudioStorage?.version === 1) {
      const clear = this.button('清理音频缓存…', async () => { await clearAudioCaches(this.notify); await this.cacheReset; }); clear.disabled = this.configuring || sources.busy || this.onsetPanel?.configuring || this.onsetPanel?.onsets.busy;
      guideActions.append(this.button('模型与缓存位置…', () => showAudioStorage(this.notify)), clear);
    }
    if (desktop) {
      this.environmentStatus = node('p', this.configuring ? '正在准备或检查…' : this.environmentInfo?.ready ? '本机环境已就绪' : this.environmentInfo ? '本机环境尚未就绪' : '打开页面后自动检查本机环境', 'hint'); this.environmentStatus.setAttribute('role', 'status'); guide.append(this.environmentStatus);
      const install = this.button(this.configuring ? '正在准备…' : this.environmentInfo?.ready ? '重新准备分离环境' : '一键准备分离环境', () => this.environment('install')); install.disabled = this.configuring || sources.busy || this.environmentInfo?.autoInstallSupported === false; guideActions.prepend(install);
      if (this.environmentInfo?.autoInstallSupported === false) guide.append(node('p', this.environmentInfo.setup?.message ?? '此平台请使用已有环境或导入外部分离结果。', 'hint'));
      if (this.configuring) guideActions.append(this.button('取消准备', () => sources.separator.call('cancel', 'environment')));
    }
    guide.append(guideActions);
    const list = node('div', '', 'audio-source-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', '播放与分析音源');
    const selectedCount = entries.filter(entry => entry.selected).length;
    for (const entry of entries) {
      const row = node('div', '', 'audio-source-row'), label = node('label', '', 'audio-source-choice'), checkbox = node('input'), swatch = node('span', '', 'audio-source-color'), name = node('span', entry.name, 'audio-source-name');
      checkbox.type = 'checkbox'; checkbox.checked = entry.selected; checkbox.dataset.audioSource = entry.id; checkbox.setAttribute('aria-label', entry.name); checkbox.disabled = entry.selected && selectedCount === 1; checkbox.onchange = () => this.action(() => sources.setSelected(entry.id, checkbox.checked));
      swatch.style.backgroundColor = entry.color; swatch.setAttribute('aria-hidden', 'true'); label.append(checkbox, swatch, name); row.append(label);
      if (entry.kind !== 'original') {
        const manage = node('div', '', 'audio-source-row-actions'), exportButton = this.button('导出', async () => { const source = await sources.resolve(entry.id); download(await pcmWave(source.buffer), (source.stem ?? source.name.replace(/\.[^.]+$/, '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') + '.wav'); }), remove = this.button('移除', () => sources.remove(entry.id));
        exportButton.setAttribute('aria-label', '导出声部 ' + entry.name); remove.setAttribute('aria-label', '移除声部 ' + entry.name); manage.append(exportButton, remove); row.append(manage);
      }
      list.append(row);
    }
    this.host.append(list, node('p', sources.selecting ? '正在切换播放音源…' : '勾选的音源会同时播放，并以不同颜色并排显示波形或频谱。至少保留一项；仅本次打开谱面有效。', 'hint'));
    const actions = node('div', '', 'audio-source-actions');
    actions.append(this.button('导入声部', () => file.click())); this.host.append(actions);
    const file = node('input'); file.type = 'file'; file.accept = 'audio/*,.wav,.flac,.mp3,.ogg,.m4a'; file.multiple = true; file.hidden = true;
    file.onchange = () => this.action(async () => { for (const entry of file.files) await sources.import(await entry.arrayBuffer(), entry.name); }); this.host.append(file);
    this.host.append(node('p', '所有声部从原音乐开头对齐，共用谱面延迟。播放、变速和保调使用勾选音源的混合；原音乐和谱面文件保持不变。', 'hint'));
    this.host.append(guide);
    const options = node('details'); options.open = this.expanded ?? false; options.ontoggle = () => { this.expanded = options.open; }; options.append(node('summary', '分离选项与高级环境设置'));
    const modelLabel = node('label', '分离模型', 'field'), model = node('select'); model.setAttribute('aria-label', '声部分离模型'); model.replaceChildren(...SEPARATION_MODELS.map(entry => new Option(entry.name, entry.id))); model.value = SEPARATION_MODELS.some(entry => entry.id === this.options.model) ? this.options.model : 'htdemucs'; model.onchange = () => { this.options.model = model.value; this.saveOptions(); }; modelLabel.append(model); options.append(modelLabel);
    const deviceLabel = node('label', '计算设备', 'field'), device = node('select'); device.setAttribute('aria-label', '声部分离计算设备'); device.replaceChildren(...[['auto', '自动'], ['cpu', 'CPU'], ['cuda', 'NVIDIA CUDA']].map(([value, text]) => new Option(text, value))); device.value = ['auto', 'cpu', 'cuda'].includes(this.options.device) ? this.options.device : 'auto'; device.onchange = () => { this.options.device = device.value; this.saveOptions(); }; deviceLabel.append(device); options.append(deviceLabel);
    if (sources.separator.bridge) {
      const environment = node('div', '', 'audio-source-actions');
      for (const [label, action] of [['重新检测', 'probe'], ['选择已有环境', 'choosePython'], ['用已有 Python 安装', 'installManual']]) { const control = this.button(label, () => this.environment(action)); control.disabled = this.configuring || sources.busy; environment.append(control); }
      options.append(environment);
      if (this.environmentInfo?.pythonPath) options.append(node('p', this.environmentInfo.pythonPath, 'hint audio-separation-status'));
    } else options.append(node('p', '网页端请导入外部工具分离的声部；桌面端可直接使用本机 Demucs。', 'hint'));
    options.append(node('p', '四声部：人声、鼓、贝斯、其他。六声部另含吉他与钢琴，可能串音，不能保证区分任意配器。首次分离会下载模型，音频不上传。模型和结果独立缓存，不打包进谱面。', 'hint')); this.host.append(options);
    this.message = node('p', this.statusText ?? '', 'hint audio-separation-status'); this.message.setAttribute('role', 'status'); this.host.append(this.message);
    if (this.installLog?.length) { const logs = node('details'); logs.append(node('summary', '安装详情')); this.logOutput = node('pre', this.installLog.join('\n'), 'audio-separation-log'); logs.append(this.logOutput); this.host.append(logs); } else this.logOutput = null;
    const controls = node('div', '', 'audio-source-actions'); this.separateButton = this.button(sources.busy ? '取消分离' : '分离当前音乐', async () => {
      if (sources.busy) { sources.controller.abort(); return; }
      if (!this.environmentInfo?.ready) { await this.environment('probe'); if (!this.environmentInfo?.ready) { this.statusText = '请先点击上方“一键准备分离环境”。已有环境可在高级设置中选择。'; return; } }
      const result = await sources.separate({ model: model.value, device: device.value }); this.statusText = `已分离 ${result.sources.length} 个声部，请在“分析音源”中选择需要的声部。`;
    }); this.separateButton.disabled = !sources.separator.bridge || !sources.original;
    this.separateButton.disabled ||= this.configuring;
    controls.append(this.separateButton); if (sources.separator.bridge) controls.append(this.button('清理分离结果缓存', async () => { if (!confirm('清理本机分离结果缓存？模型保留，原音乐和谱面不变。')) return; await sources.select('original'); await sources.separator.call('clear'); for (const entry of sources.list()) if (entry.kind === 'separated') await sources.remove(entry.id); this.notify('分离结果缓存已清理', 'success'); })); this.host.append(controls); this.progress();
  }
  progress() {
    const value = this.sources.progress; if (!value || !this.message) return;
    this.message.textContent = value.stage === 'separating' ? `正在分离声部${value.frames > 0 ? ` · 片段位置 ${(value.segment / value.frames * 100).toFixed(0)}%` : ''}` : value.message || '正在运行分离工具…';
  }
}
