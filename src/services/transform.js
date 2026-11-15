// Pure data processing: backend JSON -> view models. No React, no network, no invented values.
// Missing / invalid fields become null (never guessed). Sensor-specific values stay separate.
import { NOMINAL_PIXEL_KM } from '../config.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const num = (v) => (isNum(v) ? v : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const validCoord = (lat, lon) => isNum(lat) && isNum(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

export class DataShapeError extends Error {
  constructor(message) { super(message); this.name = 'DataShapeError'; }
}

const VIIRS_CONF = { 0: 'low', 1: 'nominal', 2: 'high' };

export function normalizeObservation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw.source === 'MODIS' || raw.source === 'VIIRS' ? raw.source : null;
  const id = str(raw.observation_id);
  if (!source || !id) return null;
  const props = raw.original_properties && typeof raw.original_properties === 'object' ? raw.original_properties : {};
  const bands = props.bands && typeof props.bands === 'object' ? props.bands : {};
  const hasCoords = validCoord(raw.latitude, raw.longitude);
  const date = DATE_RE.test(raw.acquisition_date || '') ? raw.acquisition_date : null;
  const dn = source === 'VIIRS' && (bands.DayNight === 1 || bands.DayNight === 0) ? (bands.DayNight === 1 ? 'Day' : 'Night') : null;
  return {
    id, source,
    platform: str(raw.platform), instrument: str(raw.instrument) || source,
    latitude: hasCoords ? raw.latitude : null, longitude: hasCoords ? raw.longitude : null, hasCoords,
    date, timeUtc: str(raw.acquisition_time_utc),
    confidence: raw.confidence ?? null, confidenceScale: str(raw.confidence_scale),
    frpMw: num(raw.frp_mw),
    // sensor-specific brightness, kept under its ORIGINAL band names (not interchangeable between sensors)
    brightness: source === 'MODIS'
      ? [{ band: 'T21', label: 'MODIS channel 21/22 brightness (T21)', kelvin: num(bands.T21) }]
      : [{ band: 'Bright_ti4', label: 'VIIRS I-4 brightness (Bright_ti4)', kelvin: num(bands.Bright_ti4) },
         { band: 'Bright_ti5', label: 'VIIRS I-5 brightness (Bright_ti5)', kelvin: num(bands.Bright_ti5) }],
    dayNight: dn,
    imageId: str(raw.source_image_id), imageDate: str(raw.source_image_date),
    coordinateMethod: str(raw.coordinate_method), pixelCount: num(raw.pixel_count),
    lineNumber: num(props.line_number ?? bands.line_number),
    matchStatus: 'unknown', // set by buildDataset
  };
}

export function confidenceText(o) {
  if (o.confidence === null || o.confidence === undefined) return null;
  if (o.source === 'MODIS' && isNum(o.confidence)) return `${o.confidence} % (MODIS percent scale)`;
  if (o.source === 'VIIRS' && VIIRS_CONF[o.confidence]) return `${VIIRS_CONF[o.confidence]} (${o.confidence}; VIIRS category scale)`;
  return String(o.confidence);
}

function normalizePair(p) {
  if (!p || !str(p.modis_observation_id) || !str(p.viirs_observation_id)) return null;
  return {
    modisId: p.modis_observation_id, viirsId: p.viirs_observation_id,
    distanceKm: num(p.distance_km), dateDiffDays: num(p.date_difference_days),
    temporalPossible: p.temporal_matching_possible === true, timeDiffMin: num(p.time_difference_minutes),
    classification: str(p.classification), note: str(p.temporal_note),
  };
}

