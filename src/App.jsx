import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Header from './components/Header.jsx';
import SearchPanel from './components/SearchPanel.jsx';
import EarthGlobe from './components/EarthGlobe.jsx';
import Legend from './components/Legend.jsx';
import FireCalendar from './components/FireCalendar.jsx';
import SatToggle from './components/SatToggle.jsx';
import StatsPanel from './components/StatsPanel.jsx';
import DataStatus from './components/DataStatus.jsx';
import ErrorNotice from './components/ErrorNotice.jsx';
import ObservationDetails from './components/ObservationDetails.jsx';
import DrawBar from './components/DrawBar.jsx';
import HistoricalIntelligence from './components/HistoricalIntelligence.jsx';
import { HISTORY_MAX_BBOX_DEG } from './services/historyApi.js';
import { TIER_META, tierAreas } from './services/historyAnalysis.js';
import { useFireData } from './hooks/useFireData.js';
import { useBackendStatus } from './hooks/useBackendStatus.js';
import { REGIONS, LIMITS } from './config.js';
import { validateForm } from './services/queryValidation.js';
import { playSplit } from './services/splitAnimation.js';
import { WORLD, bboxFromCorners, bboxRetrievable, fmtCoord, geoFocus, pointToBbox } from './services/geo.js';
import { bboxFocus, calendarCounts, computeStats, filterByDate, filterObservations, reconcile, toMarkers } from './services/transform.js';

const MATCH_OPTIONS = [['all', 'All'], ['candidate', 'Candidates'], ['unmatched', 'Unmatched']];
const EMPTY = [];
const iso = (d) => d.toISOString().slice(0, 10);

// Starts worldwide with an empty box: the area comes from the globe, the search field, or the preset / coordinate fields.
function defaultForm() {
  const end = new Date(Date.now() - 86400000), start = new Date(end.getTime() - 2 * 86400000);
  return { regionId: 'custom', minLon: '', minLat: '', maxLon: '', maxLat: '', start: iso(start), end: iso(end) };
}

