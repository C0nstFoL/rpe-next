import { analyzeAgentAudio } from '../core/agent-audio.mjs';
import { ONSET_DETECTORS, selectOnsetPeaks, estimateOnsetBpms } from '../core/audio-onsets.mjs';
import { checkAgentSignal } from '../core/agent-commands.mjs';
import { LocalOnsetDetector } from '../platform/audio-onsets.mjs';
import { LocalAudioMapper } from '../platform/audio-mapper.mjs';
import { MAPPER_DEFAULTS, selectMapperPeaks, validateMapperSettings } from '../core/audio-mapper.mjs';

export class AudioOnsets extends EventTarget {
  constructor({ detector = new LocalOnsetDetector(), mapper = new LocalAudioMapper(), getTiming } = {}) { super(); this.detector = detector; this.mapper = mapper; this.getTiming = getTiming; this.options = { ...MAPPER_DEFAULTS, detector: mapper.bridge ? 'mapper' : detector.bridge ? 'ddc' : 'flux', minConfidence: detector.bridge ? .15 : .35, minGap: mapper.bridge ? .02 : .08, device: 'auto' }; this.cache = new WeakMap(); }
  changed() { this.dispatchEvent(new Event('change')); }
  configure(options) {
    const next = { ...this.options, ...options }; if (options.detector && options.detector !== this.options.detector && options.minConfidence === undefined) next.minConfidence = options.detector === 'ddc' ? .15 : .35;
    if (options.detector && options.detector !== this.options.detector && options.minGap === undefined) next.minGap = options.detector === 'mapper' ? .02 : .08;
    validateMapperSettings(next);
    if (!ONSET_DETECTORS.some(entry => entry.id === next.detector) || !Number.isFinite(next.minConfidence) || next.minConfidence < 0 || next.minConfidence > 1 || !Number.isFinite(next.minGap) || next.minGap < .02 || next.minGap > 2 || !['auto', 'cpu', 'cuda'].includes(next.device)) throw Error('采音设置无效');
    this.options = next; this.changed();
  }
  clearPreview() { this.preview = null; this.changed(); }
  cancel() { this.controller?.abort(); }
  async analyze(buffer, options, signal) {
    checkAgentSignal(signal); if (this.busy) throw Error('已有采音分析任务');
    const settings = { ...this.options, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
    if (settings.detector !== this.options.detector && options.minConfidence === undefined) settings.minConfidence = settings.detector === 'ddc' ? .15 : .35;
    if (settings.detector !== this.options.detector && options.minGap === undefined) settings.minGap = settings.detector === 'mapper' ? .02 : .08;
    if (!ONSET_DETECTORS.some(entry => entry.id === settings.detector)) throw Error('采音算法无效');
    if (settings.detector !== 'flux' && settings.focus && settings.focus !== 'all') throw Error('学习型模型使用完整频谱；请通过 source 选择所需声部，或选择 flux 算法使用频带筛选');
    if (settings.detector === 'mapper') { validateMapperSettings(settings); settings.timing = settings.useChartTiming ? options.timing ?? this.getTiming?.(settings.sourceOffset ?? 0) ?? [] : []; }
    this.controller = new AbortController(); const controller = this.controller, cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    this.busy = true; this.progress = { message: '准备采音…' }; this.changed();
    try {
      if (settings.detector === 'flux') return { ...await analyzeAgentAudio(buffer, { ...settings, signal: controller.signal }), detector: 'flux', threshold: settings.minConfidence, minGap: settings.minGap };
      let entries = this.cache.get(buffer); if (!entries) { entries = new Map(); this.cache.set(buffer, entries); }
      const key = JSON.stringify([settings.detector, settings.startSeconds, settings.endSeconds, ...(settings.detector === 'mapper' ? [settings.mapperModel, settings.mapperMode, settings.difficulty, settings.seed, settings.timing] : [])]); let raw = entries.get(key), cacheHit = Boolean(raw);
      if (!raw) { raw = await (settings.detector === 'mapper' ? this.mapper : this.detector).analyze(buffer, settings, controller.signal, value => { this.progress = value; this.dispatchEvent(new Event('progress')); }); checkAgentSignal(controller.signal); entries.set(key, raw); if (entries.size > 6) entries.delete(entries.keys().next().value); cacheHit = raw.cacheHit === true; }
      checkAgentSignal(controller.signal);
      if (settings.detector === 'mapper') {
        const peaks = selectMapperPeaks(raw.objects, settings);
        return { peaks, estimatedBpms: [], sampleRate: buffer.sampleRate, startSeconds: settings.startSeconds, endSeconds: settings.endSeconds, detector: 'mapper', method: 'mapperatorinator-rhythm-draft', cacheHit, model: { name: raw.model, revision: raw.modelRevision, sourceRevision: raw.sourceRevision, device: raw.device, gamemode: raw.gamemode, difficulty: raw.difficulty, seed: raw.seed, usedChartTiming: raw.usedChartTiming }, minGap: settings.minGap, statistics: { generatedObjects: raw.objects.length, selected: peaks.length, windows: raw.windows, channelMode: raw.channelMode }, caution: '这是模型根据音乐、难度和模式选择的节奏草稿；没有逐起音置信度，不能用起音门限筛选，也不代表逐声部或音高转写。相同时刻的多键会合并为一个 Tap 候选，不修改 BPM。' };
      }
      const peaks = selectOnsetPeaks(raw, settings), first = Math.max(0, Math.ceil((settings.startSeconds - raw.startSeconds) * raw.frameRate)), last = Math.min(raw.salience.length, Math.ceil((settings.endSeconds - raw.startSeconds) * raw.frameRate));
      return { peaks, estimatedBpms: estimateOnsetBpms(raw.salience.subarray(first, last), raw.frameRate), sampleRate: buffer.sampleRate, startSeconds: settings.startSeconds, endSeconds: settings.endSeconds, detector: 'ddc', method: 'ddc-onset-cnn', focus: 'all', threshold: settings.minConfidence, minGap: settings.minGap, cacheHit, model: { version: raw.version, revision: raw.revision, frameRate: raw.frameRate, device: raw.device }, statistics: { frames: last - first, selected: peaks.length, channelMode: raw.channelMode }, caution: '模型给出的是起音候选与显著性分数，不是音高转写、人工采音或校准后的正确概率；分离声部也可能串音。BPM仅为候选估计。' };
    } finally { signal?.removeEventListener('abort', cancel); this.busy = false; this.progress = null; this.controller = null; this.changed(); }
  }
}
