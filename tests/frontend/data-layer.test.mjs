// Run: node --test tests/frontend/
// Fixtures are CONTRACT fixtures produced by the real backend formatting code (see make_fixtures.py); they are
// NOT live NASA data and are never imported by the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, buildUrl, getJson } from '../../src/services/apiClient.js';
import { bboxParams } from '../../src/services/fireApi.js';
import { validateForm, queryKey } from '../../src/services/queryValidation.js';
import { buildDataset, calendarCounts, computeStats, filterByDate, filterObservations, normalizeObservation, reconcile, toMarkers, confidenceText, DataShapeError } from '../../src/services/transform.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const full = () => buildDataset(fx('compare_full'), fx('summary_full'));
const ALL = { sat: 'BOTH', match: 'all' };

test('buildDataset keeps sensor-specific fields separate and derives matching status', () => {
  const ds = full();
  assert.equal(ds.observations.length, 5);
  const m = ds.observations.filter((o) => o.source === 'MODIS'), v = ds.observations.filter((o) => o.source === 'VIIRS');
  assert.equal(m.length, 2); assert.equal(v.length, 3);
  assert.deepEqual(m[0].brightness.map((b) => b.band), ['T21']);
  assert.deepEqual(v[0].brightness.map((b) => b.band), ['Bright_ti4', 'Bright_ti5']);
  assert.equal(m[0].frpMw, null);                 // MODIS FIRMS has no FRP: stays null, not invented
  assert.equal(m[0].timeUtc, null);               // MODIS has no acquisition time
  assert.ok(v[0].timeUtc);                        // VIIRS has one
  assert.equal(v[0].dayNight, 'Day');
  assert.equal(m[0].dayNight, null);
  assert.equal(ds.observations.filter((o) => o.matchStatus === 'candidate').length, 4);
  assert.equal(ds.observations.filter((o) => o.matchStatus === 'unmatched').length, 1);
  assert.equal(ds.pairs.length, 2);
  assert.equal(ds.temporalMatchingAvailable, false);
  assert.equal(ds.truncated.observations, false);
});

test('confidence is shown on its own scale and never converted', () => {
  const ds = full();
  assert.match(confidenceText(ds.observations.find((o) => o.source === 'MODIS')), /% \(MODIS percent scale\)/);
  assert.match(confidenceText(ds.observations.find((o) => o.source === 'VIIRS')), /nominal \(1; VIIRS category scale\)/);
});

test('stats / calendar / markers are consistent and respect filters', () => {
  const ds = full();
  const all = filterObservations(ds, ALL);
  const s = computeStats(ds, all);
  assert.deepEqual([s.modis, s.viirs, s.total, s.candidatePairs, s.unmatchedModis, s.unmatchedViirs], [2, 3, 5, 2, 0, 1]);
  assert.equal(reconcile(ds, s, true).ok, true);
  const cal = calendarCounts(ds, all);
  assert.deepEqual(cal['2024-03-01'], { modis: 1, viirs: 2, total: 3, pairs: 1 });
  assert.deepEqual(cal['2024-03-02'], { modis: 1, viirs: 1, total: 2, pairs: 1 });
  const viirsOnly = filterObservations(ds, { sat: 'VIIRS', match: 'all' });
  assert.equal(computeStats(ds, viirsOnly).candidatePairs, 0);             // pair needs both endpoints in view
  assert.equal(filterObservations(ds, { sat: 'BOTH', match: 'unmatched' }).length, 1);
  assert.equal(filterObservations(ds, { sat: 'BOTH', match: 'candidate' }).length, 4);
  const day = filterByDate(all, '2024-03-02');
  assert.equal(day.length, 2);
  assert.equal(toMarkers(day).length, 2);
  assert.equal(reconcile(ds, computeStats(ds, day), false), null);          // not comparable when filtered
  const mk = toMarkers(all);
  assert.equal(mk.length, 5);
  assert.ok(mk.every((m) => /^(MODIS|VIIRS)_(candidate|unmatched)$/.test(m.category)));
  assert.ok(mk.every((m) => Number.isFinite(m.latitude) && Number.isFinite(m.longitude)));
});

