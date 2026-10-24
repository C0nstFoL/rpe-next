import { readFile } from 'node:fs/promises';

export async function smokeAudio(contents, fixture) {
  const bytes = new Uint8Array(await readFile(fixture));
  return contents.executeJavaScript(`(async () => {
    const check = (value, message) => { if (!value) throw Error(message); };
    const until = async condition => { const end = performance.now() + 15000; while (!await condition()) { if (performance.now() > end) throw Error('Audio test startup timeout'); await new Promise(resolve => setTimeout(resolve, 30)); } };
    await until(() => window.rpenMods?.editor); document.querySelector('#new').click();
    const editor = window.rpenMods.editor, commands = editor.agent.commands, checks = [], metrics = [], originalChart = editor.chart;
    editor.audioOnsets.configure({ detector: 'ddc' });
    const call = async (name, args, options = {}) => { const value = await commands.execute(name, args, { permission: 'full', ...options }); if (!value.ok) throw Error(JSON.stringify(value)); return value.result; };
    await editor.audio.load(Uint8Array.from(${JSON.stringify([...bytes])}).buffer, 'separation-fixture.wav'); editor.audioAnalysis.setBuffer(editor.audio.buffer);
    const original = editor.audio.buffer, duration = editor.audio.duration;
    document.querySelector('#audio-analysis-tool').click();
    await until(() => !editor.audioAnalysis.sourcePanel.configuring);
    check(Boolean(document.querySelector('[aria-label="播放与分析音源"]')), 'Analysis source checkboxes missing');
    check([...document.querySelectorAll('.audio-source-guide button')].some(button => button.textContent === '一键准备分离环境' || button.textContent === '重新准备分离环境'), 'First-use setup entry missing');
    [...document.querySelectorAll('.audio-source-guide button')].find(button => button.textContent === '使用指南').click();
    check(document.querySelector('#modal').open && document.querySelector('#modal-content').textContent.includes('无需先安装 Python'), 'Desktop step-by-step guide missing'); document.querySelector('#modal').close();
    const status = await call('audio_sources', { status: true }); check(status.separation.ready && status.separation.demucs === '4.1.0', 'Separation environment unavailable: ' + JSON.stringify(status.separation));
    const detectorStatus = await call('audio_detector', { status: true }); check(detectorStatus.environment.ready && detectorStatus.environment.engine === 'ddc', 'DDC environment unavailable: ' + JSON.stringify(detectorStatus));
    for (const model of ['htdemucs', 'htdemucs_6s']) {
      const started = performance.now(), separated = await call('audio_separate', { model, device: 'cpu', shifts: 0 });
      check(separated.sources.length === (model === 'htdemucs' ? 4 : 6), 'Stem count mismatch');
      const source = model + '/drums'; await call('audio_source', { action: 'select', source });
      const stem = await editor.audioSources.resolve(source); check(Math.abs(stem.buffer.duration - duration) <= 1 / original.sampleRate, 'Stem duration changed');
      await until(() => editor.audioAnalysis.sourceBuffer === stem.buffer);
      check([...document.querySelectorAll('[data-audio-source]')].find(checkbox => checkbox.dataset.audioSource === source)?.checked, 'Panel selection mismatch');
      const analyzed = await call('audio_analyze', { source, line: 0, start: 0, end: 15, minConfidence: .1 }); check(analyzed.source.id === source && analyzed.peaks.length > 0 && analyzed.method === 'ddc-onset-cnn' && analyzed.model.frameRate === 100, 'Separated DDC onset detection empty');
      const sparse = await call('audio_analyze', { source, line: 0, start: 0, end: 15, minConfidence: .6 }); check(sparse.cacheHit && sparse.peaks.length <= analyzed.peaks.length, 'Threshold change failed to reuse raw predictions');
      const legacy = await call('audio_analyze', { source, line: 0, start: 0, end: 15, detector: 'flux', minConfidence: .1 }); check(legacy.method === 'local-multiband-spectral-flux', 'Legacy comparison unavailable');
      const generated = await call('audio_taps', { revision: (await call('editor_context', {})).revision, source, line: 0, start: 0, end: 15, minConfidence: .1, division: 8 });
      check(generated.added > 0, 'No separated taps generated'); await call('history', { action: 'undo' }); check(editor.chart === originalChart, 'Tap undo changed original chart');
      check(editor.audio.buffer === original && editor.audio.duration === duration, 'Separation replaced original music');
      metrics.push({ model, ms: performance.now() - started, stems: separated.sources.length, onsets: analyzed.peaks.length, legacyOnsets: legacy.peaks.length, taps: generated.added });
    }
    checks.push('real desktop four/six-source separation, source selection, waveform data, stem onset analysis and Tap generation/undo pass with original music unchanged');
    for (const skin of ['default', 'inkline']) {
      await editor.editorSkins.use(skin); document.querySelector('#audio-analysis-tool').click();
      for (const details of document.querySelectorAll('.audio-sources-panel details')) details.open = true;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const host = document.querySelector('.audio-sources-panel'), bounds = host.getBoundingClientRect();
      check(host.scrollWidth <= host.clientWidth + 1, 'Audio sources panel overflows in ' + skin);
      for (const button of host.querySelectorAll('button')) { const rectangle = button.getBoundingClientRect(); check(rectangle.right <= bounds.right + 1 && rectangle.left >= bounds.left - 1 && button.scrollWidth <= button.clientWidth + 1, 'Audio control overflows in ' + skin); }
    }
    checks.push('source controls and long model labels remain contained in default and Inkline skins');
    const algorithm = document.querySelector('[aria-label="采音检测算法"]'); check(algorithm?.value === 'ddc', 'Detector selector missing');
    algorithm.value = 'flux'; algorithm.dispatchEvent(new Event('change')); check(editor.audioOnsets.options.detector === 'flux', 'Detector selection not applied');
    const restored = document.querySelector('[aria-label="采音检测算法"]'); restored.value = 'ddc'; restored.dispatchEvent(new Event('change')); check(editor.audioOnsets.options.minConfidence === .15, 'Detector threshold default incorrect');
    editor.seek(0, { music: true }); [...document.querySelectorAll('.audio-onsets-panel button')].find(button => button.textContent.startsWith('预览当前起')).click();
    await until(() => editor.audioOnsets.preview && !editor.audioOnsets.busy);
    check(editor.audioOnsets.preview.peaks.length > 0 && editor.audioAnalysis.enabled, 'Read-only onset preview missing');
    editor.audioAnalysis.draw(Number(editor.chart.META.offset ?? 0) / 1000); check(editor.chart === originalChart, 'Onset preview changed chart');
    checks.push('DDC/flux switching, threshold caching and read-only candidate overlay work in the real renderer');
    const drum = await editor.audioSources.resolve('htdemucs/drums'), wave = await (await import('/src/platform/pcm-wave.mjs')).pcmWave(drum.buffer);
    const imported = await editor.audioSources.import(await wave.arrayBuffer(), 'UVR imported test'); await editor.audioSources.select(imported); await until(() => editor.audioAnalysis.sourceBuffer === editor.audioSources.entry(imported).buffer);
    check(editor.audioAnalysis.sourceOffset === 0 && editor.audio.playbackBuffer === editor.audioSources.entry(imported).buffer, 'Imported stem did not share timeline/playback');
    check(!document.querySelector('[aria-label="声部起点（音频秒）"]') && ![...document.querySelectorAll('.audio-sources-panel button')].some(button => /试听/.test(button.textContent)), 'Obsolete audition/offset controls remain');
    await call('audio_source', { action: 'select', sources: ['htdemucs/drums', 'htdemucs/vocals'] }); await until(() => editor.audioAnalysis.layers.length === 2);
    const mixed = await editor.audioSources.resolveSelection(); check(mixed.buffer === editor.audio.playbackBuffer && mixed.buffer !== original && mixed.buffer.duration === duration, 'Multistem playback mix missing'); check(new Set(editor.audioAnalysis.layers.map(layer => layer.color)).size === 2, 'Waveform stem colors not distinct');
    for (const mode of ['waveform', 'spectrum']) { editor.audioAnalysis.mode = mode; editor.audioAnalysis.draw(0); }
    editor.seek(1, { music: true }); editor.audio.setRate(.75); editor.audio.setPreservePitch(true); await editor.audio.play(); await new Promise(resolve => setTimeout(resolve, 250)); const time = editor.audio.time; check(time > 1 && editor.audio.usesMedia && editor.audio.playbackMedia.playbackRate === .75, 'Stem rate/pitch playback failed'); editor.audio.pause();
    const paused = editor.audio.time; await editor.audioSources.select('htdemucs/bass'); check(Math.abs(editor.audio.time - paused) < .002 && editor.audio.rate === .75, 'Selection moved playback clock'); await editor.audio.play(); await new Promise(resolve => setTimeout(resolve, 100)); editor.audio.pause();
    const activeCheckbox = [...document.querySelectorAll('[data-audio-source]')].find(checkbox => checkbox.dataset.audioSource === 'htdemucs/bass'); check(activeCheckbox.disabled, 'Last selected source can be unchecked');
    await editor.audio.play(); await until(() => editor.audio.clockReady); const beforeSwap = editor.audio.time; await editor.audioSources.select(['htdemucs/drums', 'htdemucs/vocals']); await until(() => editor.audio.clockReady); check(editor.audio.playing && editor.audio.time >= beforeSwap && editor.audio.rate === .75 && editor.audio.playbackMedia.preservesPitch, 'Selecting during playback interrupted clock/rate/pitch'); editor.audio.pause();
    editor.audio.setRate(1); await editor.audioSources.select('original'); check(editor.audio.buffer === original && !editor.audio.playbackOverride, 'Restoring original left temporary playback');
    checks.push('multistem playback, distinct waveform/spectrum colors, preserve-pitch speed, pause/resume, minimum one selection and original restoration');
    const controller = new AbortController(), pending = editor.audioSources.separate({ model: 'htdemucs', device: 'cpu', shifts: 1 }, controller.signal); setTimeout(() => controller.abort(), 200);
    try { await pending; throw Error('Cancellation did not stop separation'); } catch (error) { check(error.name === 'AbortError', 'Unexpected cancellation result: ' + error.message); }
    check(!editor.audioSources.busy, 'Cancelled task stayed busy');
    const detection = new AbortController(), detecting = editor.audioOnsets.analyze(original, { startSeconds: .15, endSeconds: 3.8 }, detection.signal); setTimeout(() => detection.abort(), 50);
    try { await detecting; throw Error('Onset cancellation did not stop'); } catch (error) { check(error.name === 'AbortError', 'Unexpected onset cancellation result: ' + error.message); }
    check(!editor.audioOnsets.busy, 'Cancelled onset task stayed busy');
    await editor.audioSources.select(imported); document.querySelector('#library').click(); await until(() => !document.querySelector('#home').hidden); check(editor.audioSources.selected === 'original' && !editor.audio.playbackOverride, 'Closing chart preserved temporary stem'); document.querySelector('#resume-editor').click(); await until(() => document.querySelector('#home').hidden); check(editor.audioSources.selected === 'original', 'Reentering chart did not default to original');
    editor.audio.clear(); editor.audioAnalysis.setBuffer(null); check(editor.audioSources.list().length === 1 && editor.audioSources.selected === 'original', 'Old stems survived music replacement');
    checks.push('cancellation stops native work and replacing music invalidates old separated/imported stems');
    return { checks, metrics };
  })()`);
}

