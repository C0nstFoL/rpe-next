import { showDialog } from './dialog.mjs';
import { audioStorageCall } from '../platform/audio-storage.mjs';

const node = (tag, text = '', className = '') => { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; };

export async function clearAudioCaches(notify = () => {}, bridge = globalThis.rpenAudioStorage) {
  const result = await audioStorageCall('clear', undefined, bridge);
  if (result) notify(result.warnings.length ? '音频缓存已清理，部分文件保留，请查看目录' : `全部谱面的音频缓存已清理，释放 ${(result.bytes / 1024 ** 2).toFixed(1)} MiB`, result.warnings.length ? 'warning' : 'success');
  return result;
}

export async function showAudioStorage(notify = () => {}, bridge = globalThis.rpenAudioStorage) {
  if (bridge?.version !== 1) return;
  const content = showDialog('音频模型与缓存', '查看声部分离、起音检测和 AI 节奏生成的数据位置，或迁移至其他磁盘。');
  const host = node('div', '', 'audio-storage-panel'); content.append(host);
  const modal = document.querySelector('#modal'); let state, working = false, closed = false;
  const message = node('p', '正在读取目录…', 'hint audio-storage-message'), progress = node('progress'); progress.hidden = true;
  const call = (action, options) => audioStorageCall(action, options, bridge);
  const failed = error => { message.textContent = error.message; notify(error.message, 'error'); };
  const removeProgress = bridge.onProgress?.(value => {
    if (closed) return;
    message.textContent = value.message;
    progress.hidden = false;
    if (value.total > 0) { progress.max = value.total; progress.value = value.copied ?? 0; message.textContent += ` ${((value.copied ?? 0) / value.total * 100).toFixed(0)}%`; }
    else progress.removeAttribute('value');
    if (!working && ['done', 'error', 'cleared'].includes(value.stage)) call('status').then(result => { state = result; progress.hidden = true; render(); }).catch(failed);
  });
  modal.addEventListener('close', () => { closed = true; removeProgress?.(); }, { once: true });
  const button = (label, task) => { const control = node('button', label); control.type = 'button'; control.disabled = working || state?.migrating || state?.cleaning || Boolean(state?.error); control.onclick = async () => { try { await task(); } catch (error) { failed(error); } }; return control; };
  const render = () => {
    if (closed) return; host.replaceChildren();
    for (const tool of state?.tools ?? []) {
      const section = node('section', '', 'audio-storage-tool'); section.append(node('h3', tool.name), node('code', tool.root, 'audio-storage-path'));
      const actions = node('div', '', 'audio-source-actions');
      for (const [label, kind] of [['打开模型目录', 'models'], ['打开结果缓存', 'cache'], ['打开下载缓存', 'pip-cache'], ['打开工具目录', 'root']]) actions.append(button(label, () => call('open', { id: tool.id, kind })));
      section.append(actions); const environment = node('details'); environment.append(node('summary', '运行环境位置'), node('code', tool.runtime, 'audio-storage-path')); section.append(environment); host.append(section);
    }
    host.append(node('p', state?.needsSetup ? '首次使用前请选择存放位置。环境、模型可能占用数 GB 至数十 GB，结果和下载缓存也会持续增长，建议选择空间充足的非系统盘。新安装的环境将使用所选位置。' : '迁移包含模型、结果、下载和临时缓存，后续处理也使用新目录。已有 Python 运行环境保留原位；退出谱面或更新程序后仍记住新位置。', 'hint'));
    if (state?.error) host.append(node('p', state.error, 'audio-storage-message'));
    for (const warning of state?.warnings ?? []) host.append(node('p', warning, 'hint audio-storage-message'));
    host.append(progress, message);
    const actions = node('div', '', 'audio-source-actions');
    actions.append(button(working ? '正在处理…' : state?.needsSetup ? '选择存放位置…' : '迁移模型与缓存…', async () => {
      working = true; message.textContent = '请选择目标文件夹…'; render();
      try {
        const initial = state.needsSetup, result = await call(initial ? 'prepare' : 'migrate');
        state = await call('status');
        if (initial && result) { message.textContent = '音频工具存放位置已设置。'; notify(message.textContent, 'success'); }
        else if (result) { message.textContent = '迁移完成，共 ' + (result.bytes / 1024 ** 3).toFixed(2) + ' GiB。'; notify(result.warnings.length ? '音频模型与缓存已迁移，部分原缓存保留，请查看详情' : '音频模型与缓存已迁移', result.warnings.length ? 'warning' : 'success'); }
        else message.textContent = initial ? '已取消位置选择，未启动音频任务。' : '已取消迁移，原位置不变。';
      } catch (error) { try { state = await call('status'); } catch {} failed(error); }
      finally { working = false; progress.hidden = true; render(); }
    }), button('清理全部音频缓存…', async () => {
      working = true; render();
      try { const result = await clearAudioCaches(notify, bridge); if (result) message.textContent = result.warnings.length ? '部分缓存文件保留：\n' + result.warnings.join('\n') : '全部谱面的音频缓存已清理。'; state = await call('status'); }
      catch (error) { failed(error); }
      finally { working = false; progress.hidden = true; render(); }
    })); host.append(actions);
  };
  host.append(message);
  try { state = await call('status'); message.textContent = state.migrating ? '音频模型与缓存正在迁移，请等待完成。' : ''; render(); } catch (error) { failed(error); }
}