test('truncated API lists produce "unknown" status instead of guessing', () => {
  const ds = buildDataset(fx('compare_truncated'), fx('summary_truncated'));
  assert.equal(ds.truncated.observations, true);
  assert.equal(ds.truncated.pairs, true);
  assert.ok(ds.observations.length < 5);
  assert.equal(ds.observations.length, 2);   // 1 MODIS + 1 VIIRS listed out of 2 + 3
  assert.equal(ds.apiCounts.modis, 2); assert.equal(ds.apiCounts.viirs, 3);   // authoritative totals preserved
  assert.equal(reconcile(ds, computeStats(ds, ds.observations), true), null);
});

test('pair list cut off by the API -> affected records are "unknown", not "unmatched"', () => {
  const c = fx('compare_full');
  c.match_details = []; c.match_details_truncated = true; c.unmatched.viirs_observation_ids = []; c.unmatched.truncated = true;
  const ds = buildDataset(c, null);
  assert.ok(ds.observations.every((o) => o.matchStatus === 'unknown'));
  assert.equal(computeStats(ds, ds.observations).unknownStatus, 5);
  assert.ok(toMarkers(ds.observations).every((m) => m.category.endsWith('_unknown')));
  assert.equal(computeStats(ds, ds.observations).unmatchedViirs, 0);
});

test('empty result: no observations, no markers, status passes through', () => {
  const ds = buildDataset(fx('compare_empty'), null);
  assert.equal(ds.status, 'no_data');
  assert.equal(ds.observations.length, 0);
  assert.equal(toMarkers(ds.observations).length, 0);
  assert.equal(ds.summary, null);
});

test('malformed data is handled safely, never fabricated', () => {
  assert.throws(() => buildDataset({}, null), DataShapeError);
  assert.throws(() => buildDataset({ counts: {}, observations: {} }, null), DataShapeError);
  assert.equal(normalizeObservation(null), null);
  assert.equal(normalizeObservation({ source: 'MODIS' }), null);
  const o = normalizeObservation({ observation_id: 'MODIS:x:1', source: 'MODIS', latitude: 'abc', longitude: 500, acquisition_date: 'soon' });
  assert.equal(o.hasCoords, false); assert.equal(o.latitude, null); assert.equal(o.date, null);
  const c = fx('compare_full');
  c.observations.modis.push({ junk: true }); c.observations.viirs[0].latitude = null;
  const ds = buildDataset(c, null);
  assert.equal(ds.invalidRecords, 1);
  const noCoord = ds.observations.find((x) => !x.hasCoords);
  assert.equal(noCoord.matchStatus, 'not_evaluated');
  assert.equal(toMarkers(ds.observations).length, 4);                      // record without coordinates is not drawn
  assert.equal(computeStats(ds, ds.observations).withoutCoordinates, 1);
});

test('API client: URL building and error classification', async () => {
  const u = new URL(buildUrl('/api/x', { a: 1, b: undefined, c: '' }, 'http://h:8000'));
  assert.equal(u.origin, 'http://h:8000'); assert.equal(u.searchParams.get('a'), '1'); assert.equal(u.searchParams.has('b'), false);
  const mk = (status, body) => async () => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const ok = await getJson('/p', {}, { fetchImpl: mk(200, { a: 1 }), base: 'http://h' });
  assert.deepEqual(ok, { a: 1 });
  const expectErr = async (impl, check) => { try { await getJson('/p', {}, { fetchImpl: impl, base: 'http://h' }); assert.fail('should throw'); } catch (e) { assert.ok(e instanceof ApiError); check(e); } };
  await expectErr(mk(422, { status: 'error', error: { code: 'TOO_MANY_OBSERVATIONS', message: 'too many', hint: 'shrink' } }), (e) => { assert.equal(e.kind, 'http'); assert.equal(e.code, 'TOO_MANY_OBSERVATIONS'); assert.equal(e.hint, 'shrink'); assert.equal(e.status, 422); });
  await expectErr(mk(422, { detail: [{ loc: ['query', 'min_lon'], msg: 'bad' }] }), (e) => { assert.equal(e.code, 'VALIDATION_ERROR'); assert.match(e.message, /min_lon: bad/); });
  await expectErr(mk(500, 'boom'), (e) => { assert.equal(e.kind, 'http'); assert.equal(e.status, 500); });
  await expectErr(mk(200, 'not json'), (e) => assert.equal(e.kind, 'invalid_response'));
  await expectErr(async () => { throw new TypeError('Failed to fetch'); }, (e) => assert.equal(e.kind, 'network'));
  const never = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
  try { await getJson('/p', {}, { fetchImpl: never, base: 'http://h', timeoutMs: 20 }); assert.fail(); } catch (e) { assert.equal(e.kind, 'timeout'); }
  const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 10);
  try { await getJson('/p', {}, { fetchImpl: never, base: 'http://h', signal: ctrl.signal }); assert.fail(); } catch (e) { assert.equal(e.kind, 'aborted'); }
});