/** compare = /api/harmonization/compare?include_observations=true ; summary = /api/harmonization/summary (or null). */
export function buildDataset(compare, summary = null) {
  if (!compare || typeof compare !== 'object' || typeof compare.counts !== 'object' || compare.counts === null
      || !compare.observations || !Array.isArray(compare.observations.modis) || !Array.isArray(compare.observations.viirs)) {
    throw new DataShapeError('The compare response is missing the fields the app needs (counts / observations).');
  }
  const invalid = { observations: 0 };
  const norm = (arr) => arr.map((r) => { const o = normalizeObservation(r); if (!o) invalid.observations += 1; return o; }).filter(Boolean);
  const modis = norm(compare.observations.modis);
  const viirs = norm(compare.observations.viirs);
  const observations = [...modis, ...viirs];
  const byId = new Map(observations.map((o) => [o.id, o]));

  const pairs = (Array.isArray(compare.match_details) ? compare.match_details : []).map(normalizePair).filter(Boolean);
  const pairsByObs = new Map();
  for (const p of pairs) {
    for (const [self, other] of [[p.modisId, p.viirsId], [p.viirsId, p.modisId]]) {
      if (!pairsByObs.has(self)) pairsByObs.set(self, []);
      pairsByObs.get(self).push({ partnerId: other, ...p });
    }
  }
  const um = compare.unmatched || {};
  const unmatchedIds = new Set([...(um.modis_observation_ids || []), ...(um.viirs_observation_ids || [])]);
  for (const o of observations) {
    o.matchStatus = !o.hasCoords ? 'not_evaluated' : pairsByObs.has(o.id) ? 'candidate' : unmatchedIds.has(o.id) ? 'unmatched' : 'unknown';
  }

  const c = compare.counts, co = c.observations || {}, cp = c.candidate_pairs || {}, cu = c.unmatched || {};
  const prov = compare.data_provenance || {};
  const sumOk = summary && typeof summary === 'object' && summary.observation_counts_by_source;
  return {
    status: str(compare.status) || 'ok', message: str(compare.message),
    query: compare.query || null, thresholds: compare.applied_thresholds || null,
    observations, byId, pairs, pairsByObs,
    truncated: {
      observations: !!compare.observations.truncated,
      pairs: !!compare.match_details_truncated,
      unmatched: !!um.truncated,
    },
    invalidRecords: invalid.observations,
    apiCounts: {
      modis: num(co.modis), viirs: num(co.viirs),
      candidatePairs: num(cp.total),
      modisWithCandidate: num(cp.modis_observations_with_a_candidate), viirsWithCandidate: num(cp.viirs_observations_with_a_candidate),
      unmatchedModis: num(cu.modis_observations), unmatchedViirs: num(cu.viirs_observations),
      modisNoCoords: num(cu.modis_without_coordinates), viirsNoCoords: num(cu.viirs_without_coordinates),
    },
    temporalMatchingAvailable: compare.temporal_matching_available === true,
    availability: compare.availability || {}, provenance: prov,
    retrievedAtUtc: str(prov.retrieved_at_utc), servedFromCache: prov.served_from_cache || null,
    interpretation: compare.interpretation || null,
    warnings: Array.isArray(compare.warnings) ? compare.warnings.filter((w) => typeof w === 'string') : [],
    summary: sumOk ? {
      modis: num(summary.observation_counts_by_source.MODIS), viirs: num(summary.observation_counts_by_source.VIIRS),
      byPlatform: summary.observation_counts_by_platform || {}, candidatePairs: num(summary.candidate_pairs?.total),
    } : null,
  };
}

// ------------------------------------------------------------------ view filters
export const wantsSource = (o, sat) => sat === 'BOTH' || o.source === sat;
const wantsMatch = (o, match) => match === 'all' || (match === 'candidate' && o.matchStatus === 'candidate') || (match === 'unmatched' && o.matchStatus === 'unmatched');

/** Observations after the source + matching filters (NOT the calendar date). */
export const filterObservations = (ds, { sat, match }) => ds.observations.filter((o) => wantsSource(o, sat) && wantsMatch(o, match));

export const filterByDate = (obs, date) => (date ? obs.filter((o) => o.date === date) : obs);

