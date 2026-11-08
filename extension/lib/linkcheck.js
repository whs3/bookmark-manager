// Broken-link checker. Runs from the manager page, which has host permission
// (requested on demand) so cross-origin requests are allowed.

const STATUS_TEXT = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  408: 'Request Timeout', 410: 'Gone', 429: 'Too Many Requests', 451: 'Unavailable For Legal Reasons',
  500: 'Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

async function attempt(url, method, timeout, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { method, redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
    return { code: res.status, finalUrl: res.url };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { error: ctrl.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    ctrl.abort(); // we only need the status line; drop any body
  }
}

/**
 * Returns { status: 'ok' | 'broken' | 'warn', code?, reason }.
 * 'broken' = gone for sure (404/410, host unreachable); 'warn' = needs a look
 * (timeouts, 403s from bot protection, 5xx that may be temporary).
 */
export async function checkUrl(url, { timeout = 12000, signal } = {}) {
  let r = await attempt(url, 'HEAD', timeout, signal);
  // Many servers mishandle HEAD; confirm any failure with a GET.
  if (r.error === 'network' || r.code >= 400) {
    const g = await attempt(url, 'GET', timeout, signal);
    if (g.code || !r.code) r = g;
  }
  if (r.error === 'network') return { status: 'broken', reason: 'Unreachable (DNS, connection or certificate error)' };
  if (r.error === 'timeout') return { status: 'warn', reason: `No response after ${timeout / 1000}s` };
  const text = `HTTP ${r.code}${STATUS_TEXT[r.code] ? ' ' + STATUS_TEXT[r.code] : ''}`;
  if (r.code === 404 || r.code === 410) return { status: 'broken', code: r.code, reason: text };
  if (r.code >= 400) return { status: 'warn', code: r.code, reason: text };
  return { status: 'ok', code: r.code, reason: text };
}

/** Check bookmarks with limited concurrency; onResult(result, done, total) per bookmark. */
export async function checkLinks(bookmarks, { concurrency = 6, signal, onResult } = {}) {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < bookmarks.length && !signal?.aborted) {
      const bm = bookmarks[next++];
      let res;
      try {
        res = await checkUrl(bm.url, { signal });
      } catch {
        return; // cancelled
      }
      done++;
      onResult?.({ bm, ...res }, done, bookmarks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, bookmarks.length) }, worker));
  return done;
}
