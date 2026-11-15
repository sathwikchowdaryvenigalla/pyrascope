import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../services/apiClient.js';
import { HISTORY_MAX_BBOX_DEG, historyApi, historyBboxOk } from '../services/historyApi.js';
import { FRP_BIN_LABELS, MONTHS, MONTHS_LONG, SOURCE_NAMES, buildReport, centroidShiftKm, concentration, fmt, gridMarkers, gridSummary, recordMarkers, tierAreas, TIER_META, monthShares, ratePer100Images, trendFor, unavailableYears, periodText } from '../services/historyAnalysis.js';
import { COLORS, Lines, StackedBars } from './HistoricalCharts.jsx';

const errText = (e) => (e instanceof ApiError ? `${e.message}${e.hint ? ' ' + e.hint : ''}` : String(e?.message || e));
const isAbort = (e) => e instanceof ApiError && e.kind === 'aborted';

// Runs an async loader whenever `deps` change; stale responses are aborted and ignored.
function useLoad(loader, deps, enabled = true) {
  const [s, set] = useState({ phase: 'idle', data: null, error: null });
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.abort();
    if (!enabled) { set({ phase: 'idle', data: null, error: null }); return undefined; }
    const ctrl = new AbortController(); ref.current = ctrl;
    set({ phase: 'loading', data: null, error: null });
    loader(ctrl.signal).then((data) => { if (ref.current === ctrl) set({ phase: 'ok', data, error: null }); })
      .catch((e) => { if (ref.current === ctrl && !isAbort(e)) set({ phase: 'error', data: null, error: errText(e) }); });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);
  return s;
}

function ProgressRing({ pct, stage }) {
  const r = 18, c = 2 * Math.PI * r;
  return (
    <div className="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct} aria-label="Loading historical data">
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
        <circle className="prog-track" cx="24" cy="24" r={r} />
        <circle className="prog-bar" cx="24" cy="24" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <b className="prog-pct">{pct}%</b>
      <span className="prog-stage muted">{stage}</span>
    </div>
  );
}

const Tile = ({ label, value, sub }) => <div><b>{value}</b><span>{label}</span>{sub && <small className="muted">{sub}</small>}</div>;
const Err = ({ children }) => <div role="alert" className="msg error">{children}</div>;
const Loading = ({ children }) => <p className="msg empty" role="status">{children}</p>;

