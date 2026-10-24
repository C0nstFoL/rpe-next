const ROUTES = new Set(['/chat/completions', '/v1/tools/search', '/v1/tools/fetch', '/models']);

function installAgentNetwork({ ipcMain, net, origin, window: getWindow }) {
  const requests = new Map();
  const permitted = event => event.sender === getWindow()?.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(origin + '/');
  ipcMain.on('rpen-agent-cancel', (event, id) => { if (permitted(event)) requests.get(id)?.abort(); });
  ipcMain.handle('rpen-agent-request', async (event, { id, path, key, body } = {}) => {
    let timeout, status, responseBody; const controller = new AbortController();
    try {
      if (!permitted(event) || !ROUTES.has(path) || typeof id !== 'string' || id.length > 100 || requests.has(id) || requests.size >= 3) throw Error('AI 网络请求无效');
      if (typeof key !== 'string' || !key || key.length > 1000 || /[\r\n]/.test(key)) throw Error('API Key 无效');
      const payload = JSON.stringify(body ?? {}); if (payload.length > 12 * 1024 * 1024) throw Error('请求内容过大');
      requests.set(id, controller); timeout = setTimeout(() => controller.abort(), 180000);
      const response = await net.fetch('https://api.deepseek.com' + path, { method: path === '/models' ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, ...(path === '/models' ? {} : { body: payload }), signal: controller.signal, redirect: 'error' });
      status = response.status;
      if (!response.ok) { responseBody = await response.text(); if (responseBody.length > 16 * 1024 * 1024) responseBody = '错误响应超过大小限制'; throw Error(`DeepSeek ${response.status}：${response.status === 401 ? 'API Key 无效' : response.status === 402 ? '余额不足' : response.status === 429 ? '请求频繁，请稍后重试' : '请求失败'}`); }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = '';
      const streaming = body?.stream === true && path === '/chat/completions';
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 16 * 1024 * 1024) throw Error('AI响应过大');
          const chunk = decoder.decode(value, { stream: true });
          if (streaming) { if (!event.sender.isDestroyed()) event.sender.send('rpen-agent-chunk', { id, chunk }); } else text += chunk;
        }
        const rest = decoder.decode(); if (streaming && rest && !event.sender.isDestroyed()) event.sender.send('rpen-agent-chunk', { id, chunk: rest }); else text += rest;
      } finally { reader.releaseLock(); }
      return { ok: true, result: streaming ? null : JSON.parse(text) };
    } catch (error) { return { ok: false, status, responseBody: responseBody?.replaceAll(key || '\u0000', '[已隐藏]'), message: controller.signal.aborted ? 'AI请求已停止或超时' : error.message.replaceAll(key || '\u0000', '[已隐藏]') }; }
    finally { clearTimeout(timeout); if (requests.get(id) === controller) requests.delete(id); }
  });
  return () => { for (const controller of requests.values()) controller.abort(); requests.clear(); };
}
module.exports = { installAgentNetwork };
