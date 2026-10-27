const ROUTES = new Set(['/chat/completions', '/v1/tools/search', '/v1/tools/fetch', '/models']);

function installAgentNetwork({ ipcMain, net, origin, window: getWindow }) {
  const requests = new Map();
  const permitted = event => event.sender === getWindow()?.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(origin + '/');
  ipcMain.on('rpen-agent-cancel', (event, id) => { if (permitted(event)) requests.get(id)?.abort(); });
  ipcMain.handle('rpen-agent-request', async (event, { id, path, key, body, baseUrl } = {}) => {
    let timeout, status, responseBody, url, networkErrors; const controller = new AbortController();
    try {
      if (!permitted(event) || !ROUTES.has(path) || typeof id !== 'string' || id.length > 100 || requests.has(id) || requests.size >= 3) throw Error('AI 网络请求无效');
      if (typeof key !== 'string' || !key || key.length > 1000 || /[\r\n]/.test(key)) throw Error('API Key 无效');
      const payload = JSON.stringify(body ?? {}); if (payload.length > 12 * 1024 * 1024) throw Error('请求内容过大');
      requests.set(id, controller); timeout = setTimeout(() => controller.abort(), 180000);
      const { agentRequestUrl } = await import('../src/core/agent-routing.mjs');
      networkErrors = await import('../src/core/agent-network-errors.mjs');
      url = agentRequestUrl(path, baseUrl);
      const response = await net.fetch(url, { method: path === '/models' ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, ...(path === '/models' ? {} : { body: payload }), signal: controller.signal, redirect: 'error' });
      status = response.status;
      if (!response.ok) { responseBody = await networkErrors.agentResponseText(response); throw networkErrors.agentApiError({ url, status, statusText: response.statusText, body: responseBody, key, requestId: response.headers?.get('x-request-id') ?? response.headers?.get('x-openrouter-request-id') }); }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = '', chunks = 0;
      const streaming = body?.stream === true && path === '/chat/completions';
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 16 * 1024 * 1024) throw Error('AI响应过大');
          const chunk = decoder.decode(value, { stream: true });
          if (streaming) { if (!event.sender.isDestroyed()) { event.sender.send('rpen-agent-chunk', { id, chunk }); chunks++; } } else text += chunk;
        }
        const rest = decoder.decode(); if (streaming && rest && !event.sender.isDestroyed()) { event.sender.send('rpen-agent-chunk', { id, chunk: rest }); chunks++; } else text += rest;
      } finally { reader.releaseLock(); }
      return { ok: true, result: streaming ? { chunks } : JSON.parse(text) };
    } catch (error) {
      const failure = url && status === undefined && !controller.signal.aborted ? networkErrors.agentConnectionError(error, { url, key }) : error;
      return { ok: false, status, code: failure.code, endpoint: failure.endpoint, requestId: failure.requestId, responseBody: (failure.responseBody ?? responseBody)?.replaceAll(key || '\u0000', '[已隐藏]'), message: controller.signal.aborted ? 'AI请求已停止或超时' : failure.message.replaceAll(key || '\u0000', '[已隐藏]') };
    }
    finally { clearTimeout(timeout); if (requests.get(id) === controller) requests.delete(id); }
  });
  return () => { for (const controller of requests.values()) controller.abort(); requests.clear(); };
}
module.exports = { installAgentNetwork };