// Rendered INSIDE the main menu card. The region and date fields live in the menu (SearchPanel); this component only
// receives the committed query {bbox, range, cStart, cEnd} and shows the analysis for it.
export default function HistoricalIntelligence({ query, label, onMarkers, onCells = () => {}, pickedCell, tiers = [], onTier = () => {} }) {
  const { bbox = null, range = '5y', cStart = '', cEnd = '' } = query || {};
  const [year, setYear] = useState(null);
  const [family, setFamily] = useState('MODIS');
  const [gridMode, setGridMode] = useState('density');
  const [showGlobe, setShowGlobe] = useState(true);
  const [report, setReport] = useState(null);
  const [chunks, setChunks] = useState({ done: 0, total: 0 });
  const okBox = historyBboxOk(bbox);
  const bkey = okBox ? bbox.join(',') : '';
  const customOk = range !== 'custom' || (cStart && cEnd && cStart <= cEnd);

  // a fresh random id per request lets the backend report REAL chunk progress (done / total month chunks)
  const pidRef = useRef('');
  const summary = useLoad((signal) => { pidRef.current = 'h' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); setChunks({ done: 0, total: 0 }); return historyApi.summary(bbox, range, cStart, cEnd, { signal }, pidRef.current); },
    [bkey, range, range === 'custom' ? cStart : '', range === 'custom' ? cEnd : '', query?.run], !!query && okBox && customOk);
  useEffect(() => { // poll the backend while the summary request is running
    if (summary.phase !== 'loading') return undefined;
    let stop = false;
    const tick = async () => {
      if (stop || !pidRef.current) return;
      try { const p = await historyApi.progress(pidRef.current); if (!stop && p.known) setChunks({ done: p.done, total: p.total }); } catch { /* progress is cosmetic: ignore */ }
    };
    const id = setInterval(tick, 800);
    return () => { stop = true; clearInterval(id); };
  }, [summary.phase]);
  const sum = summary.data;
  const hasData = sum && sum.overview.combined_records > 0;
  // effective period actually queried (clamped to real coverage) drives the lazy detail requests
  const eff = useMemo(() => {
    if (!sum) return null;
    const av = Object.values(sum.availability).filter((a) => a.queried_from);
    return av.length ? { start: av.map((a) => a.queried_from).sort()[0], end: av.map((a) => a.queried_to).sort().slice(-1)[0] } : null;
  }, [sum]);
  useEffect(() => { setYear(null); setReport(null); }, [bkey, range, cStart, cEnd]);

  const frp = useLoad((signal) => historyApi.frp(bbox, eff.start, eff.end, { signal }), [bkey, eff?.start, eff?.end], !!hasData && !!eff);
  const land = useLoad((signal) => historyApi.landcover(bbox, eff.start, eff.end, { signal }), [bkey, eff?.start, eff?.end], !!hasData && !!eff);
  const gStart = year ? `${year}-01-01` : eff?.start, gEnd = year ? `${year}-12-31` : eff?.end;
  const grid = useLoad((signal) => historyApi.grid(bbox, family, gStart, gEnd, { signal }), [bkey, family, gStart, gEnd], !!hasData && !!eff && showGlobe);

  // one dot per individual observation record, both sensor families at once (same period as the grid)
  const recMODIS = useLoad((signal) => historyApi.records(bbox, 'MODIS', gStart, gEnd, { signal }), [bkey, gStart, gEnd], !!hasData && !!eff && showGlobe);
  const recVIIRS = useLoad((signal) => historyApi.records(bbox, 'VIIRS', gStart, gEnd, { signal }), [bkey, gStart, gEnd], !!hasData && !!eff && showGlobe);

  // overall progress: summary 60 % (real chunk counts), records 10 %, hotspot grid 10 %, FRP 10 %, land cover 10 %. Lazy detail requests are
  // single Earth Engine calls, so they count as done only when they finish.
  const progress = useMemo(() => {
    if (!query || !okBox || !customOk || summary.phase === 'idle') return null;
    const sumFrac = summary.phase === 'ok' ? 1 : summary.phase === 'error' ? 1 : chunks.total ? Math.min(0.99, chunks.done / chunks.total) : 0;
    let pct = 60 * sumFrac, stage = chunks.total ? `Reading the archive: ${chunks.done} of ${chunks.total} monthly chunks` : 'Contacting Earth Engine…';
    if (summary.phase === 'error') return null;
    if (summary.phase === 'ok') {
      if (!hasData) return { pct: 100, stage: 'Done' };
      const parts = [[showGlobe, recMODIS, 5, 'Reading MODIS observation records'], [showGlobe, recVIIRS, 5, 'Reading VIIRS observation records'], [showGlobe, grid, 10, 'Building the activity grid'], [true, frp, 10, 'Measuring fire intensity (FRP)'], [true, land, 10, 'Reading land cover']];
      stage = 'Finishing details…';
      for (const [on, st, w, label] of parts) {
        if (!on) { pct += w; continue; }
        if (st.phase === 'ok' || st.phase === 'error') pct += w; else stage = label;
      }
    }
    return { pct: Math.round(Math.min(100, pct)), stage: pct >= 100 ? 'Done' : stage };
  }, [query, okBox, customOk, summary.phase, chunks, hasData, showGlobe, recMODIS.phase, recVIIRS.phase, grid.phase, frp.phase, land.phase]);
  const pctMax = useRef({ key: '', v: 0 });
  const progKey = `${bkey}|${range}|${cStart}|${cEnd}|${query?.run}`;
  if (pctMax.current.key !== progKey) pctMax.current = { key: progKey, v: 0 };
  if (progress) { pctMax.current.v = Math.max(pctMax.current.v, progress.pct); progress.pct = pctMax.current.v; }

  // globe dots = individual records; the grid cells are only used for the activity-level circles and the report
  const markers = useMemo(() => (showGlobe && grid.data ? gridMarkers(grid.data, gridMode) : null), [showGlobe, grid.data, gridMode]);
  const recMarkers = useMemo(() => (showGlobe && (recMODIS.data || recVIIRS.data) ? recordMarkers([recMODIS.data, recVIIRS.data]) : null), [showGlobe, recMODIS.data, recVIIRS.data]);
  useEffect(() => { onCells(markers); }, [markers]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onMarkers(recMarkers); }, [recMarkers]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { onMarkers(null); onCells(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const recTruncated = [recMODIS.data, recVIIRS.data].filter((d) => d?.truncated).map((d) => d.source_family);
  const recErrors = [['MODIS', recMODIS], ['VIIRS', recVIIRS]].filter(([, r]) => r.phase === 'error');
  const picked = pickedCell && recMarkers ? recMarkers.find((m) => m.id === pickedCell)?.record || null : null;

  const unav = sum ? unavailableYears(sum) : null;
  const annualRows = useMemo(() => (sum?.annual || []).map((r) => ({
    key: r.year, label: String(r.year),
    parts: [{ key: 'MODIS', value: r.MODIS?.records ?? null }, { key: 'VIIRS', value: r.VIIRS?.records ?? null }],
    unavailable: ['MODIS', 'VIIRS'].filter((f) => !r[f]),
    title: `${r.year}: MODIS ${r.MODIS ? fmt(r.MODIS.records) : 'source unavailable'} · VIIRS ${r.VIIRS ? fmt(r.VIIRS.records) : 'source unavailable'} · combined ${fmt(r.ALL?.records)} observation records`,
  })), [sum]);
  const yRow = year && sum ? sum.annual.find((r) => r.year === year) : null;

  const makeReport = () => setReport(buildReport({ summary: sum, frp: frp.data, landcover: land.data, gridMODIS: family === 'MODIS' ? grid.data : null, gridVIIRS: family === 'VIIRS' ? grid.data : null, label }));

  return (
    <section className="hist" aria-label="Historical Fire Intelligence">
      {!query && <Loading>Choose an area and a time period above, then press “Analyse history”.</Loading>}
      {query && <p className="muted hist-sub">{label || 'Selected area'} · {bbox ? bbox.join(', ') : '—'} · {range === 'custom' ? `${cStart} → ${cEnd}` : range}</p>}
      {bbox && !okBox && <Err>This area is larger than {HISTORY_MAX_BBOX_DEG}° per side. The global archive is never requested: choose a country, state, city or drawn box up to {HISTORY_MAX_BBOX_DEG}°.</Err>}
      {!customOk && <Err>Custom start date must be on or before the end date.</Err>}
      {progress && progress.pct < 100 && <ProgressRing pct={progress.pct} stage={progress.stage} />}
      {summary.phase === 'loading' && <p className="note">First-time queries over many years can take several minutes; completed months are cached afterwards.</p>}
      {summary.phase === 'error' && <Err>{summary.error}</Err>}

      {sum && <>
        <SourceCoverage sum={sum} />
        {sum.errors?.length > 0 && <p className="note warn">Some chunks failed and are excluded from the totals: {sum.errors.join('; ')}</p>}
        {!hasData && <div className="msg empty"><b>{sum.message || 'No fire records in this area and period.'}</b>
          <div className="muted">An empty result is shown as empty: nothing is filled in.</div></div>}
      </>}

      {hasData && <>
        <Overview sum={sum} />
        <h3>Annual trends</h3>
        <p className="muted hist-sub">Click a year to explore it on the globe. Hatched marks = that source has no imagery that year.</p>
        <StackedBars rows={annualRows} ariaLabel="Annual observation records by sensor" selected={year} onSelect={(y) => setYear((c) => (c === y ? null : y))} />
        <AnnualFrp sum={sum} />
        {unav.VIIRS.length > 0 && <p className="note">VIIRS unavailable (no imagery in the archive or period) in: {unav.VIIRS.length > 6 ? `${unav.VIIRS[0]}–${unav.VIIRS.at(-1)}` : unav.VIIRS.join(', ')}. Zeros are never inserted for these years.</p>}
        {yRow && <div className="day-detail" role="status"><b>{yRow.year}</b> · MODIS {yRow.MODIS ? fmt(yRow.MODIS.records) : 'unavailable'} · VIIRS {yRow.VIIRS ? fmt(yRow.VIIRS.records) : 'unavailable'} · combined {fmt(yRow.ALL.records)} observation records · mean FRP {fmt(yRow.ALL.frp_mean_mw, 1)} MW · max FRP {fmt(yRow.ALL.frp_max_mw, 1)} MW
          <button className="link" onClick={() => setYear(null)}>clear year</button></div>}
        <Trend sum={sum} />

        <h3>Seasonal and monthly analysis</h3>
        <Seasonal sum={sum} />

        <h3>Fire intensity (FRP)</h3>
        <Intensity sum={sum} frp={frp} />

        <h3>Geographical distribution</h3>
        <div className="hist-row">
          <div className="seg" role="group" aria-label="Globe satellite"><button type="button" aria-pressed={family === 'MODIS'} onClick={() => setFamily('MODIS')}>MODIS</button><button type="button" aria-pressed={family === 'VIIRS'} onClick={() => setFamily('VIIRS')}>VIIRS</button></div>
          <div className="seg" role="group" aria-label="Globe metric"><button type="button" aria-pressed={gridMode === 'density'} onClick={() => setGridMode('density')}>Density</button><button type="button" aria-pressed={gridMode === 'frp'} onClick={() => setGridMode('frp')}>Max FRP</button></div>
        </div>
        <label className="check"><input type="checkbox" checked={showGlobe} onChange={(e) => setShowGlobe(e.target.checked)} /> Show observation records on the globe ({year ? `year ${year}` : 'whole period'})</label>
        {(recMODIS.phase === 'loading' || recVIIRS.phase === 'loading') && <Loading>Loading observation records…</Loading>}
        {recErrors.map(([f, r]) => <Err key={f}>{f} records: {r.error}</Err>)}
        {recMarkers && <p className="note">{fmt(recMarkers.length)} observation record{recMarkers.length === 1 ? '' : 's'} drawn: {fmt(recMODIS.data?.record_count || 0)} MODIS (circles) and {fmt(recVIIRS.data?.record_count || 0)} VIIRS (diamonds). Yellow dots ({fmt(recMarkers.filter((m) => m.record.matched).length)}) were recorded by both sensors on the same day within 1 km; red dots by one sensor only. Each dot is one 1 km cell on one day with a fire detection, not a unique fire. Click a dot for its date and FRP.</p>}
        {recTruncated.length > 0 && <p className="note warn">{recTruncated.join(' and ')} has more records than the globe can draw ({fmt(recMODIS.data?.cap || recVIIRS.data?.cap)} per sensor), so the strongest-FRP records are shown. Click a year in the annual chart or choose a smaller area to see every record. Some dots may show as one-sensor only because their partner record was not among those drawn.</p>}
        {picked && <div className="day-detail" role="status"><b>{picked.source} {picked.platform}</b> · {picked.date || 'date n/a'} · {picked.latitude.toFixed(3)}, {picked.longitude.toFixed(3)} · FRP {picked.frp_mw === null ? 'n/a' : `${fmt(picked.frp_mw, 1)} MW`} · {picked.matched ? 'also recorded by the other sensor (same day, within 1 km)' : 'one sensor only'} · {picked.fire_class === 7 ? 'low' : picked.fire_class === 8 ? 'nominal' : picked.fire_class === 9 ? 'high' : 'n/a'} confidence</div>}
        {grid.phase === 'loading' && <Loading>Loading spatial grid…</Loading>}
        {grid.phase === 'error' && <Err>{grid.error}</Err>}
        {grid.data && <GridInfo grid={grid.data} mode={gridMode} />}

        <h3>Land-cover context</h3>
        <Land land={land} />

        <Compare sum={sum} bbox={bbox} label={label} range={range} cStart={cStart} cEnd={cEnd} />

        <h3>Historical report</h3>
        <button className="primary" onClick={makeReport} disabled={frp.phase === 'loading' || land.phase === 'loading'}>Generate Historical Fire Report</button>
        {(frp.phase === 'loading' || land.phase === 'loading') && <span className="muted"> waiting for intensity and land-cover details…</span>}
        {report && <Report report={report} sum={sum} />}
      </>}
    </section>
  );
}

// Activity levels = thirds of the populated grid cells, ranked by records (Density) or max FRP. Each button toggles the circles
// that mark where that level is on the globe (neighbouring cells are merged into one circle); several can be on at once.
function TierBar({ markers, tiers, onTier, loading, mode }) {
  const n = { low: 0, mid: 0, high: 0 };
  (markers || []).forEach((m) => { n[m.tier] += 1; });
  const btn = (key, cls) => {
    const on = tiers.includes(key), a = on ? tierAreas(markers, key) : null;
    return <button type="button" key={key} aria-pressed={on} onClick={() => onTier(key)} disabled={!n[key]}
      title={on ? `${a.circles.length} circle${a.circles.length === 1 ? '' : 's'} on the globe. Click to hide.` : 'Click to circle this activity level on the globe'}>
      <i className={`hs ${cls}`} />{TIER_META[key].label}<small> ({fmt(n[key])} cells)</small></button>;
  };
  const extra = tiers.map((t) => ({ t, a: tierAreas(markers, t) })).filter((x) => x.a.capped);
  return (
    <div className="tier-bar">
      <b>Activity areas on the globe</b>
      {loading && !markers && <Loading>Loading hotspot grid…</Loading>}
      {markers && <>
        <div className="seg tier-btns" role="group" aria-label="Activity level">
          {btn('low', 'hs-low')}{btn('mid', 'hs-mid')}{btn('high', 'hs-high')}
        </div>
        <p className="note">Every observation record in the period is a red dot on the globe. Lower activity, medium activity and hotspot are thirds of the populated grid cells ranked by {mode === 'frp' ? 'maximum FRP' : 'record count'}. Click a button to draw a circle around each area of that level; click it again to remove the circles.</p>
        {extra.map((x) => <p className="note warn" key={x.t}>{TIER_META[x.t].label}: the {fmt(x.a.cells)} cells form many separate areas, so the {fmt(x.a.circles.length)} largest are circled.</p>)}
      </>}
    </div>
  );
}

function SourceCoverage({ sum }) {
  return (
    <details className="hist-cov" open>
      <summary>Source coverage (verified from the archive)</summary>
      <table><thead><tr><th>Source</th><th>Earliest</th><th>Latest</th><th>Queried</th></tr></thead><tbody>
        {Object.entries(sum.availability).map(([k, a]) => <tr key={k}><td>{SOURCE_NAMES[k]}</td>
          {a.status === 'unavailable' ? <td colSpan="3" className="muted">unavailable: {a.reason}</td>
            : <><td>{a.first_image || 'n/a'}</td><td>{a.last_image || 'n/a'}</td><td>{a.queried_from ? `${a.queried_from} → ${a.queried_to}` : 'no overlap'}</td></>}</tr>)}
        {(sum.not_integrated || []).map((n) => <tr key={n.key}><td>{n.platform}</td><td colSpan="3" className="muted">not integrated</td></tr>)}
      </tbody></table>
      {Object.entries(sum.availability).filter(([, a]) => a.missing_image_days > 0).map(([k, a]) => <p key={k} className="note">{SOURCE_NAMES[k]}: {fmt(a.missing_image_days)} day(s) with no archive image in the queried months (not counted as zero fire).</p>)}
      <p className="note">{sum.record_definition}</p>
    </details>
  );
}

function Overview({ sum }) {
  const o = sum.overview;
  return (
    <div className="stat-grid">
      <Tile label="MODIS observation records" value={fmt(o.modis_records)} />
      <Tile label="VIIRS observation records" value={fmt(o.viirs_records)} />
      <Tile label="Combined observation records" value={fmt(o.combined_records)} />
      <Tile label="Years with records" value={`${o.years_with_records} / ${o.years_covered}`} />
      <Tile label="Average recorded FRP (MW)" value={fmt(o.frp_mean_mw, 1)} />
      <Tile label="Maximum recorded FRP (MW)" value={fmt(o.frp_max_mw, 1)} />
      <Tile label="Highest-count year" value={o.peak_year ? o.peak_year.year : 'n/a'} sub={o.peak_year ? `${fmt(o.peak_year.records)} records` : ''} />
      <Tile label="Most active month" value={o.most_active_month ? MONTHS_LONG[o.most_active_month.month - 1] : 'n/a'} sub={o.most_active_month ? `${fmt(o.most_active_month.records)} records` : ''} />
    </div>
  );
}

function AnnualFrp({ sum }) {
  const labels = sum.annual.map((r) => String(r.year));
  const s = (k, f, c, label, dash) => ({ key: `${k}${f}`, label, color: c, dash, values: sum.annual.map((r) => r[k]?.[f] ?? null) });
  return <>
    <Lines labels={labels} ariaLabel="Annual FRP by sensor" unit=" MW" series={[s('MODIS', 'frp_mean_mw', COLORS.MODIS, 'MODIS mean'), s('VIIRS', 'frp_mean_mw', COLORS.VIIRS, 'VIIRS mean'), s('MODIS', 'frp_max_mw', COLORS.MODIS, 'MODIS max', '3 3'), s('VIIRS', 'frp_max_mw', COLORS.VIIRS, 'VIIRS max', '3 3')]} />
    <p className="note">Annual FRP (MW) per sensor. Gaps mean no FRP value or no sensor, not zero.</p>
  </>;
}

function Trend({ sum }) {
  const t = trendFor(sum);
  return <p className="note">{t.ok ? `Single-sensor trend (MODIS Terra, complete years ${t.from}–${t.to}): ${fmt(t.slope, 1)} records/year, R² ${t.r2.toFixed(2)}. ` : `No trend shown: ${t.reason} `}
    A change in observation counts does not necessarily mean a change in actual fire frequency; satellites, overpass times and cloud cover change.</p>;
}

function Seasonal({ sum }) {
  const rows = sum.monthly.map((m) => ({ key: m.month, label: MONTHS[m.month - 1], parts: [{ key: 'MODIS', value: m.MODIS?.records ?? null }, { key: 'VIIRS', value: m.VIIRS?.records ?? null }],
    title: `${MONTHS_LONG[m.month - 1]}: MODIS ${fmt(m.MODIS?.records)} · VIIRS ${fmt(m.VIIRS?.records)} records · mean FRP ${fmt(m.ALL?.frp_mean_mw, 1)} MW · max ${fmt(m.ALL?.frp_max_mw, 1)} MW` }));
  const top = [...sum.monthly].filter((m) => m.ALL?.records > 0).sort((a, b) => b.ALL.records - a.ALL.records).slice(0, 3);
  return <>
    <StackedBars rows={rows} ariaLabel="Observation records by month of year" />
    <Lines labels={MONTHS} ariaLabel="Monthly FRP" unit=" MW" series={[{ key: 'mean', label: 'Mean FRP', color: COLORS.ALL, values: sum.monthly.map((m) => m.ALL?.frp_mean_mw ?? null) }, { key: 'max', label: 'Max FRP', color: COLORS.MODIS, dash: '3 3', values: sum.monthly.map((m) => m.ALL?.frp_max_mw ?? null) }]} />
    <p className="note"><b>Most active months:</b> {top.map((m) => `${MONTHS_LONG[m.month - 1]} (${fmt(m.ALL.records)})`).join(', ')}. Pools all years in the period. FRP lines combine both sensors; see the intensity section for per-sensor values.</p>
    <div className="seasons">{sum.seasonal.map((s) => <span key={s.season}><b>{s.season}</b> {fmt(s.records)}</span>)}</div>
    <p className="note">Seasons are northern-hemisphere meteorological seasons. Months with no archive images are not counted as zero fire (see missing-image notes).</p>
  </>;
}

function Intensity({ sum, frp }) {
  const o = sum.per_source, d = frp.data;
  return <>
    <div className="table-wrap"><table><thead><tr><th>Source</th><th>Records</th><th>Mean FRP</th><th>Max FRP</th></tr></thead><tbody>
      {Object.entries(o).map(([k, v]) => <tr key={k}><td>{SOURCE_NAMES[k]}</td><td>{fmt(v.records)}</td><td>{fmt(v.frp_mean_mw, 1)} MW</td><td>{fmt(v.frp_max_mw, 1)} MW</td></tr>)}
    </tbody></table></div>
    {frp.phase === 'loading' && <Loading>Loading FRP distribution…</Loading>}
    {frp.phase === 'error' && <Err>{frp.error}</Err>}
    {d?.bins && ['MODIS', 'VIIRS'].filter((f) => d.bins[f]).map((f) => {
      const labels = FRP_BIN_LABELS(d.bin_edges_mw);
      return <div key={f}><StackedBars keys={[f]} ariaLabel={`${f} FRP distribution`} rows={d.bins[f].map((n, i) => ({ key: i, label: labels[i], parts: [{ key: f, value: n }], title: `${f} FRP ${labels[i]} MW: ${fmt(n)} records` }))} />
        <p className="note">{f} FRP distribution (MW per 1 km cell-day).</p></div>;
    })}
    <p className="note">FRP is an indicator of fire radiative energy release at overpass time, <b>not</b> a measure of burned area or damage. MODIS and VIIRS values come from different instruments and are kept separate; they are not interchangeable.</p>
  </>;
}

function GridInfo({ grid, mode }) {
  const g = gridSummary(grid), c = concentration(grid);
  if (!g) return <p className="note">No fire records in this grid for the chosen source and period.</p>;
  return <>
    <p className="note">{grid.source_family}: {fmt(g.cells)} populated cells ({grid.cell_size_deg}° each), {fmt(g.total)} records. {c ? `Busiest 10% of cells hold ${fmt(c.share * 100, 0)}% of records. ` : ''}Activity levels are relative to this grid ({mode === 'frp' ? 'maximum FRP per cell' : 'record density'}).</p>
    {grid.truncated && <p className="note warn">The grid hit its 5,000-cell display limit; the busiest cells are listed first but some cells may be missing.</p>}
    <div className="table-wrap"><table><thead><tr><th>Top cells</th><th>Records</th><th>Max FRP</th></tr></thead><tbody>
      {grid.cells.slice(0, 5).map((r) => <tr key={`${r.latitude},${r.longitude}`}><td>{r.latitude.toFixed(3)}, {r.longitude.toFixed(3)}</td><td>{fmt(r.records)}</td><td>{fmt(r.frp_max_mw, 1)} MW</td></tr>)}
    </tbody></table></div>
  </>;
}

function Land({ land }) {
  if (land.phase === 'loading') return <Loading>Loading land-cover context…</Loading>;
  if (land.phase === 'error') return <Err>Land-cover context unavailable: {land.error}</Err>;
  const d = land.data;
  if (!d || d.status !== 'ok') return <p className="note">{d?.message || 'Land-cover context unavailable for this selection.'}</p>;
  return <>
    <div className="table-wrap"><table><thead><tr><th>Land cover</th><th>Area share</th><th>Fire-cell share</th></tr></thead><tbody>
      {d.groups.map((g) => <tr key={g.group}><td>{g.group}</td><td>{g.region_share === null ? 'n/a' : fmt(g.region_share * 100, 1) + '%'}</td><td>{g.fire_share === null ? 'n/a' : fmt(g.fire_share * 100, 1) + '%'}</td></tr>)}
      <tr><td>Unknown / unavailable</td><td colSpan="2">{fmt(d.unknown_or_unavailable_cells)} cells</td></tr>
    </tbody></table></div>
    <p className="note">Source: {d.source.name} ({d.source.dataset_id}). {d.note}</p>
  </>;
}

function Compare({ sum, bbox, label, range, cStart, cEnd }) {
  const [mode, setMode] = useState('years');
  const years = sum.annual.map((r) => r.year);
  const [yA, setYA] = useState(null), [yB, setYB] = useState(null);
  const a = yA ?? years.at(-2) ?? years[0], b = yB ?? years.at(-1);
  const [bBox, setBBox] = useState(null);
  const [r2, setR2] = useState({ start: '2010-01-01', end: '2014-12-31' });
  const target = mode === 'ranges' ? { bbox, range: 'custom', ...r2 } : mode === 'locations' && bBox && historyBboxOk(bBox) ? { bbox: bBox, range, start: cStart, end: cEnd } : null;
  const other = useLoad((signal) => historyApi.summary(target.bbox, target.range, target.start, target.end, { signal }), [mode, target?.bbox?.join(','), target?.range, target?.start, target?.end], !!target && r2.start <= r2.end);

  const yearRows = (y) => sum.year_month.filter((r) => r.year === y);
  const monthly = (rows, k = 'records') => MONTHS.map((_, i) => rows.find((r) => r.month === i + 1)?.[k] ?? null);
  return (
    <div className="hist-compare">
      <h3>Historical comparison</h3>
      <label className="field">Compare<select value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="years">Two years (annual and seasonal pattern)</option><option value="ranges">Two date ranges</option>
        <option value="locations">Two locations (same period)</option><option value="sensors">MODIS versus VIIRS</option></select></label>

      {mode === 'years' && <>
        <div className="two"><label className="field">Year A<select value={a} onChange={(e) => setYA(+e.target.value)}>{years.map((y) => <option key={y}>{y}</option>)}</select></label>
          <label className="field">Year B<select value={b} onChange={(e) => setYB(+e.target.value)}>{years.map((y) => <option key={y}>{y}</option>)}</select></label></div>
        <Lines labels={MONTHS} ariaLabel="Seasonal pattern of two years" series={[{ key: 'a', label: String(a), color: COLORS.A, values: monthly(yearRows(a)) }, { key: 'b', label: String(b), color: COLORS.B, values: monthly(yearRows(b)) }]} />
        <YearsTable sum={sum} a={a} b={b} />
      </>}

      {mode === 'ranges' && <>
        <div className="two"><label className="field">Range B from<input type="date" value={r2.start} onChange={(e) => setR2({ ...r2, start: e.target.value })} /></label>
          <label className="field">to<input type="date" value={r2.end} onChange={(e) => setR2({ ...r2, end: e.target.value })} /></label></div>
        <p className="note">Range A is the period selected above ({periodText(sum)}).</p>
        <PairResult state={other} sumA={sum} labelA="Range A" labelB="Range B" />
      </>}

      {mode === 'locations' && <>
        <p className="note">Location A: the current selection ({label}). {bBox ? `Location B (pinned): ${bBox.join(', ')}.` : 'To compare, pin this area as B, then select another place for A.'}</p>
        <BSetter current={bbox} onSet={setBBox} />
        {bBox && !historyBboxOk(bBox) && <Err>Location B is too large ({HISTORY_MAX_BBOX_DEG}° max per side).</Err>}
        <PairResult state={other} sumA={sum} labelA="Location A" labelB="Location B" />
      </>}

      {mode === 'sensors' && <SensorCompare sum={sum} />}
    </div>
  );
}

// Pins the current selection as location B; the user then selects a different place, which becomes A.
function BSetter({ current, onSet }) {
  return <button type="button" onClick={() => current && onSet(current)}>Pin current area as location B</button>;
}

function YearsTable({ sum, a, b }) {
  const ra = sum.annual.find((r) => r.year === a), rb = sum.annual.find((r) => r.year === b);
  const row = (name, f) => <tr><td>{name}</td><td>{f(ra)}</td><td>{f(rb)}</td></tr>;
  return <div className="table-wrap"><table><thead><tr><th /><th>{a}</th><th>{b}</th></tr></thead><tbody>
    {row('MODIS records', (r) => (r.MODIS ? fmt(r.MODIS.records) : 'unavailable'))}
    {row('VIIRS records', (r) => (r.VIIRS ? fmt(r.VIIRS.records) : 'unavailable'))}
    {row('Records / 100 daily images (MODIS)', (r) => fmt(ratePer100Images(r.MODIS), 1))}
    {row('Mean FRP, MODIS (MW)', (r) => fmt(r.MODIS?.frp_mean_mw, 1))}
    {row('Mean FRP, VIIRS (MW)', (r) => fmt(r.VIIRS?.frp_mean_mw, 1))}
  </tbody></table><p className="note">Compare like with like: a year with only one sensor family cannot be compared directly with a year that has both. The per-image rate normalises for missing archive days only.</p></div>;
}

function PairResult({ state, sumA, labelA, labelB }) {
  if (state.phase === 'loading') return <Loading>Loading comparison data…</Loading>;
  if (state.phase === 'error') return <Err>{state.error}</Err>;
  if (!state.data) return null;
  const B = state.data, shareA = monthShares(sumA), shareB = monthShares(B);
  const stat = (s) => [fmt(s.overview.combined_records), fmt(s.overview.modis_records), fmt(s.overview.viirs_records), fmt(s.overview.frp_mean_mw, 1), fmt(s.overview.frp_max_mw, 1), s.overview.most_active_month ? MONTHS_LONG[s.overview.most_active_month.month - 1] : 'n/a',
    fmt(ratePer100Images(Object.values(s.per_source).reduce((x, y) => ({ records: x.records + y.records, images: x.images + y.images }), { records: 0, images: 0 })), 1)];
  const names = ['Combined records', 'MODIS records', 'VIIRS records', 'Mean FRP (MW)', 'Max FRP (MW)', 'Most active month', 'Records / 100 daily images'];
  const sa = stat(sumA), sb = stat(B);
  return <>
    <Lines labels={MONTHS} ariaLabel="Monthly share of records, A versus B" unit=" %" series={[{ key: 'a', label: labelA, color: COLORS.A, values: shareA.map((v) => (v === null ? null : v * 100)) }, { key: 'b', label: labelB, color: COLORS.B, values: shareB.map((v) => (v === null ? null : v * 100)) }]} />
    <p className="note">Monthly lines are normalised to each period's own total (share of records per month), so different sizes and lengths can be compared by shape.</p>
    <div className="table-wrap"><table><thead><tr><th /><th>{labelA}</th><th>{labelB}</th></tr></thead><tbody>{names.map((n, i) => <tr key={n}><td>{n}</td><td>{sa[i]}</td><td>{sb[i]}</td></tr>)}</tbody></table></div>
    <p className="note">Totals depend on period length, area, and which sensors existed. B period: {periodText(B)}.</p>
  </>;
}

function SensorCompare({ sum }) {
  const both = sum.annual.filter((r) => r.MODIS && r.VIIRS);
  if (!both.length) return <p className="note">No calendar year in this period has both MODIS and VIIRS imagery, so no like-for-like comparison is possible.</p>;
  const labels = both.map((r) => String(r.year)), sm = monthShares(sum, 'MODIS'), sv = monthShares(sum, 'VIIRS');
  return <>
    <StackedBars keys={['MODIS', 'VIIRS']} ariaLabel="MODIS versus VIIRS records in overlapping years" rows={both.map((r) => ({ key: r.year, label: String(r.year), parts: [{ key: 'MODIS', value: r.MODIS.records }, { key: 'VIIRS', value: r.VIIRS.records }], title: `${r.year}: MODIS ${fmt(r.MODIS.records)} · VIIRS ${fmt(r.VIIRS.records)}` }))} />
    <Lines labels={MONTHS} ariaLabel="Monthly share, MODIS versus VIIRS" unit=" %" series={[{ key: 'm', label: 'MODIS', color: COLORS.MODIS, values: sm.map((v) => (v === null ? null : v * 100)) }, { key: 'v', label: 'VIIRS', color: COLORS.VIIRS, values: sv.map((v) => (v === null ? null : v * 100)) }]} />
    <p className="note">Years with both sensors: {labels.join(', ')}. Shapes (monthly share) are comparable; absolute counts are not: MODIS and VIIRS differ in overpass times, detection algorithms and sensitivity, and in this archive both are 1 km gridded products (VIIRS's 375 m native detections are not used here). FRP is also kept separate per sensor.</p>
  </>;
}

function Report({ report, sum }) {
  const text = report.map((s) => `${s.title}\n${s.paras.join('\n')}`).join('\n\n');
  return (
    <article className="report" aria-label="Historical fire report">
      {report.map((s) => <section key={s.title}><h4>{s.title}</h4>{s.paras.map((p, i) => <p key={i}>{p}</p>)}</section>)}
      <p className="note">Generated {new Date().toISOString().slice(0, 16)}Z from archive data retrieved {sum.retrieved_at_utc?.slice(0, 16)}Z. All figures come from the retrieved statistics.</p>
      <div className="side-actions"><button onClick={() => navigator.clipboard?.writeText(text)}>Copy report</button>
        <button onClick={() => { const u = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); const a = document.createElement('a'); a.href = u; a.download = 'pyrascope-historical-report.txt'; a.click(); URL.revokeObjectURL(u); }}>Download .txt</button></div>
    </article>
  );
}