// Pure analysis helpers for Historical Intelligence (no React, no network). Everything is computed from the API summary;
// nothing is estimated beyond what the numbers support, and wording never claims more than they show.
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const FRP_BIN_LABELS = (edges) => edges.map((lo, i) => (i + 1 < edges.length ? `${lo}–${edges[i + 1]}` : `≥${lo}`));
export const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? 'n/a' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
export const SOURCE_NAMES = { MODIS_TERRA: 'MODIS Terra', MODIS_AQUA: 'MODIS Aqua', VIIRS_SNPP: 'Suomi NPP VIIRS', MODIS: 'MODIS', VIIRS: 'VIIRS', ALL: 'Combined' };

/** Years in which each family had no queried imagery (so a zero is never confused with "unavailable"). */
export function unavailableYears(summary) {
  const out = { MODIS: [], VIIRS: [] };
  for (const r of summary.annual || []) for (const f of ['MODIS', 'VIIRS']) if (!r[f]) out[f].push(r.year);
  return out;
}

/** A year is "complete" for a source when every expected day had an image and the year is over. */
function completeYear(row, key, thisYear) {
  const a = row[key];
  return !!a && row.year < thisYear && a.expected_days >= 360 && a.images >= a.expected_days * 0.9;
}

/** Least-squares slope of records/year on single-sensor, complete years only (MODIS Terra is the longest single-sensor series). */
export function trendFor(summary, key = 'MODIS_TERRA', thisYear = new Date().getUTCFullYear()) {
  const pts = (summary.annual || []).filter((r) => completeYear(r, key, thisYear)).map((r) => [r.year, r[key].records]);
  if (pts.length < 5) return { ok: false, reason: `Fewer than 5 complete years of ${SOURCE_NAMES[key]} data in the selected period.`, n: pts.length };
  const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0), sxy = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const slope = sxy / sxx, syy = pts.reduce((s, p) => s + (p[1] - my) ** 2, 0);
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { ok: true, n, slope, mean: my, r2, from: pts[0][0], to: pts[n - 1][0] };
}

/** Month-of-year profile as shares of the period total; months with zero total give null. */
export function monthShares(summary, key = 'ALL') {
  const tot = (summary.monthly || []).reduce((s, m) => s + (m[key]?.records || 0), 0);
  return (summary.monthly || []).map((m) => (tot ? (m[key]?.records || 0) / tot : null));
}

/** Records per 100 available daily images: a coverage-normalised rate (images = days that actually exist in the archive). */
export function ratePer100Images(agg) { return agg && agg.images ? (agg.records / agg.images) * 100 : null; }

export function periodText(summary) {
  const q = summary.query; const av = Object.values(summary.availability || {}).filter((a) => a.queried_from);
  if (!av.length) return 'no overlapping imagery';
  const lo = av.map((a) => a.queried_from).sort()[0], hi = av.map((a) => a.queried_to).sort().slice(-1)[0];
  return `${lo} to ${hi}${q.range === 'all' ? ' (all available history)' : ''}`;
}

/** Concentration: share of all records held by the busiest 10% of populated cells (from a /grid response). */
export function concentration(grid) {
  const c = (grid?.cells || []).map((x) => x.records).sort((a, b) => b - a);
  if (c.length < 10) return null;
  const top = c.slice(0, Math.max(1, Math.ceil(c.length * 0.1))).reduce((s, v) => s + v, 0);
  return { share: top / c.reduce((s, v) => s + v, 0), cells: c.length };
}

/** Globe markers for a grid. Every populated cell is drawn as a red dot (same look as the live observations); the activity tier
 *  (thirds of the populated cells by record count / max FRP) is kept as data and drives the circles from tierAreas(). */
export function gridMarkers(grid, mode = 'density') {
  if (!grid?.cells?.length) return [];
  const km = grid.cell_size_deg * 111;
  const vals = grid.cells.map((c) => (mode === 'frp' ? c.frp_max_mw : c.records)).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
  const t1 = q(1 / 3), t2 = q(2 / 3);
  return grid.cells.filter((c) => (mode === 'frp' ? c.frp_max_mw !== null : true)).map((c) => {
    const v = mode === 'frp' ? c.frp_max_mw : c.records;
    return { id: `H:${c.latitude},${c.longitude}`, satellite: grid.source_family, latitude: c.latitude, longitude: c.longitude,
      scan: km * 0.9, category: `${grid.source_family}_unmatched`, tier: v <= t1 ? 'low' : v <= t2 ? 'mid' : 'high', value: v, cellDeg: grid.cell_size_deg };
  });
}