export default function App() {
  const [form, setForm] = useState(defaultForm);
  const [formErrors, setFormErrors] = useState([]);
  const [view, setView] = useState({ sat: 'BOTH', match: 'all' });
  const [selectedDate, setSelectedDate] = useState(null);
  const [pickedId, setPickedId] = useState(null);
  const [month, setMonth] = useState(null);
  const [focusKey, setFocusKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [sel, setSel] = useState(WORLD);
  const [navFocus, setNavFocus] = useState(null);
  const [drawing, setDrawing] = useState(false);
  const [drawTool, setDrawTool] = useState('draw');
  const [drawnBox, setDrawnBox] = useState(null);
  const [mode, setMode] = useState('live'); // main menu mode: 'live' retrieval or 'history' (Historical Intelligence)
  const [hform, setHform] = useState({ range: '5y', cStart: '2015-01-01', cEnd: iso(new Date()) });
  const [hq, setHq] = useState(null); // committed historical query {bbox, range, cStart, cEnd, label}
  const [hErrors, setHErrors] = useState([]);
  const [menuHidden, setMenuHidden] = useState(false); // history mode: hide the docked menu to see the whole globe
  const [histMarkers, setHistMarkers] = useState(null);
  const [histCells, setHistCells] = useState(null); // grid cells (with activity tier): only used for the activity-area circles
  const [histCell, setHistCell] = useState(null);
  const [histTiers, setHistTiers] = useState([]); // activity levels toggled in the menu ('low' | 'mid' | 'high'): each one draws its area circles on the globe
  const appRef = useRef(null), cardRef = useRef(null), sideRef = useRef(null), prevSide = useRef(false);

  const { state, run, cancel, reset } = useFireData();
  const { status: backend, refresh: recheck } = useBackendStatus();
  const ds = state.phase === 'success' ? state.dataset : null;
  const query = state.query;

  const apply = async (q, opts) => {
    const ok = await run(q, opts);
    if (ok) { setMonth(q.start.slice(0, 7)); setSelectedDate(null); setPickedId(null); setEditing(false); setFocusKey((k) => k + 1); setNavFocus(null); }
    return ok;
  };
  const onSearch = () => {
    const v = validateForm(form);
    setFormErrors(v.errors);
    if (!v.ok) return;
    if (sel.bbox.join(',') !== v.query.bbox.join(',')) { // box typed / preset chosen in the form: keep the globe selection in sync
      const preset = REGIONS.find((r) => r.id === form.regionId && r.bbox);
      setSel({ kind: 'box', level: preset ? 'Preset region' : 'Bounding box', label: preset ? preset.name : 'Custom bounding box', bbox: v.query.bbox });
    }
    apply(v.query);
  };

  const histMode = mode === 'history';
  // Historical menu: the area comes from the SAME bounding-box fields / selection as the live menu; the period from hform.
  const onAnalyse = () => {
    const nums = [form.minLon, form.minLat, form.maxLon, form.maxLat].map((v) => (v === '' || v === null ? NaN : Number(v)));
    const typed = nums.every(Number.isFinite) ? nums : null;
    const bbox = typed || (sel.kind !== 'world' ? sel.bbox : null);
    const errs = [];
    if (!bbox) errs.push('Choose an area first: search a place, click the globe, pick a preset or draw a box.');
    else if (!(bbox[2] > bbox[0] && bbox[3] > bbox[1])) errs.push('The bounding box is empty: max values must be greater than min values.');
    else if (bbox[2] - bbox[0] > HISTORY_MAX_BBOX_DEG || bbox[3] - bbox[1] > HISTORY_MAX_BBOX_DEG) errs.push(`Area is larger than ${HISTORY_MAX_BBOX_DEG}° per side. Choose a smaller area.`);
    if (hform.range === 'custom' && !(hform.cStart && hform.cEnd && hform.cStart <= hform.cEnd)) errs.push('Custom start date must be on or before the end date.');
    setHErrors(errs); setFormErrors(errs);
    if (errs.length) return;
    let label = sel.kind !== 'world' ? sel.label : 'Selected area';
    if (typed && sel.bbox.join(',') !== typed.join(',')) { // typed box: keep the globe outline in sync
      label = 'Custom bounding box';
      setSel({ kind: 'box', level: 'Bounding box', label, bbox: typed });
    }
    setHistTiers([]); setHq({ bbox, range: hform.range, cStart: hform.cStart, cEnd: hform.cEnd, label, run: Date.now() });
    setNavFocus(geoFocus({ kind: 'box', bbox }, 'h' + Date.now())); setMenuHidden(false); // fly to the analysed area so the hotspots are in view
  };
  const onTier = (t) => { // toggle one activity level; turning it on flies to its circles
    const on = !histTiers.includes(t);
    setHistTiers((cur) => (on ? [...cur, t] : cur.filter((x) => x !== t)));
    if (!on) return;
    const { circles } = tierAreas(histCells, t);
    if (circles.length) {
      let w = 180, s = 90, e = -180, n = -90;
      circles.forEach((c) => {
        const dLat = c.radiusKm / 111, dLon = c.radiusKm / (111 * Math.max(0.05, Math.cos((c.lat * Math.PI) / 180)));
        w = Math.min(w, c.lon - dLon); e = Math.max(e, c.lon + dLon); s = Math.min(s, c.lat - dLat); n = Math.max(n, c.lat + dLat);
      });
      setNavFocus(geoFocus({ kind: 'box', bbox: [Math.max(-180, w), Math.max(-90, s), Math.min(180, e), Math.min(90, n)] }, 't' + Date.now()));
    }
  };
  const switchMode = (m) => { setMode(m); setMenuHidden(false); setFormErrors([]); if (m === 'live') { setHistMarkers(null); setHistCells(null); setHistCell(null); setHistTiers([]); } };

  const showCard = (!ds || editing || histMode) && !drawing && !(histMode && menuHidden);
  const docked = histMode && !drawing;
  const wide = typeof window !== 'undefined' && window.innerWidth > 1000;
  const viewShift = docked && !menuHidden && wide ? -(Math.min(580, window.innerWidth * 0.94) + 24) / 2 : 0; // negative: globe centre moves LEFT of the right-docked menu
  const sideVisible = !!ds && !editing && !drawing && !histMode;
  // when the side panels appear, the menu card glides over and splits into them (see services/splitAnimation.js)
  useLayoutEffect(() => {
    if (sideVisible && !prevSide.current) playSplit(cardRef.current, sideRef.current, appRef.current);
    prevSide.current = sideVisible;
  }, [sideVisible]);
  const boxToForm = (bbox, regionId = 'custom') => ({ regionId, minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3] });
  const blankBox = { regionId: 'custom', minLon: '', minLat: '', maxLon: '', maxLat: '' };

  // One entry point for every way of choosing an area (search, preset, globe click, drawn box). It only fills the menu
  // (selection + bounding-box fields) and flies the camera; data is requested when the user presses Retrieve, after
  // choosing dates. Areas over LIMITS.maxBboxDegrees are outlined but leave the box empty (the backend would refuse them).
  const selectArea = (s, { focus = true } = {}) => {
    setSel(s); setPickedId(null); setFormErrors([]);
    if (focus) setNavFocus(geoFocus(s, 'g' + Date.now()));
    setForm((f) => ({ ...f, ...(bboxRetrievable(s.bbox).ok ? boxToForm(s.bbox, s.presetId || 'custom') : blankBox) }));
  };
  const onGlobeClick = (lat, lon) => selectArea({ kind: 'point', level: 'Globe click', label: fmtCoord(lat, lon), point: { lat, lon }, bbox: pointToBbox(lat, lon) }, { focus: false });
  const resetGeo = (toWorld) => {
    cancel(); reset(); setSel(WORLD); setPickedId(null); setSelectedDate(null); setEditing(false); setFormErrors([]);
    setForm((f) => ({ ...f, ...blankBox }));
    setNavFocus(toWorld ? geoFocus(WORLD, 'w' + Date.now()) : null);
  };
  const closeMenu = () => { // back to the loaded data: drop any unsaved selection
    setEditing(false); setFormErrors([]);
    if (query && sel.bbox.join(',') !== query.bbox.join(',')) {
      setSel({ kind: 'box', level: 'Last retrieved area', label: 'Last retrieved area', bbox: query.bbox });
      setForm((f) => ({ ...f, ...boxToForm(query.bbox) }));
    }
  };

  // Draw mode: only the globe stays on screen; OK returns to the menu to choose dates.
  const openDraw = () => { setDrawnBox(null); setDrawTool('draw'); setDrawing(true); };
  const cancelDraw = () => { setDrawing(false); setDrawnBox(null); };
  const confirmDraw = () => {
    if (!drawnBox) return;
    selectArea({ kind: 'box', level: 'Drawn box', label: 'Drawn rectangle', bbox: drawnBox });
    setDrawing(false); setDrawnBox(null); setEditing(true);
  };
  useEffect(() => {
    if (!drawing) return undefined;
    const esc = (e) => { if (e.key === 'Escape') cancelDraw(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [drawing]);

  // everything below is derived from the SAME filtered list, so globe / calendar / stats / details always agree
  const base = useMemo(() => (ds ? filterObservations(ds, view) : []), [ds, view]);
  const counts = useMemo(() => (ds ? calendarCounts(ds, base) : {}), [ds, base]);
  const dayObs = useMemo(() => filterByDate(base, selectedDate), [base, selectedDate]);
  const stats = useMemo(() => (ds ? computeStats(ds, dayObs) : null), [ds, dayObs]);
  const markers = useMemo(() => toMarkers(dayObs), [dayObs]);
  const isUnfiltered = view.sat === 'BOTH' && view.match === 'all' && !selectedDate;
  const reconciliation = useMemo(() => (ds && stats ? reconcile(ds, stats, isUnfiltered) : null), [ds, stats, isUnfiltered]);

  // one circle per cluster of cells, for every activity level that is switched on in the menu
  const histAreas = useMemo(() => (histCells && histTiers.length
    ? histTiers.flatMap((t) => tierAreas(histCells, t).circles.map((c) => ({ ...c, color: TIER_META[t].color })))
    : null), [histCells, histTiers]);
  const picked = ds && pickedId ? ds.byId.get(pickedId) || null : null;
  const pick = (id) => {
    if (typeof id === 'string' && (id.startsWith('R:') || id.startsWith('H:'))) { setHistCell((c) => (c === id ? null : id)); return; }
    if (id && ds && ds.byId.has(id) && !dayObs.some((o) => o.id === id)) { // partner hidden by a filter: reveal it
      setView({ sat: 'BOTH', match: 'all' }); setSelectedDate(null);
    }
    setPickedId(id);
  };
  const changeView = (patch) => { setView((v) => ({ ...v, ...patch })); setPickedId(null); };
  const focus = picked && picked.hasCoords ? { lat: picked.latitude, lon: picked.longitude, dist: 1.12, key: 'p' + picked.id }
    : navFocus ? navFocus
    : query ? bboxFocus(query.bbox, 's' + focusKey) : null;

  const geeChip = state.phase === 'success' || backend.gee?.earth_engine_initialized ? 'connected'
    : backend.phase === 'checking' ? 'checking' : backend.phase === 'unreachable' ? 'backend-down' : 'disconnected';
  const partial = !!ds && (ds.truncated.observations || ds.truncated.pairs || ds.truncated.unmatched);
  const scopeLabel = `${view.sat === 'BOTH' ? 'MODIS + VIIRS' : view.sat}${view.match !== 'all' ? ` · ${view.match}` : ''} · ${selectedDate || 'full range'}`;
  const caption = state.phase === 'loading' ? 'Retrieving observations from the backend…'
    : state.phase === 'error' ? 'Retrieval failed. No observations are shown.'
    : ds ? `${markers.length} observation record(s) drawn · ${scopeLabel}`
    : 'No data loaded. Search a place, click the globe, or draw a box to load observations for the selected dates.';
  const emptyCoverage = ds && ds.observations.length === 0
    ? ['MODIS', 'VIIRS'].map((s) => ds.availability?.[s]?.dataset_coverage && `${s} images available ${ds.availability[s].dataset_coverage.first_image?.slice(0, 10)} to ${ds.availability[s].dataset_coverage.last_image?.slice(0, 10)}`).filter(Boolean)
    : [];

  return (
    <div ref={appRef} className={'app' + (sideVisible ? ' side-open' : '')}>
      <div className="bg">
        <EarthGlobe areas={drawing || !histMode ? null : histAreas} markers={drawing ? EMPTY : histMode && histMarkers ? histMarkers : markers} focus={focus} selectedId={histMode && histMarkers ? histCell : picked && !drawing ? picked.id : null} onPick={pick}
          creditNote={histMode && histMarkers ? 'Historical observation records: NASA MODIS / VIIRS archive via Earth Engine' : ds ? 'Observations: LIVE API DATA' : ''}
          boundary={drawing ? drawnBox : sel.kind === 'world' ? null : sel.bbox} selPoint={drawing || histMode ? null : sel.point || null}
          drawMode={drawing && drawTool === 'draw'} onGlobeClick={showCard ? onGlobeClick : undefined} onBox={setDrawnBox} viewShift={viewShift} />
      </div>
      <Header dataState={ds ? 'live' : 'none'} gee={geeChip} away={drawing} />
      <main className="stage">
        <div ref={cardRef} className={'card-wrap' + (showCard ? '' : ' away') + (docked ? ' docked' : '')} aria-hidden={!showCard}>
          <SearchPanel form={form} setForm={setForm} errors={formErrors} onSearch={onSearch}
            onCancelLoading={cancel} onClose={ds && !histMode ? closeMenu : null}
            loading={state.phase === 'loading'} fetchError={state.phase === 'error' ? state.error : null}
            onRetry={() => query && apply(query, { force: true })} backend={backend} onRecheck={recheck}
            geo={{ selection: sel, onSelect: selectArea, onWorld: () => resetGeo(true), onClear: () => resetGeo(false), onDraw: openDraw }}
            mode={mode} onMode={switchMode} hform={hform} setHform={setHform} onAnalyse={onAnalyse}
            onHide={() => setMenuHidden(true)}
            historyView={<HistoricalIntelligence query={hq} label={hq?.label} pickedCell={histCell} onMarkers={setHistMarkers} onCells={setHistCells} tiers={histTiers} onTier={onTier} />} />
        </div>
        {histMode && !drawing && !showCard && <button className="hist-show" onClick={() => setMenuHidden(false)}>Show menu</button>}
        {ds && (
          <aside ref={sideRef} className={'side' + (sideVisible ? '' : ' away')} aria-hidden={!sideVisible}>
            <div className="panel side-top">
              <div><b>{query.bbox.join(', ')}</b> <span className="muted">(W, S, E, N)</span><div className="muted">{query.start} to {query.end}</div></div>
              <div className="filter-row"><span className="muted">Satellite</span><SatToggle value={view.sat} onChange={(sat) => changeView({ sat })} /></div>
              <div className="filter-row"><span className="muted">Matching</span><SatToggle label="Matching" value={view.match} onChange={(match) => changeView({ match })} options={MATCH_OPTIONS} /></div>
              <div className="side-actions">
                <button onClick={() => { setEditing(true); setFormErrors([]); }}>Change region / dates</button>
                <button onClick={() => apply(query, { force: true })} title="Request fresh data from the backend">Refresh</button>
              </div>
            </div>
            {ds.observations.length === 0 && (
              <div className="panel notice"><b>No observation records returned.</b> {ds.message}
                {emptyCoverage.map((c) => <div key={c} className="muted">{c}</div>)}
                <div className="muted">Try another date range or region. The Earth Engine copy can lag real time.</div></div>
            )}
            {ds.observations.length > 0 && dayObs.length === 0 && <div className="panel notice">No records match the current satellite / matching filters.</div>}
            {ds.truncated.observations && <div className="panel notice">The API listed only the first {LIMITS.maxDetails} records per source (API totals: MODIS {ds.apiCounts.modis ?? '—'}, VIIRS {ds.apiCounts.viirs ?? '—'}). Narrow the query to see all records.</div>}
            {ds.observations.length > 0 && markers.length === 0 && dayObs.length > 0 && <div className="panel notice">The records in view have no valid coordinates, so nothing can be drawn on the globe.</div>}
            {ds.observations.length > 0 && (
              <FireCalendar month={month || query.start.slice(0, 7)} onMonth={setMonth} counts={counts} range={query} selected={selectedDate} partial={ds.truncated.observations}
                onSelect={(d) => { setPickedId(null); setSelectedDate((s) => (s === d ? null : d)); }} />
            )}
            <StatsPanel stats={stats} scopeLabel={scopeLabel} ds={ds} reconciliation={reconciliation} />
            {ds.observations.length > 0 && (
              <ObservationDetails ds={ds} observations={dayObs} range={query} selectedDate={selectedDate}
                selectedId={picked ? picked.id : null} onPick={pick} onClear={() => setSelectedDate(null)} />
            )}
            <DataStatus backend={backend} fetchState={state} geeConnected={geeChip === 'connected'} />
          </aside>
        )}
      </main>
      <DrawBar open={drawing} box={drawnBox} tool={drawTool} onTool={setDrawTool} onRedo={() => setDrawnBox(null)} onCancel={cancelDraw} onOk={confirmDraw} />
      <div className={'info-bar' + (drawing ? ' away' : '')}>
        {histMode ? (
          <>
            <div className="ib-head"><b>{histMarkers ? histMarkers.length : 0}</b><span>historical observation record{histMarkers && histMarkers.length === 1 ? '' : 's'} drawn</span></div>
            <div className="ib-scope muted">{histMarkers ? 'Each dot is one observation record (a 1 km cell on one day with a fire detection). Click one for its date and FRP.' : hq ? 'Loading observation records for the analysed area…' : 'Choose an area and period, then press Analyse history.'}</div>
            <div className="legend" aria-label="Hotspot legend">
              <span><i className="mk mk-modis unmatched" /> MODIS only</span>
              <span><i className="mk mk-viirs unmatched" /> VIIRS only</span>
              <span><i className="mk mk-modis candidate" /> <i className="mk mk-viirs candidate" /> Recorded by both (same day, within 1 km)</span>
            </div>
          </>
        ) : ds && state.phase === 'success' ? (
          <>
            <div className="ib-head"><b key={markers.length}>{markers.length}</b><span>observation record{markers.length === 1 ? '' : 's'} drawn</span></div>
            <div className="ib-scope muted">{scopeLabel}</div>
          </>
        ) : <span className="caption">{caption}</span>}
        {!histMode && <Legend showUnknown={markers.some((m) => m.category.endsWith('unknown'))} />}
      </div>
    </div>
  );
}