test('bbox params map to the real backend parameter names', () => {
  assert.deepEqual(bboxParams({ start: '2024-03-01', end: '2024-03-02', bbox: [1, 2, 3, 4] }),
    { start_date: '2024-03-01', end_date: '2024-03-02', min_lon: 1, min_lat: 2, max_lon: 3, max_lat: 4 });
});

test('form validation mirrors backend limits', () => {
  const good = { regionId: 'central-india', start: '2024-03-01', end: '2024-03-03' };
  const v = validateForm(good);
  assert.equal(v.ok, true); assert.deepEqual(v.query.bbox, [76, 21, 80, 25]);
  assert.equal(queryKey(v.query), queryKey({ ...v.query }));
  assert.equal(validateForm({ ...good, start: '' }).ok, false);
  assert.equal(validateForm({ ...good, start: '2024-03-05' }).ok, false);
  assert.equal(validateForm({ ...good, start: '2024-01-01', end: '2024-03-01' }).ok, false);  // > 31 days
  const c = { regionId: 'custom', start: '2024-03-01', end: '2024-03-02' };
  assert.equal(validateForm({ ...c, minLon: 0, minLat: 0, maxLon: 20, maxLat: 5 }).ok, false);   // > 10 deg
  assert.equal(validateForm({ ...c, minLon: 5, minLat: 0, maxLon: 1, maxLat: 5 }).ok, false);    // min > max
  assert.equal(validateForm({ ...c, minLon: '', minLat: 0, maxLon: 1, maxLat: 5 }).ok, false);    // missing
  assert.equal(validateForm({ ...c, minLon: 0, minLat: 0, maxLon: 4, maxLat: 5 }).ok, true);
});

// ---------------- Historical Intelligence (hand-made rows test ARITHMETIC only; not satellite data) ----------------
import { buildReport, centroidShiftKm, concentration, gridMarkers, monthShares, trendFor, unavailableYears } from '../../src/services/historyAnalysis.js';
import { historyBboxOk } from '../../src/services/historyApi.js';

const agg = (records, extra = {}) => ({ records, frp_mean_mw: 10, frp_max_mw: 80, frp_records: records, images: 365, expected_days: 365, ...extra });
const hsum = () => ({
  query: { range: 'all' }, availability: { MODIS_TERRA: { status: 'available', first_image: '2001-01-01', last_image: '2024-12-31', queried_from: '2001-01-01', queried_to: '2024-12-31' } },
  overview: { modis_records: 100, viirs_records: 0, combined_records: 100, years_with_records: 6, years_covered: 6, frp_mean_mw: 10, frp_max_mw: 80, peak_year: { year: 2005, records: 30 }, most_active_month: { month: 3, records: 60 } },
  annual: [2001, 2002, 2003, 2004, 2005, 2006].map((y, i) => ({ year: y, MODIS: agg(10 + i * 2), VIIRS: null, ALL: agg(10 + i * 2), MODIS_TERRA: agg(10 + i * 2), MODIS_AQUA: null, VIIRS_SNPP: null })),
  monthly: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, MODIS: agg(i === 2 ? 60 : 0), VIIRS: null, ALL: agg(i === 2 ? 60 : 0) })),
  seasonal: [], year_month: [], per_source: {}, not_integrated: [{ key: 'N20', platform: 'NOAA-20', reason: 'not integrated' }], errors: [],
});

