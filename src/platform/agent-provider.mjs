import { checkAgentSignal } from '../core/agent-commands.mjs';

export class AgentProviders extends EventTarget {
  constructor() { super(); this.entries = new Map(); }
  register(provider) {
    if (!/^[a-z][a-z0-9-]+$/.test(provider.id) || this.entries.has(provider.id) || typeof provider.complete !== 'function') throw Error('Provider 无效或重复');
    this.entries.set(provider.id, provider); this.dispatchEvent(new Event('change'));
    return () => { if (this.entries.get(provider.id) === provider) { this.entries.delete(provider.id); this.dispatchEvent(new Event('change')); } };
  }
  get(id) { const provider = this.entries.get(id); if (!provider) throw Error('模型服务未注册'); return provider; }
}

export async function agentHttp(path, key, body, { signal, onChunk, request } = {}) {
  checkAgentSignal(signal);
  if (!key?.trim()) throw Error('请先在 AI 配置中填写 API Key');
  if (globalThis.rpenAgentNetwork && !request) {
    const id = crypto.randomUUID(), bridge = globalThis.rpenAgentNetwork;
    let chunkError;
    const dispose = bridge.onChunk(id, chunk => { try { onChunk?.(chunk); } catch (error) { chunkError = error; bridge.cancel(id); } });
    const abort = () => bridge.cancel(id); signal?.addEventListener('abort', abort, { once: true });
    try { const response = await bridge.request(id, path, key, body); if (chunkError) throw chunkError; if (!response.ok) throw Object.assign(Error(response.message), { status: response.status, responseBody: response.responseBody }); return response.result; }
    finally { signal?.removeEventListener('abort', abort); dispose(); }
  }
  request ??= globalThis.fetch.bind(globalThis);
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 180000);
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  let response;
  try { response = await request('https://api.deepseek.com' + path, { method: path === '/models' ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, ...(path === '/models' ? {} : { body: JSON.stringify(body) }), signal: controller.signal }); }
  catch (error) { clearTimeout(timeout); signal?.removeEventListener('abort', abort); if (signal?.aborted) throw error; throw Error('无法连接 DeepSeek：请检查网络、跨域限制或代理设置。'); }
  if (!response.ok) {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    const messages = { 400: '请求参数或上下文无效', 401: 'API Key 无效', 402: 'API 余额不足', 403: '请求被拒绝', 429: '请求过于频繁，请稍后再试', 503: '服务繁忙' };
    let responseBody = ''; try { responseBody = (await response.text()).replaceAll(key, '[已隐藏]'); } catch {}
    controller.abort();
    throw Object.assign(Error(`DeepSeek ${response.status}：${messages[response.status] ?? '服务请求失败'}`), { status: response.status, responseBody });
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0, contents = '';
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16 * 1024 * 1024) throw Error('模型响应过大'); const chunk = decoder.decode(value, { stream: true }); if (onChunk) onChunk(chunk); else contents += chunk; }
    const rest = decoder.decode(); if (onChunk) onChunk(rest); else return JSON.parse(contents + rest);
  } finally { reader.releaseLock(); clearTimeout(timeout); signal?.removeEventListener('abort', abort); controller.abort(); }
}

