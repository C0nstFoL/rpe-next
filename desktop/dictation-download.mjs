import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';

const cancelled = () => Object.assign(Error('Dictation download cancelled'), { name: 'AbortError' });
const checkpoint = signal => { if (signal.aborted) throw cancelled(); };
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
function rangeInfo(response) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : null;
}

export async function downloadSpeechFile({ urls, path, algorithm, expected, signal, fetcher = globalThis.fetch, progress = () => {}, maximum = 256 * 1024 ** 2, expectedBytes, connections = 4, timeout = 15000, attempts = 3 }) {
  checkpoint(signal);
  const sources = [...new Set(urls)], probes = new AbortController();
  let source, total = 0, received = 0, previousBytes = 0, previousTime = Date.now(), stage = 'connecting', handle, owned = false;
  const report = () => {
    if (signal.aborted) return;
    const now = Date.now(), elapsed = now - previousTime;
    progress({ stage, bytes: received, total, bytesPerSecond: elapsed > 0 ? Math.max(0, received - previousBytes) * 1000 / elapsed : 0, source: source ? new URL(source).hostname : '' });
    previousBytes = received; previousTime = now;
  };
  report();
  const timer = setInterval(report, 250);
  try {
    let selected;
    try {
      selected = await Promise.any(sources.map(async url => {
        const combined = AbortSignal.any([signal, probes.signal, AbortSignal.timeout(timeout)]);
        const response = await abortable(fetcher(url, { signal: combined, headers: { Range: 'bytes=0-0' }, cache: 'no-store' }), combined);
        try {
          if (!response.ok) throw Error('HTTP ' + response.status);
          const range = rangeInfo(response), size = response.status === 206 ? range?.total : Number(response.headers.get('content-length'));
          if (response.status === 206 && (range?.start !== 0 || range?.end !== 0)) throw Error('Invalid speech download range');
          if (size && (!Number.isSafeInteger(size) || size < 1 || size > maximum || expectedBytes && size !== expectedBytes)) throw Error('Unexpected speech download size');
          return { url: response.url || url, original: url, size: size || expectedBytes || 0, ranges: response.status === 206 };
        } finally { response.body?.cancel().catch(() => {}); }
      }));
    } catch (error) {
      checkpoint(signal);
      throw Error('Speech download could not connect: ' + (error.errors?.map(item => item.message).join('; ') || error.message));
    } finally { probes.abort(); }
    checkpoint(signal);
    source = selected.url; total = selected.size;
    const candidates = [...new Set([selected.url, selected.original, ...sources])];
    handle = await open(path, 'wx'); owned = true;
    async function transfer(part, shared, ranged) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        checkpoint(signal);
        const controller = new AbortController(), combined = AbortSignal.any([signal, shared, controller.signal]);
        let idle, reader;
        const resetTimeout = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(Error('Speech download connection stalled')), timeout); };
        resetTimeout();
        try {
          const url = candidates[Math.min(attempt, candidates.length - 1)], start = part.start + part.written;
          const response = await abortable(fetcher(url, { signal: combined, headers: ranged ? { Range: `bytes=${start}-${part.end}` } : {}, cache: 'no-store' }), combined);
          if (!response.ok) { response.body?.cancel().catch(() => {}); throw Error('Speech download failed: HTTP ' + response.status); }
          const range = rangeInfo(response);
          if (ranged && (response.status !== 206 || range?.start !== start || range?.end !== part.end || range?.total !== total)) {
            response.body?.cancel().catch(() => {});
            throw Object.assign(Error('Speech server did not honor the download range'), { code: 'SPEECH_NO_RANGE' });
          }
          if (!ranged) {
            received -= part.written; part.written = 0;
            const length = Number(response.headers.get('content-length'));
            if (length && (length > maximum || expectedBytes && length !== expectedBytes)) { response.body?.cancel().catch(() => {}); throw Error('Unexpected speech download size'); }
            total = length || expectedBytes || 0;
          }
          stage = 'download'; source = url; reader = response.body.getReader(); reader.closed.catch(() => {}); resetTimeout();
          for (;;) {
            const { done, value } = await abortable(reader.read(), combined);
            if (done) break;
            checkpoint(combined); resetTimeout();
            if (part.start + part.written + value.length > (ranged ? part.end + 1 : total || maximum)) throw Error('Speech download exceeds the size limit');
            let offset = 0;
            while (offset < value.length) {
              checkpoint(combined);
              const written = (await handle.write(value, offset, value.length - offset, part.start + part.written)).bytesWritten;
              if (!written) throw Error('Speech download could not be written');
              offset += written; part.written += written; received += written;
            }
          }
          if (ranged && part.start + part.written !== part.end + 1 || !ranged && total && part.written !== total) throw Error('Speech download was interrupted');
          return;
        } catch (error) {
          checkpoint(signal);
          if (shared.aborted || error.code === 'SPEECH_NO_RANGE' || attempt + 1 === attempts) throw error;
        } finally { clearTimeout(idle); controller.abort(); reader?.cancel().catch(() => {}); }
      }
    }
    const segmented = selected.ranges && total >= 4 * 1024 ** 2 && connections > 1;
    let fallback = !segmented;
    if (segmented) {
      const group = new AbortController(), count = Math.min(4, connections), length = Math.ceil(total / count);
      let primaryFailure;
      const parts = Array.from({ length: count }, (_, index) => ({ start: index * length, end: Math.min(total, (index + 1) * length) - 1, written: 0 }));
      await Promise.allSettled(parts.map(part => transfer(part, group.signal, true).catch(error => { primaryFailure ??= error; group.abort(); throw error; })));
      checkpoint(signal);
      if (primaryFailure) {
        if (primaryFailure.code !== 'SPEECH_NO_RANGE') throw primaryFailure;
        await handle.truncate(0); received = 0; previousBytes = 0; fallback = true;
      }
    }
    if (fallback) await transfer({ start: 0, end: total - 1, written: 0 }, new AbortController().signal, false);
    checkpoint(signal);
    await handle.sync(); await handle.close(); handle = null;
    stage = 'verify'; report(); clearInterval(timer);
    const hash = createHash(algorithm);
    for await (const bytes of createReadStream(path)) { checkpoint(signal); hash.update(bytes); }
    if (hash.digest(algorithm === 'sha512' ? 'base64' : 'hex') !== expected) throw Error('Speech download integrity verification failed');
    checkpoint(signal);
  } catch (error) {
    if (handle) { await handle.close(); handle = null; }
    if (owned) await rm(path, { force: true });
    checkpoint(signal); throw error;
  } finally { clearInterval(timer); probes.abort(); }
}
