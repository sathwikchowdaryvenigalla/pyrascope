// Wrappers around the REAL /api/history/* routes. Nothing here fabricates data.
import { getJson } from './apiClient.js';

export const HISTORY_RANGES = [
  ['3d', 'Last 3 days'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['1y', 'Last year'],
  ['5y', 'Last 5 years'], ['10y', 'Last 10 years'], ['all', 'All available history'], ['custom', 'Custom date range'],
];
export const HISTORY_MAX_BBOX_DEG = 30; // mirror of backend GEE_HISTORY_MAX_BBOX_DEGREES (backend stays authoritative)
const T = 600000; // historical Earth Engine aggregation can take minutes for multi-decade ranges

const box = (b) => ({ min_lon: b[0], min_lat: b[1], max_lon: b[2], max_lat: b[3] });
export const historyBboxOk = (b) => !!b && b[2] - b[0] > 0 && b[3] - b[1] > 0 && b[2] - b[0] <= HISTORY_MAX_BBOX_DEG && b[3] - b[1] <= HISTORY_MAX_BBOX_DEG;

export const historyApi = {
  sources: (opts) => getJson('/api/history/sources', {}, { ...opts, timeoutMs: 120000 }),
  summary: (bbox, range, start, end, opts, progressId) => getJson('/api/history/summary', { ...box(bbox), range, start_date: range === 'custom' ? start : undefined, end_date: range === 'custom' ? end : undefined, progress_id: progressId }, { ...opts, timeoutMs: T }),
  progress: (id, opts) => getJson('/api/history/progress', { id }, { ...opts, timeoutMs: 15000 }),
  grid: (bbox, source, start, end, opts) => getJson('/api/history/grid', { ...box(bbox), source, start_date: start, end_date: end }, { ...opts, timeoutMs: T }),
  records: (bbox, source, start, end, opts) => getJson('/api/history/records', { ...box(bbox), source, start_date: start, end_date: end }, { ...opts, timeoutMs: T }),
  frp: (bbox, start, end, opts) => getJson('/api/history/frp', { ...box(bbox), start_date: start, end_date: end }, { ...opts, timeoutMs: T }),
  landcover: (bbox, start, end, opts) => getJson('/api/history/landcover', { ...box(bbox), start_date: start, end_date: end }, { ...opts, timeoutMs: T }),
};