export async function smokeMapper(contents, fixture) {
  const bytes = new Uint8Array(await readFile(fixture));
  return contents.executeJavaScript(`(async () => {
    const check = (value, message) => { if (!value) throw Error(message); };
    const until = async condition => { const end = performance.now() + 120000; while (!await condition()) { if (performance.now() > end) throw Error('Mapper test timeout'); await new Promise(resolve => setTimeout(resolve, 50)); } };
    await until(() => window.rpenMods?.editor); document.querySelector('#new').click();
    const editor = window.rpenMods.editor, checks = [], metrics = [], call = async (name, args, options = {}) => { const value = await editor.agent.commands.execute(name, args, { permission: 'full', ...options }); if (!value.ok) throw Error(JSON.stringify(value)); return value.result; };
    await editor.audio.load(Uint8Array.from(${JSON.stringify([...bytes])}).buffer, 'mapper-fixture.wav'); editor.audioAnalysis.setBuffer(editor.audio.buffer);
    await call('bpm_set', { revision: (await call('editor_context', {})).revision, entries: [{ beat: 0, bpm: 150 }] });
    const original = editor.audio.buffer, originalChart = editor.chart;
    document.querySelector('#audio-analysis-tool').click();
    check(document.querySelector('[aria-label="采音检测算法"]').value === 'mapper', 'New desktop default is not Mapperatorinator');
    const status = await call('audio_detector', { status: true }); check(status.environment?.ready && status.environment.cuda, 'Mapper environment is unavailable: ' + JSON.stringify(status));
    check(!document.querySelector('[aria-label="起音门限"]'), 'Mapper incorrectly exposes onset probability threshold');
    for (const model of ['v32', 'v32-mini']) {
      const started = performance.now(), args = { detector: 'mapper', mapperModel: model, mapperMode: 3, difficulty: 5, seed: 0, source: 'original', line: 0, start: 0, end: 19, useChartTiming: true };
      const analyzed = await call('audio_analyze', args); check(analyzed.method === 'mapperatorinator-rhythm-draft' && analyzed.peaks.length > 0, 'No rhythm draft from ' + model);
      check(analyzed.peaks.every(peak => peak.seconds >= 0 && peak.seconds < 7.6 && !('confidence' in peak)), 'Invalid model timestamps or fabricated confidence');
      const cached = await call('audio_analyze', args); check(cached.cacheHit && JSON.stringify(cached.peaks) === JSON.stringify(analyzed.peaks), 'Rhythm cache did not reuse output');
      const generated = await call('audio_taps', { ...args, revision: (await call('editor_context', {})).revision, division: 16, quantization: 'none' });
      check(generated.added === analyzed.peaks.length && editor.session.notes.every(note => note.type === 1), 'Rhythm to Tap mismatch');
      await call('history', { action: 'undo' }); check(editor.chart === originalChart, 'Rhythm generation undo failed'); await call('history', { action: 'redo' }); check(editor.session.notes.length === generated.added, 'Rhythm redo failed'); await call('history', { action: 'undo' });
      metrics.push({ model, ms: performance.now() - started, times: analyzed.peaks.length, notes: generated.added, device: analyzed.model.device });
    }
    checks.push('real V32 and Mini inference, chart timing, read-only analysis, cache reuse and atomic Tap undo/redo');
    for (const skin of ['default', 'inkline']) {
      await editor.editorSkins.use(skin); document.querySelector('#audio-analysis-tool').click();
      for (const details of document.querySelectorAll('.audio-sources-panel details')) details.open = true;
      await new Promise(resolve => requestAnimationFrame(resolve)); const host = document.querySelector('.audio-sources-panel'), bounds = host.getBoundingClientRect();
      check(host.scrollWidth <= host.clientWidth + 1, 'Mapper panel overflows in ' + skin);
      for (const control of host.querySelectorAll('button,input,select')) { const rectangle = control.getBoundingClientRect(); if (!rectangle.width) continue; check(rectangle.right <= bounds.right + 1 && rectangle.left >= bounds.left - 1, 'Mapper control out of panel in ' + skin); }
    }
    const model = document.querySelector('[aria-label="生成模型"]'); model.value = 'v32-mini'; model.dispatchEvent(new Event('change'));
    const difficulty = document.querySelector('[aria-label="参考难度（osu!星级）"]'); difficulty.value = '3'; difficulty.dispatchEvent(new Event('change')); check(editor.audioOnsets.options.difficulty === 3, 'Difficulty setting failed');
    editor.seek(0, { music: true }); [...document.querySelectorAll('.audio-onsets-panel button')].find(button => button.textContent.startsWith('预览当前起')).click();
    await until(() => editor.audioOnsets.preview && !editor.audioOnsets.busy); check(editor.audioOnsets.preview.method === 'mapperatorinator-rhythm-draft' && editor.audioAnalysis.enabled, 'Manual rhythm preview missing');
    editor.audioAnalysis.draw(Number(editor.chart.META.offset ?? 0) / 1000); check(editor.chart === originalChart && editor.audio.buffer === original, 'Preview changed chart or music');
    checks.push('default/Inkline layout, visible model controls, difficulty selection and candidate overlay');
    const controller = new AbortController(), pending = editor.audioOnsets.analyze(original, { detector: 'mapper', startSeconds: .2, endSeconds: 3.8, seed: 77 }, controller.signal); setTimeout(() => controller.abort(), 200);
    try { await pending; throw Error('Mapper did not cancel'); } catch (error) { check(error.name === 'AbortError', 'Unexpected cancellation: ' + error.message); }
    check(!editor.audioOnsets.busy, 'Cancelled Mapper remained busy');
    editor.audio.clear(); editor.audioAnalysis.setBuffer(null); check(!editor.audioOnsets.preview, 'Old rhythm preview survived music replacement'); checks.push('cancellation and source replacement discard pending work and old previews');
    return { checks, metrics };
  })()`);
}
