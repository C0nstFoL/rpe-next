import { ONSET_DETECTORS } from '../core/audio-onsets.mjs';
import { localPreferences } from '../platform/local-preferences.mjs';
import { MAPPER_MODELS } from '../core/audio-mapper.mjs';

const node = (tag, text = '', className = '') => { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; };
const preferenceKey = 'rpe-next-audio-onsets-v1';

export class AudioOnsetsPanel {
  constructor(onsets, sources, notify) {
    this.onsets = onsets; this.sources = sources; this.notify = notify; this.host = node('div', '', 'audio-onsets-panel');
    try { const options = JSON.parse(localPreferences.getItem(preferenceKey) ?? '{}'); if (options.detector === 'mapper' && !onsets.mapper.bridge || options.detector === 'ddc' && !onsets.detector.bridge) options.detector = 'flux'; onsets.configure(options); } catch {}
    onsets.addEventListener('change', () => this.render()); onsets.addEventListener('progress', () => this.progress());
    for (const backend of [onsets.detector, onsets.mapper]) backend.bridge?.onProgress(value => { if (value.id === 'environment' && this.configuring) { this.statusText = value.message ?? '安装采音环境…'; this.progress(); } }); this.render();
  }
  button(label, task) { const button = node('button', label); button.type = 'button'; button.onclick = async () => { try { await task(); } catch (error) { this.statusText = error.message; this.notify(error.message, error.name === 'AbortError' ? 'warning' : 'error'); } this.render(); }; return button; }
  async environment(action) {
    if (this.configuring) return; this.configuring = true; this.statusText = '检查本机采音环境…'; this.render();
    try { const backend = this.onsets.options.detector === 'mapper' ? this.onsets.mapper : this.onsets.detector, info = await backend.call(action); if (info) this.statusText = info.ready ? `${info.engine === 'mapper' ? 'Mapperatorinator · PyTorch ' + info.torch : 'DDC ' + info.version} · ${info.cuda ? 'CUDA可用' : 'CPU'}\n${info.pythonPath}` : info.message; }
    finally { this.configuring = false; this.render(); }
  }
  setting(name, value) { this.onsets.configure({ [name]: value }); localPreferences.setItem(preferenceKey, JSON.stringify(this.onsets.options)); }
  async analyze() {
    if (this.onsets.busy) { this.onsets.cancel(); return; }
    const entry = await this.sources.resolveForAnalysis(), revision = this.sources.revision, offset = 0, selection = this.sources.selectedIds.join('\0');
    const current = Number(this.sources.getAudio().time) || 0, end = Math.min(offset + entry.buffer.duration, current + 10);
    if (!(end > current)) throw Error('播放头不在此音源覆盖范围内');
    const range = this.sources.range(entry, current, end), options = this.onsets.options;
    const result = await this.onsets.analyze(entry.buffer, { ...range, sourceOffset: offset });
    if (revision !== this.sources.revision || !this.sources.isCurrent(entry)) throw Error('音源已改变，旧分析结果未显示');
    this.onsets.preview = { ...result, buffer: entry.buffer, source: entry.id, selection, sourceRevision: revision, offsetSeconds: 0 }; this.onsets.changed();
    this.statusText = `${result.peaks.length} 个${options.detector === 'mapper' ? '节奏落点' : '起音候选'} · ${current.toFixed(2)}–${end.toFixed(2)}s · ${options.detector === 'mapper' ? 'Mapperatorinator ' + result.model.name : options.detector === 'ddc' ? 'DDC' : '频谱起音'}，仅预览，不写入谱面`; this.render();
  }
  render() {
    const onsets = this.onsets, isMapper = onsets.options.detector === 'mapper', backend = isMapper ? onsets.mapper : onsets.detector; this.host.replaceChildren(); this.host.append(node('h3', '采音与节奏生成'));
    const algorithm = node('label', '采音方式', 'field'), select = node('select'); select.setAttribute('aria-label', '采音检测算法'); select.replaceChildren(...ONSET_DETECTORS.map(entry => new Option(entry.name, entry.id))); select.value = onsets.options.detector; select.disabled = onsets.busy || this.configuring; select.onchange = () => this.setting('detector', select.value); algorithm.append(select); this.host.append(algorithm);
    if (isMapper) {
      for (const [name, title, choices] of [['mapperModel', '生成模型', MAPPER_MODELS.map(model => [model.id, model.name])], ['mapperMode', '参考模式', [[3, '四键节奏'], [0, '点击节奏']]]]) {
        const label = node('label', title, 'field'), input = node('select'); input.setAttribute('aria-label', title); input.replaceChildren(...choices.map(([value, text]) => new Option(text, value))); input.value = onsets.options[name]; input.disabled = onsets.busy || this.configuring; input.onchange = () => this.setting(name, name === 'mapperMode' ? Number(input.value) : input.value); label.append(input); this.host.append(label);
      }
      for (const [name, title, min, max, step] of [['difficulty', '参考难度（osu!星级）', .1, 15, .1], ['seed', '随机种子', 0, 0xffffffff, 1]]) {
        const label = node('label', title, 'field'), input = node('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = onsets.options[name]; input.setAttribute('aria-label', title); input.disabled = onsets.busy; input.onchange = () => { try { this.setting(name, Number(input.value)); } catch (error) { this.notify(error.message, 'error'); this.render(); } }; label.append(input); this.host.append(label);
      }
      const label = node('label', '参考谱面 BPM', 'field'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = onsets.options.useChartTiming; checkbox.disabled = onsets.busy; checkbox.setAttribute('aria-label', '参考谱面 BPM'); checkbox.onchange = () => this.setting('useChartTiming', checkbox.checked); label.append(checkbox); this.host.append(label);
    }
    for (const [name, text, min, max, step] of [['minConfidence', '起音门限', 0, 1, .01], ['minGap', '最小间隔（秒）', .02, 2, .01]]) {
      if (isMapper && name === 'minConfidence') continue;
      const label = node('label', text, 'field'), input = node('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = onsets.options[name]; input.setAttribute('aria-label', text); input.disabled = onsets.busy; input.onchange = () => { try { this.setting(name, Number(input.value)); } catch (error) { this.notify(error.message, 'error'); this.render(); } }; label.append(input); this.host.append(label);
    }
    this.host.append(node('p', isMapper ? '根据音乐和参考难度生成节奏草稿，建议先用原音乐。相同时刻的多键合并为一个落点；不沿用 osu! 坐标。BPM 未确认时可取消参考，谱面 BPM 保持不变。V32 为完整模型，Mini 更轻。' : '门限越低，候选越密。配器采音请先选择声部。DDC 为学习型起音模型，不转写音高；候选仍需检查。', 'hint'));
    const environment = node('details'); environment.open = this.expanded ?? false; environment.ontoggle = () => { this.expanded = environment.open; }; environment.append(node('summary', isMapper ? 'Mapperatorinator 本机环境' : 'DDC 本机环境'));
    if (backend.bridge) {
      const controls = node('div', '', 'audio-source-actions');
      for (const [label, action] of [['检测环境', 'probe'], ['选择已有环境', 'choosePython'], ['安装独立环境', 'install']]) { const button = this.button(label, () => this.environment(action)); button.disabled = onsets.busy || this.configuring; controls.append(button); }
      if (this.configuring) controls.append(this.button('取消安装', () => backend.call('cancel', 'environment'))); environment.append(controls);
      const deviceLabel = node('label', '计算设备', 'field'), device = node('select'); device.setAttribute('aria-label', '采音计算设备'); device.replaceChildren(...[['auto', '自动'], ['cpu', 'CPU'], ['cuda', 'NVIDIA CUDA']].map(([value, label]) => new Option(label, value))); device.value = onsets.options.device; device.disabled = onsets.busy; device.onchange = () => this.setting('device', device.value); deviceLabel.append(device); environment.append(deviceLabel);
      environment.append(this.button('清理检测缓存', async () => { if (!confirm('清理当前模型的本机结果缓存？模型和原音乐保留。')) return; await backend.call('clear'); onsets.cache = new WeakMap(); onsets.clearPreview(); this.statusText = '检测缓存已清理'; }));
    } else environment.append(node('p', '学习型模型目前需要桌面端本机环境。网页端仍可用频谱起音算法。', 'hint'));
    this.host.append(environment); const controls = node('div', '', 'audio-source-actions'), analyze = this.button(onsets.busy ? '取消采音' : '预览当前起 10 秒', () => this.analyze()); analyze.disabled = this.configuring || !this.sources.original; controls.append(analyze, this.button('清除候选', () => { onsets.clearPreview(); this.statusText = ''; })); this.host.append(controls);
    this.message = node('p', '', 'hint audio-onsets-status'); this.message.setAttribute('role', 'status'); this.host.append(this.message); this.progress();
  }
  progress() { if (this.message) this.message.textContent = this.onsets.progress?.message ?? this.statusText ?? ''; }
}
