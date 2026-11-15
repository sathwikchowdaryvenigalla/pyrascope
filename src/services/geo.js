// Pure geographic helpers (no React, no DOM): selection model, coordinate parsing, Photon geocoding, camera focus.
// A selection is { kind, level, label, bbox:[minLon,minLat,maxLon,maxLat], point?:{lat,lon} }.
// Selections of ANY size can be shown on the globe, but only bboxes within LIMITS.maxBboxDegrees can be retrieved
// (the backend refuses larger harmonization queries; see backend/config.py). bboxRetrievable() reports this.
import { GEOCODER_URL, LIMITS, PLACE_BOX_DEG, POINT_BOX_DEG } from '../config.js';

export const WORLD = { kind: 'world', level: 'Worldwide', label: 'Worldwide', bbox: [-180, -90, 180, 90] };

// Seven approximate continent extents (navigation only; deliberately not a location database).
export const CONTINENTS = [
  ['Africa', [-18, -35, 52, 38]], ['Antarctica', [-180, -90, 180, -60]], ['Asia', [25, -11, 180, 78]],
  ['Europe', [-25, 34, 45, 72]], ['North America', [-170, 7, -50, 84]], ['Oceania', [110, -48, 180, 0]],
  ['South America', [-82, -56, -34, 13]],
].map(([label, bbox]) => ({ kind: 'continent', level: 'Continent (approx. extent)', label, bbox }));

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const fmtCoord = (lat, lon) => `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(4)}°${lon < 0 ? 'W' : 'E'}`;

export function pointToBbox(lat, lon, size = POINT_BOX_DEG) {
  const h = size / 2;
  return [r4(Math.max(-180, lon - h)), r4(Math.max(-90, lat - h)), r4(Math.min(180, lon + h)), r4(Math.min(90, lat + h))];
}

export function bboxRetrievable(bbox) {
  if (!bbox) return { ok: false, w: NaN, h: NaN };
  const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1], max = LIMITS.maxBboxDegrees;
  return { ok: w > 0 && h > 0 && w <= max && h <= max, w: r4(w), h: r4(h) };
}

export const bboxFromCorners = (a, b) => [r4(Math.min(a.lon, b.lon)), r4(Math.min(a.lat, b.lat)), r4(Math.max(a.lon, b.lon)), r4(Math.max(a.lat, b.lat))];

/** "12.97, 77.59" | "12.97N 77.59E" (lat, lon) -> point selection; four numbers "W, S, E, N" -> bbox selection. null otherwise. */
export function parseCoordinates(text) {
  const t = String(text || '').trim();
  const num = '(-?\\d+(?:\\.\\d+)?)';
  const two = t.match(new RegExp(`^${num}\\s*°?\\s*([NSns])?\\s*[,;\\s]\\s*${num}\\s*°?\\s*([EWew])?$`));
  if (two) {
    let lat = Number(two[1]), lon = Number(two[3]);
    if (two[2] && /s/i.test(two[2])) lat = -Math.abs(lat);
    if (two[4] && /w/i.test(two[4])) lon = -Math.abs(lon);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { kind: 'point', level: 'Coordinates', label: fmtCoord(lat, lon), point: { lat, lon }, bbox: pointToBbox(lat, lon) };
  }
  const four = t.match(new RegExp(`^${num}\\s*[,;\\s]\\s*${num}\\s*[,;\\s]\\s*${num}\\s*[,;\\s]\\s*${num}$`));
  if (four) {
    const [w, s, e, n] = four.slice(1).map(Number);
    if (w < -180 || e > 180 || s < -90 || n > 90 || !(w < e) || !(s < n)) return null;
    return { kind: 'box', level: 'Bounding box', label: `Box ${w}, ${s}, ${e}, ${n}`, bbox: [w, s, e, n] };
  }
  return null;
}

export const matchContinents = (q) => {
  const t = q.trim().toLowerCase();
  return t.length < 2 ? [] : CONTINENTS.filter((c) => c.label.toLowerCase().includes(t));
};

const LEVELS = { country: 'Country', state: 'State / province', county: 'County / district', city: 'City', district: 'Local area', locality: 'Local area' };

/** Photon (https://photon.komoot.io) type-ahead search -> selections. Throws on network / HTTP failure. */
export async function searchPlaces(query, { signal } = {}) {
  const layers = ['country', 'state', 'county', 'city', 'district', 'locality'].map((l) => `layer=${l}`).join('&');
  const res = await fetch(`${GEOCODER_URL}/?q=${encodeURIComponent(query)}&limit=6&lang=en&${layers}`, { signal });
  if (!res.ok) throw new Error(`Geocoder returned HTTP ${res.status}`);
  const json = await res.json();
  const seen = new Set(), out = [];
  for (const f of json.features || []) {
    const p = f.properties || {}, c = f.geometry?.coordinates;
    if (!p.name || !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const label = [p.name, p.state && p.state !== p.name ? p.state : null, p.country && p.country !== p.name ? p.country : null].filter(Boolean).join(', ');
    if (seen.has(label)) continue;
    seen.add(label);
    let bbox;
    if (Array.isArray(p.extent) && p.extent.length === 4) { // Photon extent = [minLon, maxLat, maxLon, minLat]
      const [x1, y2, x2, y1] = p.extent.map(Number);
      bbox = [Math.min(x1, x2) === x1 ? x1 : -180, y1, x1 <= x2 ? x2 : 180, y2]; // antimeridian-crossing extents widen to full longitude
      if (![x1, y1, x2, y2].every(Number.isFinite) || !(bbox[1] < bbox[3])) bbox = null;
      else if (!(bbox[0] < bbox[2])) bbox = null;
    }
    const sized = !!bbox;
    if (!bbox) bbox = pointToBbox(c[1], c[0], PLACE_BOX_DEG);
    else bbox = bbox.map(r4);
    out.push({ kind: 'place', level: LEVELS[p.type] || (p.type ? p.type[0].toUpperCase() + p.type.slice(1) : 'Place'), label, bbox,
      point: sized ? null : { lat: c[1], lon: c[0] }, sizedByExtent: sized });
  }
  return out;
}

/** Camera target for a selection. Worldwide uses the globe's initial overview. */
export function geoFocus(sel, key) {
  if (!sel || sel.kind === 'world') return { lat: 15, lon: 80, dist: 3.4, key };
  const [w, s, e, n] = sel.bbox, span = Math.max(e - w, n - s);
  return { lat: (s + n) / 2, lon: (w + e) / 2, dist: clamp(1.05 + span * 0.035, 1.08, 3.4), key };
}