test('unavailable years are reported as unavailable, never as zero', () => {
  assert.deepEqual(unavailableYears(hsum()).VIIRS, [2001, 2002, 2003, 2004, 2005, 2006]);
  assert.deepEqual(unavailableYears(hsum()).MODIS, []);
});
test('single-sensor trend needs >=5 complete years and is a plain least-squares slope', () => {
  const t = trendFor(hsum(), 'MODIS_TERRA', 2030);
  assert.ok(t.ok); assert.equal(t.n, 6); assert.ok(Math.abs(t.slope - 2) < 1e-9); assert.ok(Math.abs(t.r2 - 1) < 1e-9);
  assert.equal(trendFor(hsum(), 'MODIS_AQUA', 2030).ok, false);
  assert.equal(trendFor(hsum(), 'MODIS_TERRA', 2003).ok, false); // incomplete / in-progress years are excluded
});
test('month shares sum to 1 and an empty period gives nulls', () => {
  assert.equal(monthShares(hsum()).reduce((s, v) => s + v, 0), 1);
  const empty = { monthly: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ALL: agg(0) })) };
  assert.ok(monthShares(empty).every((v) => v === null));
});
test('report is derived from the numbers, caveats trend wording, and says so when there is no data', () => {
  const r = buildReport({ summary: hsum(), frp: null, landcover: null, gridMODIS: null, gridVIIRS: null, label: 'Test area' });
  const text = r.map((s) => s.paras.join(' ')).join(' ');
  assert.equal(r.length, 9);
  assert.match(text, /100 observation records/); assert.match(text, /does not by itself establish a change in actual fire frequency/);
  assert.match(text, /March/); assert.match(text, /not burned area/);
  const lc = { fire_cells: 40, unknown_or_unavailable_cells: 0, groups: [{ group: 'Agricultural land', region_share: 0.3, fire_share: 0.75 }, { group: 'Forest', region_share: 0.5, fire_share: 0.25 }] };
  const withLc = buildReport({ summary: hsum(), frp: null, landcover: lc, label: 'x' }).map((q) => q.paras.join(' ')).join(' ');
  assert.match(withLc, /"Agricultural land" \(75% of fire cells vs 30% of the area\)/); assert.match(withLc, /not evidence of what caused/);
  assert.doesNotMatch(withLc, /agricultural fire|forest fire/i);
  const none = hsum(); none.overview = { ...none.overview, combined_records: 0, modis_records: 0, peak_year: null, most_active_month: null };
  const rn = buildReport({ summary: none, frp: null, landcover: null, label: 'x' });
  assert.match(rn.map((s) => s.paras.join(' ')).join(' '), /No fire observation records were found/);
  assert.match(rn.at(-1).paras[0], /do not support a conclusion/);
});
test('grid helpers: tiers, concentration, centroid shift', () => {
  const cells = Array.from({ length: 12 }, (_, i) => ({ latitude: i, longitude: i, records: i + 1, frp_max_mw: i }));
  const g = { source_family: 'MODIS', cell_size_deg: 0.1, cells };
  const m = gridMarkers(g);
  assert.equal(m.length, 12); assert.ok(m.every((x) => /^MODIS_h(low|mid|high)$/.test(x.category)));
  assert.ok(concentration(g).share > 0.1);
  assert.equal(concentration({ cells: cells.slice(0, 3) }), null);
  assert.ok(Math.abs(centroidShiftKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 111.2) < 0.5);
});
test('historyBboxOk enforces the 30 degree historical cap', () => {
  assert.ok(historyBboxOk([70, 8, 90, 28])); assert.equal(historyBboxOk([-180, -90, 180, 90]), false); assert.equal(historyBboxOk(null), false);
});
