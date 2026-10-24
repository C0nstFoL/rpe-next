import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function smokeAgentUpgrade(contents, { userData, restart = false }) {
  const stateFile = resolve(userData, 'agent-upgrade-state.json'), state = restart ? JSON.parse(await readFile(stateFile, 'utf8')) : null;
  const report = await contents.executeJavaScript(String.raw`(async () => { try {
    const check = (value, message) => { if (!value) throw Error(message); }, until = async predicate => { const end = performance.now() + 30000; while (!await predicate()) { if (performance.now() > end) throw Error('Agent upgrade timeout: ' + predicate.toString()); await new Promise(resolve => setTimeout(resolve, 20)); } };
    await until(() => window.rpenMods?.editor); const editor = window.rpenMods.editor, checks = [];
    const { AgentConversationRepository } = await import('/src/platform/agent-store.mjs');
    const saved = ${JSON.stringify(state)};
    const openProject = async projectId => { await until(() => document.querySelector('[data-project-id="' + projectId + '"]')); document.querySelector('[data-project-id="' + projectId + '"]').closest('.project-card').querySelector('.project-open').click(); await until(() => !editor.home && editor.libraryProject?.id === projectId); await editor.agent.ready; editor.agent.open(); };
    if (saved) {
      await openProject(saved.projectId); const book = await new AgentConversationRepository(editor.agentWorkspaceId).load();
      check(editor.agentWorkspaceId === saved.workspaceId, 'Workspace identity changed after restart'); check(book.records.size === 2 && book.selected === saved.secondRecord, 'Conversations or selection missing after restart');
      check(document.querySelector('#ai-panel textarea[aria-label="给 AI 的任务"]').value === '重启后的草稿', 'Draft was not restored');
      const select = document.querySelector('[aria-label="AI 对话"]'); select.value = saved.firstRecord; select.dispatchEvent(new Event('change'));
      check(document.querySelector('#ai-panel').textContent.includes('排队任务已完成'), 'History answer missing after restart');
      const original = book.records.get(saved.firstRecord); check(original.memory?.messages?.length > 0, 'Compacted memory missing');
      const trace = await new AgentConversationRepository(editor.agentWorkspaceId).trace(original.turns[0].exchanges.at(-1).id); check(trace.request.body.padding.length === 80000, 'Full exchange did not persist');
      check((await editor.agent.workspace.call('read', { path: 'reports/session.txt' })).text === 'persisted workspace', 'Desktop file did not persist');
      checks.push('application restart restores all conversations, raw requests, compressed memory, draft, context settings and desktop workspace');
      return { checks, state: saved };
    }
    document.querySelector('#new').click(); await editor.agent.ready; editor.agent.open();
    editor.agent.providers.get('deepseek').modelInfo = async () => ({ contextWindow: 1048576 });
    document.querySelector('#ai-panel .agent-heading button').click(); await until(() => document.querySelector('#ai-config[open]'));
    const config = document.querySelector('#ai-config'); check(config.querySelector('[aria-label="每任务最大模型请求轮数"]').value === '128', 'Default task request limit was not upgraded'); check(config.querySelector('[aria-label="自动压缩上下文"]').checked, 'Automatic compaction default missing'); config.querySelector('input[type=password]').value = 'rpen-upgrade-fixture-only'; config.querySelector('button[type=submit]').click(); await until(() => !config.open);
    const permission = document.querySelector('[aria-label="AI 访问权限"]'); permission.value = 'full'; permission.dispatchEvent(new Event('change'));
    editor.commit('test metadata', { ...editor.chart, META: { ...editor.chart.META, name: 'AI upgrade integration' } });
    const provider = editor.agent.providers.get('deepseek'), requests = []; let phase = 'queue', pending = false;
    const response = (request, content) => { request.onTrace?.({ response: { status: 200, body: 'data: ' + JSON.stringify({ choices: [{ message: { content } }] }) + '\n\ndata: [DONE]\n\n' } }); return { role: 'assistant', content, model: 'fixture', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }; };
    provider.complete = async request => {
      requests.push(structuredClone(request.messages)); request.onTrace?.({ request: { url: 'fixture://chat', body: { model: 'fixture', messages: structuredClone(request.messages), padding: 'x'.repeat(80000) } } });
      if (request.system.includes('将提供的编辑器对话压缩为')) return response(request, '用户完成了排队与插话测试、生成12个音符，需要保留所有编辑与文件。');
      if (phase === 'queue' && !pending) { pending = true; request.onText?.('正在处理'); return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('steered', 'AbortError')), { once: true })); }
      if (phase === 'question' && request.messages.at(-1).role !== 'tool') return { role: 'assistant', content: null, tool_calls: [{ id: 'question-call', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '请选择开始位置', choices: ['当前', '第4拍'] }) } }] };
      return response(request, phase === 'queue' ? request.messages.at(-1).content === '第二条排队任务' ? '排队任务已完成' : '插话已应用' : '问题已回答');
    };
    const input = document.querySelector('[aria-label="给 AI 的任务"]'), submit = value => { input.value = value; input.dispatchEvent(new Event('input')); input.closest('form').requestSubmit(); };
    const stopped = () => [...document.querySelectorAll('#ai-panel .agent-composer-actions button')].find(button => button.textContent === '停止').hidden;
    submit('先执行第一条任务'); await until(() => pending); await new Promise(resolve => setTimeout(resolve, 350)); check(/已运行 0\.[2-9]/.test(document.querySelector('.agent-turn-meta').textContent), 'Live task timer did not follow elapsed time'); check(!input.disabled, 'Cannot type during a task'); submit('第二条排队任务'); await until(() => document.querySelector('#ai-panel').textContent.includes('等待执行'));
    input.value = '改为只说明，不修改谱面'; input.dispatchEvent(new Event('input')); [...document.querySelectorAll('#ai-panel .agent-composer-actions button')].find(button => button.textContent === '插话').click();
    await until(() => stopped() && document.querySelector('#ai-panel').textContent.includes('排队任务已完成')); await editor.agent.flush();
    check([...document.querySelectorAll('.agent-turn > .agent-user-message > .agent-message-body')].filter(node => !node.closest('.agent-turn').hidden && node.textContent === '改为只说明，不修改谱面').length === 0, 'Steering remained duplicated at the conversation bottom');
    check([...document.querySelectorAll('.agent-work-content .agent-user-message > .agent-message-body')].filter(node => node.textContent === '改为只说明，不修改谱面').length === 1, 'Steering was not inserted into the task');
    check(/15 0\.0%/.test(document.querySelector('.agent-context-number').textContent), 'Context meter did not use latest request usage');
    const screenshot = await editor.agent.commands.execute('editor_capture', { target: 'timeline' }, { permission: 'full' }); check(screenshot.result.image.startsWith('data:image/png;base64,') && screenshot.result.width > 100, 'Timeline screenshot missing');
    const fullScreenshot = await editor.agent.commands.execute('editor_capture', { target: 'editor' }, { permission: 'full' }); check(fullScreenshot.result.redacted, 'Screenshot private region protection missing');
    const fullImage = new Image(); fullImage.src = fullScreenshot.result.image; await fullImage.decode(); const sampleCanvas = document.createElement('canvas'); sampleCanvas.width = fullImage.naturalWidth; sampleCanvas.height = fullImage.naturalHeight; const sampleContext = sampleCanvas.getContext('2d'); sampleContext.drawImage(fullImage, 0, 0); const privateBounds = document.querySelector('#ai-panel').getBoundingClientRect(); const privatePixel = sampleContext.getImageData(Math.floor((privateBounds.x + 5) * fullImage.naturalWidth / innerWidth), Math.floor((privateBounds.y + 5) * fullImage.naturalHeight / innerHeight), 1, 1).data; check(privatePixel[0] === 40 && privatePixel[1] === 51 && privatePixel[2] === 63 && privatePixel[3] === 255, 'Screenshot exposed private content');
    const controls = await editor.agent.commands.execute('ui_inspect', { query: '播放' }, { permission: 'full' }), play = controls.result.controls.find(control => control.id === 'play'); check(play, 'No play control handle');
    const controlScreenshot = await editor.agent.commands.execute('editor_capture', { target: 'control', handle: play.handle }, { permission: 'full' }); check(controlScreenshot.result.width > 10 && controlScreenshot.result.width < 300, 'Control screenshot crop failed');
    const testDialog = document.createElement('dialog'); testDialog.textContent = '截图测试窗口'; document.body.append(testDialog); testDialog.showModal(); const dialogScreenshot = await editor.agent.commands.execute('editor_capture', { target: 'dialog' }, { permission: 'full' }); check(dialogScreenshot.result.width > 50, 'Dialog screenshot missing'); testDialog.close(); testDialog.remove();
    checks.push('current context meter, in-task steering and editor/timeline screenshots work');
    check(requests.length === 3, 'Queue or steering issued wrong request count: ' + requests.length); check(requests[1].at(-1).content === '改为只说明，不修改谱面', 'Steering text missing'); check(requests[2].at(-1).content === '第二条排队任务', 'Queue context leaked or order changed');
    const ids = [...document.querySelectorAll('.agent-turn')].map(node => node.dataset.turnId); check(new Set(ids).size === ids.length, 'Duplicate turn nodes');
    document.querySelector('.agent-turn-inspect').click(); await until(() => document.querySelector('.agent-exchange-dialog[open]')); const inspect = document.querySelector('.agent-exchange-dialog');
    const requestSelect = inspect.querySelector('select'); requestSelect.value = requestSelect.options[requestSelect.options.length - 1].value; requestSelect.dispatchEvent(new Event('change')); await until(() => inspect.querySelector('textarea').value.includes('改为只说明')); check(inspect.querySelector('textarea').value.length > 80000, 'Request details truncated'); inspect.querySelector('.agent-heading button').click();
    checks.push('queue, streaming interruption, separate raw exchange inspector and non-blocking completion notices work');
    phase = 'question'; submit('发问测试'); await until(() => document.querySelector('.agent-question:not(.agent-resolved)')); check([...document.querySelectorAll('.editor-notification')].some(node => node.textContent.includes('AI 需要回答')), 'Question notification missing');
    const question = document.querySelector('.agent-question:not(.agent-resolved)'); [...question.querySelectorAll('button')].find(button => button.textContent === '当前').click(); await until(stopped);
    const ctx = await editor.agent.commands.execute('editor_context', {}, { permission: 'full' });
    const source = 'for(let scope=globalThis;scope;scope=Object.getPrototypeOf(scope))for(const name of ["fetch","indexedDB","navigator","postMessage"]){const descriptor=Object.getOwnPropertyDescriptor(scope,name);if(descriptor&&(descriptor.get||descriptor.value!==undefined))throw Error("worker authority leak");}for(let index=0;index<12;index++)chart.judgeLineList[0].notes.push(api.createNote(1,index/4,index*5));return {result:{added:12}};';
    const args = { revision: ctx.result.revision, source };
    const dry = await editor.agent.commands.execute('chart_script', { ...args, dryRun: true }, { permission: 'ask', approve: () => { throw Error('Dry run asked for approval'); } }); check(dry.result.dryRun && editor.session.notes.length === 0, 'Dry run modified the chart');
    const denied = await editor.agent.commands.execute('chart_script', args, { permission: 'ask', approve: async () => false }); check(denied.denied && editor.session.notes.length === 0, 'Rejected script applied changes');
    const applied = await editor.agent.commands.execute('chart_script', args, { permission: 'full' }); check(applied.ok && editor.session.notes.length === 12, 'Chart script failed'); editor.session.travel('undo'); check(editor.session.notes.length === 0, 'Script undo failed'); editor.session.travel('redo');
    const chart = editor.chart; await editor.agent.commands.execute('chart_script', { revision: applied.result.revision, source: 'chart.BPMList[0].bpm=0;' }, { permission: 'full' }).then(() => { throw Error('Invalid script accepted'); }, () => {}); check(editor.chart === chart, 'Invalid script changed chart');
    checks.push('real module Worker supports general scripts, dry run, approval rejection, atomic validation and undo/redo without network/storage access');
    await editor.agent.commands.execute('workspace_files', { action: 'write', path: 'reports/session.txt', text: 'persisted workspace' }, { permission: 'full' });
    const fileDenied = await editor.agent.commands.execute('workspace_files', { action: 'delete', path: 'reports/session.txt' }, { permission: 'dangerous', approve: async () => false }); check(fileDenied.denied, 'File deletion bypassed approval');
    await editor.agent.commands.execute('workspace_import_asset', { path: 'reports/session.txt', assetPath: 'reports/generated.txt' }, { permission: 'full' }); check(new TextDecoder().decode(editor.assets.get('reports/generated.txt')) === 'persisted workspace', 'File import failed');
    checks.push('native per-chart files persist, dangerous deletion is checked and binary import stays local');
    [...document.querySelectorAll('#ai-panel .agent-context button')].find(button => button.textContent === '压缩').click(); await until(() => document.querySelector('#ai-panel').textContent.includes('上下文已压缩')); await until(stopped); await editor.agent.flush();
    const workspaceId = editor.agentWorkspaceId, book = await new AgentConversationRepository(workspaceId).load(), firstRecord = book.selected; check(book.current.memory?.messages[0].content.includes('历史上下文摘要'), 'Manual compaction missing');
    [...document.querySelectorAll('.agent-conversations button')].find(button => button.textContent.includes('新对话')).click(); const secondRecord = document.querySelector('[aria-label="AI 对话"]').value;
    const context = document.querySelector('[aria-label="本对话上下文"]'); context.value = 'none'; context.dispatchEvent(new Event('change')); input.value = '重启后的草稿'; input.dispatchEvent(new Event('input'));
    await editor.save(); await editor.agent.flush(); const projectId = editor.libraryProject.id;
    document.querySelector('#library').click(); await until(() => editor.home); document.querySelector('#resume-editor').click(); await editor.agent.ready; editor.agent.open(); check(input.value === '重启后的草稿', 'Resume lost draft');
    document.querySelector('#library').click(); await until(() => editor.home); await openProject(projectId); check(document.querySelector('[aria-label="给 AI 的任务"]').value === '重启后的草稿', 'Saved project lost conversations');
    check(document.querySelector('[aria-label="本对话上下文"]').value === 'none', 'Context mode was not restored'); await editor.agent.flush();
    checks.push('saving, returning from the library and reopening retain multiple conversations, selected conversation, independent context and draft');
    return { checks, state: { projectId, workspaceId, firstRecord, secondRecord } };
  } catch(error) { return { __error: error?.stack ?? String(error) }; } })()`, true);
  if (report.__error) { await writeFile(resolve(userData, 'agent-upgrade-failure.png'), (await contents.capturePage()).toPNG()); throw Error(report.__error); }
  if (!restart) await writeFile(stateFile, JSON.stringify(report.state));
  return report;
}
