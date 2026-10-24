import { agentAbort, checkAgentSignal } from '../core/agent-commands.mjs';

export function runAgentChartScript(source, chart, input, signal, { timeout = 10000, workerFactory = () => new Worker(new URL('./agent-script-worker.mjs', import.meta.url), { type: 'module' }) } = {}) {
  checkAgentSignal(signal);
  return new Promise((resolve, reject) => {
    const worker = workerFactory(), token = crypto.randomUUID(); let finished = false;
    const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate(); if (error) reject(error); else resolve(value); };
    const abort = () => finish(agentAbort()), timer = setTimeout(() => finish(Error('谱面脚本执行超时，未应用任何变更')), timeout);
    worker.onmessage = event => { if (event.data?.token === token) finish(event.data.ok ? null : Error(event.data.error), event.data); };
    worker.onerror = event => { event.preventDefault?.(); finish(Error(event.message || '谱面脚本运行失败')); };
    signal?.addEventListener('abort', abort, { once: true });
    try { worker.postMessage({ token, source, chart, input }); } catch (error) { finish(error); }
  });
}