/** Per-date counts of observation RECORDS (not unique fires) for the calendar. */
export function calendarCounts(ds, visible) {
  const ids = new Set(visible.map((o) => o.id));
  const out = {};
  const slot = (d) => (out[d] ||= { modis: 0, viirs: 0, total: 0, pairs: 0 });
  for (const o of visible) {
    if (!o.date) continue;
    const s = slot(o.date);
    if (o.source === 'MODIS') s.modis += 1; else s.viirs += 1;
    s.total += 1;
  }
  for (const p of ds.pairs) {
    if (!ids.has(p.modisId) || !ids.has(p.viirsId)) continue;
    const d = ds.byId.get(p.modisId)?.date;
    if (d) slot(d).pairs += 1;
  }
  return out;
}

/** Statistics for exactly the records currently in view. */
export function computeStats(ds, view) {
  const ids = new Set(view.map((o) => o.id));
  const pairs = ds.pairs.filter((p) => ids.has(p.modisId) && ids.has(p.viirsId));
  const count = (src, st) => view.filter((o) => o.source === src && (st ? o.matchStatus === st : true)).length;
  return {
    modis: count('MODIS'), viirs: count('VIIRS'), total: view.length,
    candidatePairs: pairs.length,
    modisWithCandidate: count('MODIS', 'candidate'), viirsWithCandidate: count('VIIRS', 'candidate'),
    unmatchedModis: count('MODIS', 'unmatched'), unmatchedViirs: count('VIIRS', 'unmatched'),
    unknownStatus: view.filter((o) => o.matchStatus === 'unknown').length,
    withoutCoordinates: view.filter((o) => !o.hasCoords).length,
  };
}

/** Do the in-view totals (unfiltered, full list) agree with the API's own counts? null = not comparable. */
export function reconcile(ds, stats, isUnfiltered) {
  if (!isUnfiltered || ds.truncated.observations || ds.apiCounts.modis === null || ds.apiCounts.viirs === null) return null;
  const ok = stats.modis === ds.apiCounts.modis && stats.viirs === ds.apiCounts.viirs
    && (!ds.summary || (ds.summary.modis === ds.apiCounts.modis && ds.summary.viirs === ds.apiCounts.viirs));
  return { ok, detail: `observations listed ${stats.modis}/${stats.viirs}, compare counts ${ds.apiCounts.modis}/${ds.apiCounts.viirs}`
    + (ds.summary ? `, summary ${ds.summary.modis}/${ds.summary.viirs}` : '') + ' (MODIS/VIIRS)' };
}

// ------------------------------------------------------------------ globe
export const CATEGORIES = [
  { key: 'MODIS_unmatched', source: 'MODIS', status: 'unmatched', label: 'MODIS · no candidate' },
  { key: 'MODIS_candidate', source: 'MODIS', status: 'candidate', label: 'MODIS · candidate match' },
  { key: 'VIIRS_unmatched', source: 'VIIRS', status: 'unmatched', label: 'VIIRS · no candidate' },
  { key: 'VIIRS_candidate', source: 'VIIRS', status: 'candidate', label: 'VIIRS · candidate match' },
];

/** Only records with valid backend coordinates become markers. Nothing is generated. */
export function toMarkers(view) {
  return view.filter((o) => o.hasCoords).map((o) => ({
    id: o.id, satellite: o.source, latitude: o.latitude, longitude: o.longitude,
    scan: NOMINAL_PIXEL_KM[o.source], category: `${o.source}_${o.matchStatus === 'candidate' ? 'candidate' : o.matchStatus === 'unmatched' ? 'unmatched' : 'unknown'}`,
  }));
}

export function bboxFocus(bbox, key) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const span = Math.max(maxLon - minLon, maxLat - minLat);
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2, dist: Math.min(2.2, Math.max(1.08, 1.05 + span * 0.035)), key };
}
