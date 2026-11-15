// Low-level HTTP client. No React, no data shaping. Every failure becomes an ApiError with a stable `kind`.
import { API_BASE_URL, LIMITS } from '../config.js';

export class ApiError extends Error {
  // kind: 'network' | 'timeout' | 'aborted' | 'http' | 'invalid_response'
  constructor({ kind, message, status = null, code = null, hint = null }) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind; this.status = status; this.code = code; this.hint = hint;
  }
}

export function buildUrl(path, params = {}, base = API_BASE_URL) {
  const origin = globalThis.location?.origin ?? 'http://localhost';
  const url = new URL(`${base}${path}`, origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// Backend error bodies: {status:'error', error:{code,message,hint}}  or FastAPI validation {detail:[{loc,msg}]}.
function describeHttpError(status, body) {
  if (body && typeof body === 'object') {
    if (body.error && typeof body.error === 'object') {
      return { code: body.error.code ?? null, message: body.error.message || `Request failed (HTTP ${status}).`, hint: body.error.hint ?? null };
    }
    if (Array.isArray(body.detail)) {
      const msg = body.detail.map((d) => `${(d.loc || []).slice(1).join('.') || 'request'}: ${d.msg}`).join('; ');
      return { code: 'VALIDATION_ERROR', message: msg || 'The backend rejected the request parameters.', hint: null };
    }
    if (typeof body.detail === 'string') return { code: null, message: body.detail, hint: null };
  }
  return { code: null, message: `Request failed (HTTP ${status}).`, hint: null };
}

export async function getJson(path, params, { signal, timeoutMs = LIMITS.requestTimeoutMs, fetchImpl = globalThis.fetch, base } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const url = buildUrl(path, params, base);
  try {
    let res;
    let text;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      text = await res.text();
    } catch (e) {
      if (timedOut) throw new ApiError({ kind: 'timeout', message: `The backend did not answer within ${Math.round(timeoutMs / 1000)} s.`, hint: 'Narrow the date range or region and retry.' });
      if (signal?.aborted || e?.name === 'AbortError') throw new ApiError({ kind: 'aborted', message: 'Request cancelled.' });
      throw new ApiError({ kind: 'network', message: `Cannot reach the PyraScope backend at ${API_BASE_URL || window.location.origin}.`,
        hint: 'Start it with: uvicorn backend.main:app --reload --port 8000 (and check VITE_API_BASE_URL / CORS_ORIGINS).' });
    }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) throw new ApiError({ kind: 'http', status: res.status, ...describeHttpError(res.status, body) });
    if (body === null || typeof body !== 'object') throw new ApiError({ kind: 'invalid_response', status: res.status, message: 'The backend returned a response that is not valid JSON.' });
    return body;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
