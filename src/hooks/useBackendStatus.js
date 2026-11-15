// One-shot backend / Earth Engine status check (plus manual refresh). No polling.
import { useCallback, useEffect, useState } from 'react';
import { fireApi } from '../services/fireApi.js';

export function useBackendStatus() {
  const [s, setS] = useState({ phase: 'checking', gee: null, error: null, checkedAt: null });
  const refresh = useCallback(async () => {
    setS((p) => ({ ...p, phase: 'checking' }));
    try {
      const gee = await fireApi.geeStatus();
      setS({ phase: 'reachable', gee, error: null, checkedAt: new Date().toISOString() });
    } catch (e) {
      setS({ phase: 'unreachable', gee: null, error: e, checkedAt: new Date().toISOString() });
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { status: s, refresh };
}
