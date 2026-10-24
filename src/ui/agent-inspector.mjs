const node = (tag, value = '') => { const element = document.createElement(tag); element.textContent = value; return element; };

export function showAgentExchange(turn, read) {
  const dialog = node('dialog'); dialog.className = 'agent-exchange-dialog'; dialog.dataset.agentPrivate = 'true';
  const heading = node('div'); heading.className = 'agent-heading';
  const close = node('button', '关闭'); close.type = 'button'; close.onclick = () => dialog.close(); heading.append(node('h3', '本轮完整请求与返回'), close);
  const select = node('select'); select.setAttribute('aria-label', '选择模型请求');
  for (const [index, trace] of (turn.exchanges ?? []).entries()) { const option = node('option', `${index + 1} · ${trace.purpose === 'compaction' ? '上下文压缩' : '模型请求'} · ${trace.model} · ${trace.status}`); option.value = trace.id; select.append(option); }
  const controls = node('div'); controls.className = 'agent-exchange-controls'; const request = node('button', '请求'), response = node('button', '返回'), refresh = node('button', '刷新'), copy = node('button', '复制');
  const meta = node('p'); meta.className = 'hint'; const content = node('textarea'); content.readOnly = true; content.spellcheck = false; content.setAttribute('aria-label', '完整请求或返回内容');
  let part = 'request', generation = 0;
  const render = async () => {
    const serial = ++generation; content.value = '正在读取…';
    try {
      const trace = await read(select.value); if (serial !== generation) return;
      meta.textContent = trace ? `${trace.model} · ${trace.status} · ${((trace.durationMs ?? 0) / 1000).toFixed(2)}s · 凭据已隐藏` : '本轮还没有可读取的请求记录';
      const value = trace?.[part]; content.value = part === 'response' && typeof value?.body === 'string' ? value.body : typeof value === 'string' ? value : JSON.stringify(value ?? (part === 'response' ? '等待返回或请求尚未完成' : {}), null, 2);
      request.classList.toggle('active', part === 'request'); response.classList.toggle('active', part === 'response');
    } catch (error) { if (serial === generation) content.value = error.message; }
  };
  request.onclick = () => { part = 'request'; render(); }; response.onclick = () => { part = 'response'; render(); }; refresh.onclick = render; select.onchange = render;
  copy.onclick = async () => { try { await navigator.clipboard.writeText(content.value); meta.textContent = '已复制完整内容'; } catch { meta.textContent = '无法自动复制，可在文本框中手动全选复制'; } }; controls.append(select, request, response, refresh, copy);
  dialog.append(heading, controls, meta, content); dialog.addEventListener('close', () => { generation++; dialog.remove(); }, { once: true }); document.body.append(dialog); dialog.showModal(); render();
}
