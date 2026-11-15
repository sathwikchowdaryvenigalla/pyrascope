import { renderToStaticMarkup as r } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import Header from '../../src/components/Header.jsx';
import SearchPanel from '../../src/components/SearchPanel.jsx';
import FireCalendar from '../../src/components/FireCalendar.jsx';
import StatsPanel from '../../src/components/StatsPanel.jsx';
import ObservationDetails from '../../src/components/ObservationDetails.jsx';
import DataStatus from '../../src/components/DataStatus.jsx';
import Legend from '../../src/components/Legend.jsx';
import HistoricalIntelligence from '../../src/components/HistoricalIntelligence.jsx';
import { StackedBars, Lines } from '../../src/components/HistoricalCharts.jsx';
import { ApiError } from '../../src/services/apiClient.js';
import { buildDataset, calendarCounts, computeStats, filterObservations, reconcile } from '../../src/services/transform.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const ds = buildDataset(fx('compare_full'), fx('summary_full'));
const base = filterObservations(ds, { sat: 'BOTH', match: 'all' });
const stats = computeStats(ds, base);
const range = { start: '2024-03-01', end: '2024-03-02', bbox: [76, 21, 80, 25] };
const form = { regionId: 'central-india', minLon: 76, minLat: 21, maxLon: 80, maxLat: 25, start: '2024-03-01', end: '2024-03-02' };
const backend = { phase: 'reachable', gee: { earth_engine_initialized: true, project_id: 'p' } };
const noop = () => {};
const out = {};
out.header_live = r(<Header dataState="live" gee="connected" />);
out.header_none = r(<Header dataState="none" gee="backend-down" />);
out.search_error = r(<SearchPanel form={form} setForm={noop} errors={[]} onSearch={noop} loading={false} backend={backend} onRecheck={noop} onRetry={noop}
  fetchError={new ApiError({ kind: 'http', status: 422, code: 'TOO_MANY_OBSERVATIONS', message: 'too many', hint: 'shrink' })} />);
out.search_loading = r(<SearchPanel form={form} setForm={noop} errors={[]} onSearch={noop} loading backend={backend} onRecheck={noop} onCancelLoading={noop} />);
out.search_invalid = r(<SearchPanel form={form} setForm={noop} errors={['Select both a start date and an end date.']} onSearch={noop} loading={false} backend={{ phase: 'unreachable' }} onRecheck={noop} />);
out.calendar = r(<FireCalendar month="2024-03" onMonth={noop} counts={calendarCounts(ds, base)} range={range} selected="2024-03-01" onSelect={noop} />);
out.stats = r(<StatsPanel stats={stats} scopeLabel="MODIS + VIIRS · full range" ds={ds} reconciliation={reconcile(ds, stats, true)} />);
const pickedId = ds.observations.find((o) => o.source === 'VIIRS' && o.matchStatus === 'candidate').id;
out.details = r(<ObservationDetails ds={ds} observations={base} range={range} selectedDate={null} selectedId={pickedId} onPick={noop} onClear={noop} />);
const modisId = ds.observations.find((o) => o.source === 'MODIS').id;
out.details_modis = r(<ObservationDetails ds={ds} observations={base} range={range} selectedDate={null} selectedId={modisId} onPick={noop} onClear={noop} />);
out.status_live = r(<DataStatus backend={backend} geeConnected fetchState={{ phase: 'success', dataset: ds, fetchedAt: '2024-03-05T10:00:01Z', summaryError: null }} />);
out.status_none = r(<DataStatus backend={{ phase: 'unreachable' }} geeConnected={false} fetchState={{ phase: 'idle', dataset: null }} />);
out.legend = r(<Legend showUnknown />);
out.hist_none = r(<HistoricalIntelligence bbox={null} label="" onMarkers={noop} pickedCell={null} />);
out.hist_big = r(<HistoricalIntelligence bbox={[-180, -90, 180, 90]} label="Worldwide" onMarkers={noop} pickedCell={null} />);
out.hist_chart = r(<StackedBars ariaLabel="t" rows={[{ key: 1, label: '2001', parts: [{ key: 'MODIS', value: 5 }, { key: 'VIIRS', value: null }], unavailable: ['VIIRS'], title: 'x' }]} />);
out.hist_lines = r(<Lines labels={['a', 'b', 'c']} ariaLabel="l" series={[{ key: 's', label: 'S', color: '#000', values: [1, null, 3] }]} />);

// ---- assertions (exit code 1 on any failure) ----
let fails = 0;
const has = (k, ...ss) => ss.forEach((x) => { const ok = out[k].includes(x); if (!ok) { fails += 1; console.error('FAIL', k, 'missing', JSON.stringify(x)); } });
has('header_live', 'LIVE API DATA', 'Earth Engine: connected'); has('header_none', 'NO DATA LOADED', 'Backend: unreachable');
has('search_error', 'TOO_MANY_OBSERVATIONS', 'shrink', 'Retry'); has('search_loading', 'Retrieving from Google Earth Engine', 'Cancel');
has('search_invalid', 'Select both a start date', 'Backend unreachable');
has('calendar', 'MODIS 1 · VIIRS 2 · total 3 records · 1 candidate pair', 'not unique fires');
has('stats', 'MODIS observation records', 'Candidate matches (MODIS–VIIRS pairs)', 'Unmatched VIIRS observations', 'Unique fire events: not determined', 'Totals agree');
has('details', 'Bright_ti4', 'Bright_ti5', 'VIIRS category scale', 'Candidate match (potential relationship only)', 'not interchangeable');
has('details_modis', 'T21', 'not available in the MODIS FIRMS dataset', 'daily image date');
has('status_live', 'LIVE API DATA', 'NASA/LANCE/SNPP_VIIRS/C2', 'complete'); has('status_none', 'No data loaded', 'not requested yet');
has('legend', 'MODIS · candidate match', 'VIIRS · no candidate', 'status unknown');
has('hist_none', 'Historical Intelligence', 'Last 3 days', 'All available history', 'Custom date range', 'Select a place');
has('hist_big', 'larger than 30', 'never requested');
has('hist_chart', 'Not available: VIIRS'); has('hist_lines', 'polyline');
if ((out.hist_lines.match(/<polyline/g) || []).length !== 2) { fails += 1; console.error('FAIL hist_lines: a null must break the line, not be drawn as zero'); }
for (const [k, v] of Object.entries(out)) if (/DEMO/.test(v)) { fails += 1; console.error('FAIL', k, 'contains a DEMO label'); }
console.log(fails ? `render smoke: ${fails} FAILURE(S)` : `render smoke: all ${Object.keys(out).length} component states OK`);
process.exit(fails ? 1 : 0);
