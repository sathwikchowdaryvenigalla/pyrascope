// Owns the request lifecycle: loading / error / success, cancellation, retry, and a small client cache so the same
// query is never requested twice within the backend cache TTL unless the user explicitly retries.
import { useCallback, useRef, useState } from 'react';
import { LIMITS } from '../config.js';
import { ApiError } from '../services/apiClient.js';
import { fireApi } from '../services/fireApi.js';
import { queryKey } from '../services/queryValidation.js';
import { buildDataset, DataShapeError } from '../services/transform.js';

const initial = { phase: 'idle', query: null, dataset: null, error: null, summaryError: null, fetchedAt: null, fromClientCache: false };

export function useFireData() {
  const [state, setState] = useState(initial);
  const abortRef = useRef(null);
  const cacheRef = useRef(new Map());

  const run = useCallback(async (query, { force = false } = {}) => {
    const key = queryKey(query);
    const hit = cacheRef.current.get(key);
    if (!force && hit && Date.now() - hit.at < LIMITS.clientCacheTtlMs) {
      setState({ phase: 'success', query, ...hit.value, error: null, fromClientCache: true });
      return true;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ ...initial, phase: 'loading', query });
    try {
      const compare = await fireApi.compare(query, { signal: ctrl.signal });
      let summary = null, summaryError = null;
      try { summary = await fireApi.summary(query, { signal: ctrl.signal }); } // backend cache hit after compare
      catch (e) { if (e instanceof ApiError && e.kind === 'aborted') throw e; summaryError = e; }
      const dataset = buildDataset(compare, summary);
      const value = { dataset, summaryError: summaryError ? { message: summaryError.message } : null, fetchedAt: new Date().toISOString() };
      cacheRef.current.set(key, { at: Date.now(), value });
      if (abortRef.current !== ctrl) return false;
      setState({ phase: 'success', query, ...value, error: null, fromClientCache: false });
      return true;
    } catch (e) {
      if (abortRef.current !== ctrl) return false;
      if (e instanceof ApiError && e.kind === 'aborted') { setState({ ...initial, query }); return false; }
      const error = e instanceof ApiError ? e
        : new ApiError({ kind: 'invalid_response', message: e instanceof DataShapeError ? e.message : `Unexpected error while processing the response: ${e?.message || e}` });
      setState({ ...initial, phase: 'error', query, error });
      return false;
    }
  }, []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  // Drop the loaded dataset (used when the geographic selection is cleared or returns to worldwide).
  const reset = useCallback(() => { abortRef.current?.abort(); abortRef.current = null; setState(initial); }, []);
  return { state, run, cancel, reset }; // run() resolves true on success, false on failure / cancellation
}
