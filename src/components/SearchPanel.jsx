import { useState } from 'react';
import { REGIONS, LIMITS } from '../config.js';
import ErrorNotice from './ErrorNotice.jsx';
import GeoSearch from './GeoSearch.jsx';
import { WORLD, bboxRetrievable } from '../services/geo.js';
import { HISTORY_RANGES } from '../services/historyApi.js';

const noop = () => {};
const NO_GEO = { selection: WORLD, onSelect: noop, onWorld: noop, onClear: noop, onDraw: noop };

export default function SearchPanel({ form, setForm, errors, onSearch, onCancelLoading, onClose, loading, fetchError, onRetry, backend, onRecheck, geo = NO_GEO, mode = 'live', onMode = noop, hform, setHform = noop, onAnalyse = noop, historyView = null, onHide = null }) {
  const [boxOpen, setBoxOpen] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const custom = form.regionId === 'custom';
  const region = REGIONS.find((r) => r.id === form.regionId);
  const showBox = (i) => (custom ? form[['minLon', 'minLat', 'maxLon', 'maxLat'][i]] : region.bbox[i]);
  const boxKeys = ['minLon', 'minLat', 'maxLon', 'maxLat'];
  const boxLabels = ['Min longitude', 'Min latitude', 'Max longitude', 'Max latitude'];
  const sel = geo.selection;
  const hist = mode === 'history';
  const hf = hform || { range: '5y', cStart: '', cEnd: '' };
  const setH = (k) => (e) => setHform({ ...hf, [k]: e.target.value });
  // a too-large outline (country / continent) has no box to send: asking for data would only be refused
  const tooLarge = !hist && sel.kind !== 'world' && !bboxRetrievable(sel.bbox).ok && form.minLon === '';
  return (
    <form className={'search-card' + (loading ? ' busy' : '') + (hist ? ' hist-mode' : '')} aria-busy={loading} onSubmit={(e) => { e.preventDefault(); hist ? onAnalyse() : onSearch(); }}>
      <div className="mode-tabs seg" role="tablist" aria-label="Menu mode">
        <button type="button" role="tab" aria-selected={!hist} aria-pressed={!hist} onClick={() => onMode('live')}>Live observations</button>
        <button type="button" role="tab" aria-selected={hist} aria-pressed={hist} onClick={() => onMode('history')}>Historical intelligence</button>
      </div>
      {hist ? <>
        <h2>Historical fire intelligence</h2>
        <p className="hint">Uses the area chosen below with a long-term period. Trends, seasons, intensity and a hotspot grid are drawn from the MODIS / VIIRS archive via Earth Engine.</p>
      </> : <>
        <h2>Retrieve MODIS + VIIRS observations</h2>
        <p className="hint">Pick an area and a date range. Observations are fetched live from NASA FIRMS/LANCE data through Google Earth Engine; nothing is simulated.</p>
      </>}

      <GeoSearch {...geo} />

      <details className="bbox-details" open={boxOpen || errors.length > 0} onToggle={(e) => setBoxOpen(e.currentTarget.open)}>
        <summary>Presets &amp; bounding box</summary>
        <div className="bbox-body">
          <label className="field">Preset region
            <select value={form.regionId} onChange={(e) => {
              const r = REGIONS.find((x) => x.id === e.target.value);
              if (r.bbox) geo.onSelect({ kind: 'box', level: 'Preset region', label: r.name, bbox: r.bbox, presetId: r.id }, { focus: true });
              else setForm({ ...form, regionId: 'custom' });
            }}>
              {REGIONS.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <div className="two">
            {boxKeys.map((k, i) => (
              <label className="field" key={k}>{boxLabels[i]}
                <input type="number" step="any" value={showBox(i)} readOnly={!custom} onChange={set(k)} aria-label={boxLabels[i]} />
              </label>
            ))}
          </div>
          <p className="hint">Each side ≤ {hist ? 30 : LIMITS.maxBboxDegrees}°.</p>
        </div>
      </details>

      {!hist ? <>
        <div className="two">
          <label className="field">Start date<input type="date" value={form.start} onChange={set('start')} /></label>
          <label className="field">End date<input type="date" value={form.end} onChange={set('end')} /></label>
        </div>
        <p className="hint">Date range ≤ {LIMITS.maxDays} days.</p>
      </> : <>
        <label className="field">Time period
          <select value={hf.range} onChange={setH('range')} aria-label="Historical time period">{HISTORY_RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        {hf.range === 'custom' && <div className="two">
          <label className="field">From<input type="date" value={hf.cStart} max={hf.cEnd} onChange={setH('cStart')} /></label>
          <label className="field">To<input type="date" value={hf.cEnd} min={hf.cStart} onChange={setH('cEnd')} /></label>
        </div>}
        <p className="hint">Area up to 30° per side for history.</p>
      </>}
      {errors.length > 0 && <div role="alert" className="msg error">{errors.map((e) => <div key={e}>{e}</div>)}</div>}
      {!hist && fetchError && <ErrorNotice error={fetchError} onRetry={onRetry} />}
      {!hist && loading && <p className="msg empty" role="status">Retrieving from Google Earth Engine… this can take up to a minute for larger queries.</p>}
      {hist ? (
        <div className="actions">
          <button className="primary" type="submit">Analyse history</button>
          {onHide && <button type="button" onClick={onHide} title="Hide the menu to see the whole globe">Hide menu</button>}
          {onClose && <button type="button" onClick={onClose}>Close</button>}
        </div>
      ) : (
      <div className="actions">
        <button className={'primary' + (loading ? ' loading' : '')} type="submit" disabled={loading || tooLarge} title={tooLarge ? 'The selected area is too large to retrieve. Pick a smaller one.' : undefined}>{loading ? <>Retrieving<span className="dots" aria-hidden="true"><i /><i /><i /></span></> : 'Retrieve observations'}</button>
        {loading && <button type="button" onClick={onCancelLoading}>Cancel</button>}
        {onClose && !loading && <button type="button" onClick={onClose}>Close</button>}
      </div>
      )}
      {hist && historyView}
      <p className="hint backend-line">
        {backend.phase === 'checking' && 'Checking backend…'}
        {backend.phase === 'unreachable' && <>Backend unreachable. <button type="button" className="link" onClick={onRecheck}>Re-check</button></>}
        {backend.phase === 'reachable' && (backend.gee?.earth_engine_initialized
          ? `Backend reachable · Earth Engine initialised (project ${backend.gee.project_id || 'n/a'}).`
          : <>Backend reachable · Earth Engine NOT initialised{backend.gee?.error?.message ? `: ${backend.gee.error.message}` : ''}{backend.gee?.error?.hint ? ` ${backend.gee.error.hint}` : ''} <button type="button" className="link" onClick={onRecheck}>Re-check</button></>)}
      </p>
    </form>
  );
}