export function createDeepSeekProvider(request) {
  const call = (path, config, body, options) => agentHttp(path, config.key, body, { ...options, request: request ?? (globalThis.rpenAgentNetwork ? undefined : globalThis.fetch.bind(globalThis)) });
  const metadata = new Map();
  return {
    id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    capabilities(model) { return { tools: true, images: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model), search: true, streaming: true, contextWindow: 1048576 }; },
    async modelInfo(config, { signal } = {}) {
      checkAgentSignal(signal);
      const identity = config.key + '\n' + config.model, cached = metadata.get(identity);
      if (cached && Date.now() - cached.at < 3600000) return cached.value;
      let response;
      try { response = await call('/models', config, {}, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }); }
      catch (error) { checkAgentSignal(signal); const value = { contextWindow: 1048576, source: 'fallback' }; metadata.set(identity, { at: Date.now() - 3540000, value }); return value; }
      const model = response.data?.find(entry => entry.id === config.model);
      const contextWindow = Number(model?.context_window ?? model?.context_length ?? model?.max_model_len);
      const value = Number.isSafeInteger(contextWindow) && contextWindow >= 8192 ? { contextWindow, source: 'provider' } : { contextWindow: 1048576, source: 'fallback' };
      metadata.set(identity, { at: Date.now(), value }); if (metadata.size > 32) metadata.delete(metadata.keys().next().value);
      return value;
    },
    async complete({ config, system, messages, tools, signal, onText, onReasoning, onTrace }) {
      const body = { model: config.model, messages: [{ role: 'system', content: system }, ...messages.map(({ usage, model, ...message }) => {
        if (!config.thinking) delete message.reasoning_content;
        else if (message.role === 'assistant' && message.tool_calls?.length) message.reasoning_content ??= '';
        return message;
      })], tools, stream: true, stream_options: { include_usage: true }, max_tokens: config.maxTokens ?? 65536 };
      if (config.model.startsWith('deepseek-v4') || config.model === 'deepseek-flash') body.thinking = { type: config.thinking ? 'enabled' : 'disabled' };
      else if (config.model === 'deepseek-chat' && config.thinking) body.thinking = { type: 'enabled' };
      onTrace?.({ request: { url: 'https://api.deepseek.com/chat/completions', method: 'POST', headers: { Authorization: '[已隐藏]', 'Content-Type': 'application/json' }, body } });
      let pending = '', content = '', reasoning = '', finish = '', receivedDone = false, usage = null, model = config.model; const calls = new Map();
      let raw = '';
      try { await call('/chat/completions', config, body, { signal, onChunk(chunk) {
        raw += chunk;
        pending += chunk;
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim(); if (!data) continue; if (data === '[DONE]') { receivedDone = true; continue; }
          const response = JSON.parse(data); if (response.error) throw Error('模型响应包含错误');
          if (response.usage) usage = response.usage;
          if (response.model) model = response.model;
          const choice = response.choices?.[0]; if (!choice) continue;
          finish = choice.finish_reason ?? finish; const delta = choice.delta ?? {};
          if (delta.content) { content += delta.content; onText?.(delta.content); }
          if (delta.reasoning_content) { reasoning += delta.reasoning_content; onReasoning?.(delta.reasoning_content); }
          for (const part of delta.tool_calls ?? []) {
            const index = part.index ?? 0; let entry = calls.get(index);
            if (!entry) { entry = { id: '', type: 'function', function: { name: '', arguments: '' } }; calls.set(index, entry); }
            if (part.id) entry.id = part.id;
            if (part.function?.name) entry.function.name += part.function.name;
            if (part.function?.arguments) entry.function.arguments += part.function.arguments;
          }
        }
      } }); } catch (error) { onTrace?.({ response: { status: error.status, body: raw || error.responseBody || '', interrupted: Boolean(signal?.aborted) } }); throw error; }
      onTrace?.({ response: { status: 200, body: raw, format: 'text/event-stream' } });
      if (!receivedDone || !finish) throw Error('模型响应中断；本轮未执行任何新命令，可重试。');
      if (finish === 'length') throw Error('模型输出达到长度上限；请缩小任务或调高输出上限后重试');
      const toolCalls = [...calls.values()];
      if (toolCalls.some(entry => !entry.id || !entry.function.name)) throw Error('模型工具调用不完整');
      return { role: 'assistant', content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}), usage, model };
    },
    async search(config, query, signal) { return call('/v1/tools/search', config, { query, count: 5, need_content: false }, { signal }); },
    async fetch(config, url, signal) { return call('/v1/tools/fetch', config, { url }, { signal }); },
  };
}
