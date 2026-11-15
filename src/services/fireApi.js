// Typed-ish wrappers around the REAL backend routes. Nothing here fabricates data.
import { LIMITS, MATCH_PARAMS } from '../config.js';
import { getJson } from './apiClient.js';

export const bboxParams = (q) => ({
  start_date: q.start, end_date: q.end,
  min_lon: q.bbox[0], min_lat: q.bbox[1], max_lon: q.bbox[2], max_lat: q.bbox[3],
});

export const fireApi = {
  /** GET /api/health : is the backend process up (and has EE initialised)? */
  health: (opts) => getJson('/api/health', {}, { ...opts, timeoutMs: 8000 }),
  /** GET /api/gee/status : Earth Engine initialisation status (no secrets). */
  geeStatus: (opts) => getJson('/api/gee/status', {}, { ...opts, timeoutMs: 8000 }),
  /** GET /api/harmonization/compare : observations (with coordinates) + candidate pairs + unmatched ids. */
  compare: (q, opts) => getJson('/api/harmonization/compare',
    { ...bboxParams(q), ...MATCH_PARAMS, include_observations: true, max_details: LIMITS.maxDetails }, opts),
  /** GET /api/harmonization/summary : counts by source/date/platform. Served from the backend cache after compare. */
  summary: (q, opts) => getJson('/api/harmonization/summary', { ...bboxParams(q), ...MATCH_PARAMS }, opts),
  /** GET /api/impact/observation/{id} : environmental context for ONE selected observation (live Earth Engine datasets). */
  impact: (o, opts) => getJson(`/api/impact/observation/${encodeURIComponent(o.id)}`, {
    latitude: o.latitude, longitude: o.longitude, acquisition_date: o.date, source: o.source,
    platform: o.platform, instrument: o.instrument, acquisition_time_utc: o.timeUtc, frp_mw: o.frpMw,
    confidence: o.confidence, confidence_scale: o.confidenceScale, day_night: o.dayNight, match_status: o.matchStatus,
  }, { ...opts, timeoutMs: 120000 }),
};
