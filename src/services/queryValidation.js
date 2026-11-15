// Pure validation of the search form -> a query object, mirroring the backend limits for early feedback.
import { LIMITS, REGIONS } from '../config.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = 86400000;
const toUtc = (s) => Date.parse(`${s}T00:00:00Z`);

export function resolveBbox(form) {
  const region = REGIONS.find((r) => r.id === form.regionId);
  if (region && region.bbox) return region.bbox.slice();
  return [form.minLon, form.minLat, form.maxLon, form.maxLat].map((v) => (v === '' || v === null || v === undefined ? NaN : Number(v)));
}

export function validateForm(form) {
  const errors = [];
  if (!DATE_RE.test(form.start || '') || !DATE_RE.test(form.end || '') || Number.isNaN(toUtc(form.start)) || Number.isNaN(toUtc(form.end))) {
    errors.push('Select both a start date and an end date.');
  } else {
    if (form.start > form.end) errors.push('The start date must be on or before the end date.');
    const span = Math.round((toUtc(form.end) - toUtc(form.start)) / dayMs) + 1;
    if (span > LIMITS.maxDays) errors.push(`The date range is ${span} days; the maximum is ${LIMITS.maxDays}.`);
  }
  const bbox = resolveBbox(form);
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if (bbox.some((v) => !Number.isFinite(v))) {
    errors.push(bbox.every((v) => Number.isNaN(v)) ? 'Select an area first: search a place, click the globe, draw a box, or enter bounding-box values.' : 'Enter all four bounding-box values as numbers.');
  } else {
    if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) errors.push('Longitude must be within -180…180 and latitude within -90…90.');
    if (!(minLon < maxLon) || !(minLat < maxLat)) errors.push('Minimum longitude/latitude must be smaller than the maximum (boxes crossing the antimeridian are not supported).');
    if (maxLon - minLon > LIMITS.maxBboxDegrees || maxLat - minLat > LIMITS.maxBboxDegrees) errors.push(`Each side of the bounding box must be at most ${LIMITS.maxBboxDegrees}°.`);
  }
  if (errors.length) return { ok: false, errors, query: null };
  return { ok: true, errors: [], query: { start: form.start, end: form.end, bbox } };
}

export const queryKey = (q) => JSON.stringify([q.start, q.end, ...q.bbox]);