const MATCH_KM = 1; // same spatial threshold as the live candidate matching (MATCH_PARAMS.spatial_threshold_km)
const rad = (d) => (d * Math.PI) / 180;
const distKm = (a, b) => {
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Flags records that MODIS and VIIRS both recorded: same acquisition date and centres within MATCH_KM. Sets r.matched on both.
 *  The archive is daily 1 km gridded (no overpass time), so the live 30-minute test cannot be applied: this is a same-day,
 *  same-place candidate match, not proof of one fire. Returns the number of matched pairs. */
export function flagBothSensors(records) {
  const CELL = 0.02; // degrees (~2.2 km): neighbours within 1 km always fall in the same or an adjacent bucket
  const key = (r) => `${r.date}|${Math.floor(r.latitude / CELL)}|${Math.floor(r.longitude / CELL)}`;
  const modis = new Map();
  for (const r of records) {
    r.matched = false;
    if (r.source !== 'MODIS' || !r.date) continue;
    const k = key(r);
    if (!modis.has(k)) modis.set(k, []);
    modis.get(k).push(r);
  }
  let pairs = 0;
  for (const v of records) {
    if (v.source !== 'VIIRS' || !v.date) continue;
    const i = Math.floor(v.latitude / CELL), j = Math.floor(v.longitude / CELL);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const m of modis.get(`${v.date}|${i + di}|${j + dj}`) || []) {
        if (distKm(m, v) <= MATCH_KM) { m.matched = true; v.matched = true; pairs += 1; }
      }
    }
  }
  return pairs;
}

/** Globe markers for individual observation records (one dot per record, like the live view: circle = MODIS, diamond = VIIRS;
 *  yellow = also recorded by the other sensor, red = recorded by one sensor only).
 *  `responses` = /api/history/records payloads (one per sensor family). Records without valid coordinates are skipped; nothing is generated. */
export function recordMarkers(responses) {
  const recs = [];
  for (const r of responses || []) {
    for (const x of r?.records || []) {
      if (!Number.isFinite(x.latitude) || !Number.isFinite(x.longitude) || Math.abs(x.latitude) > 90 || Math.abs(x.longitude) > 180) continue;
      recs.push({ ...x });
    }
  }
  flagBothSensors(recs);
  return recs.map((x) => ({ id: `R:${x.source}:${x.latitude},${x.longitude},${x.date || ''}`, satellite: x.source, latitude: x.latitude, longitude: x.longitude,
    scan: 1, category: `${x.source}_${x.matched ? 'candidate' : 'unmatched'}`, record: x }));
}

export const TIER_META = {
  low: { label: 'Lower activity', color: '#FFD23F' },
  mid: { label: 'Medium activity', color: '#FF8A3D' },
  high: { label: 'Hotspot', color: '#FF1F4B' },
};
const MAX_CIRCLES = 60;

/** Circles that mark where the cells of one activity tier are. Neighbouring cells are joined into clusters (so one area = one
 *  circle); each circle is centred on its cluster and just large enough to cover every cell in it. Returns { circles, clusters,
 *  cells, capped }. circles: [{id, tier, lat, lon, radiusKm, cells}]. */
export function tierAreas(markers, tier) {
  const cells = (markers || []).filter((m) => m.tier === tier);
  if (!cells.length) return { circles: [], clusters: 0, cells: 0, capped: false };
  const deg = cells[0].cellDeg || 0.1, kmCell = deg * 111;
  const ij = (m) => [Math.round(m.latitude / deg), Math.round(m.longitude / deg)];
  const cluster = (gap) => { // connected components, cells at most `gap` grid steps apart are neighbours
    const at = new Map(cells.map((m, k) => [ij(m).join(','), k]));
    const seen = new Uint8Array(cells.length), out = [];
    for (let k = 0; k < cells.length; k++) {
      if (seen[k]) continue;
      const comp = [], stack = [k]; seen[k] = 1;
      while (stack.length) {
        const cur = stack.pop(); comp.push(cur);
        const [a, b] = ij(cells[cur]);
        for (let da = -gap; da <= gap; da++) for (let db = -gap; db <= gap; db++) {
          const nk = at.get(`${a + da},${b + db}`);
          if (nk !== undefined && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
        }
      }
      out.push(comp);
    }
    return out;
  };
  let gap = 1, groups = cluster(gap);
  while (groups.length > MAX_CIRCLES && gap < 12) { gap += 1; groups = cluster(gap); } // too many islands: join more distant cells
  const capped = groups.length > MAX_CIRCLES;
  groups.sort((a, b) => b.length - a.length);
  const circles = groups.slice(0, MAX_CIRCLES).map((g, n) => {
    const lat = g.reduce((t, k) => t + cells[k].latitude, 0) / g.length;
    const lon = g.reduce((t, k) => t + cells[k].longitude, 0) / g.length;
    const kmPerLon = 111 * Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    let r = 0;
    g.forEach((k) => { r = Math.max(r, Math.hypot((cells[k].latitude - lat) * 111, (cells[k].longitude - lon) * kmPerLon)); });
    return { id: `${tier}-${n}`, tier, lat, lon, radiusKm: r + kmCell * 0.75, cells: g.length };
  });
  return { circles, clusters: groups.length, cells: cells.length, capped };
}

/** Centroid (record-weighted) and top cells: used for "change in distribution" between two periods. */
export function gridSummary(grid) {
  const cells = grid?.cells || []; const tot = cells.reduce((s, c) => s + c.records, 0);
  if (!tot) return null;
  return { total: tot, cells: cells.length, lat: cells.reduce((s, c) => s + c.latitude * c.records, 0) / tot, lon: cells.reduce((s, c) => s + c.longitude * c.records, 0) / tot, top: cells.slice(0, 3) };
}
export function centroidShiftKm(a, b) {
  if (!a || !b) return null;
  const R = 6371, d2r = Math.PI / 180, dLat = (b.lat - a.lat) * d2r, dLon = (b.lon - a.lon) * d2r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Evidence-based report. Every sentence is derived from the numbers passed in; sections lacking data say so. */
export function buildReport({ summary, frp, landcover, gridMODIS, gridVIIRS, label }) {
  const o = summary.overview, S = [];
  const add = (title, paras) => S.push({ title, paras: paras.filter(Boolean) });
  const none = o.combined_records === 0;
  const avail = summary.availability || {};
  add('1. Historical observation overview', [
    `Selected area: ${label}. Period analysed: ${periodText(summary)}.`,
    none ? 'No fire observation records were found for this area and period in the queried archives.'
      : `The archives hold ${fmt(o.combined_records)} observation records (MODIS ${fmt(o.modis_records)}, VIIRS ${fmt(o.viirs_records)}) across ${o.years_with_records} of ${o.years_covered} calendar years covered. A record is one 1 km grid cell on one day with a low-, nominal- or high-confidence fire flag; records are not unique fires.`,
    ...Object.entries(avail).map(([k, a]) => a.status === 'available' ? `${SOURCE_NAMES[k]}: images verified from ${a.first_image} to ${a.last_image}; queried ${a.queried_from} to ${a.queried_to}.` : `${SOURCE_NAMES[k]}: ${a.status === 'no_overlap' ? 'no imagery overlaps this period.' : 'not accessible (' + (a.reason || 'unknown reason') + ').'}`),
  ]);
  const tr = trendFor(summary);
  add('2. Annual activity trends', none ? ['Not applicable: no records.'] : [
    o.peak_year ? `The year with the most records is ${o.peak_year.year} (${fmt(o.peak_year.records)} combined records). Combined totals mix sensors that began at different dates, so year-to-year comparisons across sensor eras are not like-for-like.` : null,
    tr.ok ? `Using MODIS Terra only (a single continuous sensor), complete years ${tr.from}–${tr.to} show a least-squares slope of ${fmt(tr.slope, 1)} records per year around a mean of ${fmt(tr.mean)} (R² = ${tr.r2.toFixed(2)}, n = ${tr.n}). A change in recorded observations does not by itself establish a change in actual fire frequency.` : `No trend is stated: ${tr.reason}`,
  ]);
  const topM = [...(summary.monthly || [])].filter((m) => m.ALL?.records > 0).sort((a, b) => b.ALL.records - a.ALL.records).slice(0, 3);
  add('3. Seasonal patterns', none ? ['Not applicable: no records.'] : [
    topM.length ? `Most records fall in ${topM.map((m) => `${MONTHS_LONG[m.month - 1]} (${fmt(m.ALL.records)})`).join(', ')}. Together these ${topM.length} month(s) hold ${fmt(100 * topM.reduce((s, m) => s + m.ALL.records, 0) / o.combined_records, 0)}% of all records.` : null,
    'Month totals pool all years in the period; they describe when records were observed, and cloud cover or missing imagery can hide detections.',
  ]);
  const miss = Object.entries(avail).filter(([, a]) => a.missing_image_days > 0).map(([k, a]) => `${SOURCE_NAMES[k]}: ${fmt(a.missing_image_days)} day(s) without an archive image`);
  add('4. Fire intensity (FRP)', none ? ['Not applicable: no records.'] : [
    o.frp_mean_mw !== null ? `Across records with FRP, the mean cell-day maximum FRP is ${fmt(o.frp_mean_mw, 1)} MW and the highest is ${fmt(o.frp_max_mw, 1)} MW (combined MODIS and VIIRS, shown only as an overall figure; the sensors are not interchangeable).` : 'No FRP values were returned.',
    frp?.bins ? `FRP classes (records): ${['MODIS', 'VIIRS'].filter((f) => frp.bins[f]).map((f) => `${f} ${frp.bins[f].map((n, i) => `${FRP_BIN_LABELS(frp.bin_edges_mw)[i]} MW: ${fmt(n)}`).join(', ')}`).join('; ')}.` : 'The FRP distribution was not loaded.',
    'FRP indicates radiative energy release at overpass time. It is not burned area, damage, or loss, and none of those are estimated here.',
  ]);
  const cg = concentration(gridMODIS) || concentration(gridVIIRS), gs = gridSummary(gridMODIS || gridVIIRS);
  add('5. Geographical distribution', !gs ? ['The spatial grid was not loaded for this report.'] : [
    `Records fall in ${fmt(gs.cells)} grid cells (cell size ${(gridMODIS || gridVIIRS).cell_size_deg}°). The busiest cell is at ${gs.top[0].latitude.toFixed(3)}, ${gs.top[0].longitude.toFixed(3)} with ${fmt(gs.top[0].records)} records.`,
    cg ? `The busiest 10% of populated cells hold ${fmt(cg.share * 100, 0)}% of records.` : null,
  ]);
  const m = o.modis_records, v = o.viirs_records, both = (summary.annual || []).filter((r) => r.MODIS && r.VIIRS);
  add('6. MODIS and VIIRS comparison', none ? ['Not applicable: no records.'] : [
    both.length ? `${both.length} calendar year(s) have both sensor families. In those years MODIS has ${fmt(both.reduce((s, r) => s + r.MODIS.records, 0))} and VIIRS ${fmt(both.reduce((s, r) => s + r.VIIRS.records, 0))} records. Both are 1 km gridded products here, but they differ in overpass times, detection algorithm and sensitivity, so counts are not directly comparable.` : `Only ${m && !v ? 'MODIS' : v && !m ? 'VIIRS' : 'one sensor family'} has records in this period, so no like-for-like comparison is possible.`,
  ]);
  const lc = landcover?.groups?.length && landcover.fire_cells ? [...landcover.groups].sort((a, b) => (b.fire_share || 0) - (a.fire_share || 0))[0] : null;
  add('7. Land-cover context', lc ? [
    `Of ${fmt(landcover.fire_cells)} 1 km cells with at least one record, the largest land-cover group is "${lc.group}" (${fmt(lc.fire_share * 100, 0)}% of fire cells vs ${fmt(lc.region_share * 100, 0)}% of the area). ${landcover.unknown_or_unavailable_cells ? fmt(landcover.unknown_or_unavailable_cells) + ' cells are unclassified.' : ''}`,
    'This describes the surrounding land surface (2021 snapshot). It is not evidence of what caused any fire.',
  ] : [landcover ? 'Land-cover context returned no usable cells.' : 'Land-cover context was not loaded or is unavailable.']);
  add('8. Data limitations', [
    'Records are archive grid cells, not unique fires; one fire can create many records across days and cells.',
    'Sensor availability differs by period (MODIS Terra and Aqua start at different dates, VIIRS later), so combined totals are not comparable across eras.',
    miss.length ? `Missing archive images: ${miss.join('; ')}.` : 'No missing archive days were detected in the retrieved months.',
    ...(summary.not_integrated || []).map((n) => `${n.platform}: ${n.reason}`),
    ...(summary.errors?.length ? [`Some chunks failed and are excluded: ${summary.errors.join('; ')}.`] : []),
  ]);
  const concl = [];
  if (!none) {
    if (topM[0]) concl.push(`Recorded activity in this area is concentrated in ${MONTHS_LONG[topM[0].month - 1]}.`);
    if (tr.ok) concl.push(Math.abs(tr.slope) < 0.02 * tr.mean ? 'The single-sensor MODIS Terra record count shows no strong linear change over the complete years analysed.' : `The single-sensor MODIS Terra record count shows a ${tr.slope > 0 ? 'rising' : 'falling'} linear tendency over ${tr.from}–${tr.to}; whether actual fire frequency changed cannot be concluded from this alone.`);
    if (o.frp_max_mw !== null) concl.push(`Recorded FRP reaches ${fmt(o.frp_max_mw, 0)} MW in the strongest cell-day.`);
  }
  add('9. Evidence-based conclusions', concl.length ? [...concl, 'These findings can help prioritise periods and places for further environmental monitoring; they are not a measure of damage.'] : ['The data do not support a conclusion for this area and period.']);
  return S;
}
