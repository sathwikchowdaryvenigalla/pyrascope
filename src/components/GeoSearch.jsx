import { useEffect, useMemo, useRef, useState } from 'react';
import { bboxRetrievable, fmtCoord, matchContinents, parseCoordinates, searchPlaces } from '../services/geo.js';
import { LIMITS } from '../config.js';

// Region picker that lives INSIDE the retrieval menu: autocomplete search, worldwide / draw / clear controls and the
// selected-region summary. Pure UI: all state lives in App.
export default function GeoSearch({ selection, onSelect, onWorld, onClear, onDraw }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState({ items: [], loading: false, error: null });
  const [active, setActive] = useState(-1);
  const boxRef = useRef(null);

  const local = useMemo(() => {
    const c = parseCoordinates(q);
    return [...(c ? [c] : []), ...matchContinents(q)];
  }, [q]);

  useEffect(() => { // debounced type-ahead; cancels the previous request
    const t = q.trim();
    if (t.length < 3 || parseCoordinates(t)) { setRemote({ items: [], loading: false, error: null }); return undefined; }
    const ctrl = new AbortController();
    setRemote((r) => ({ ...r, loading: true, error: null }));
    const id = setTimeout(async () => {
      try { setRemote({ items: await searchPlaces(t, { signal: ctrl.signal }), loading: false, error: null }); }
      catch (e) { if (e.name !== 'AbortError') setRemote({ items: [], loading: false, error: 'Place search is unavailable right now. Coordinates, continents and the globe still work.' }); }
    }, 350);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [q]);

  useEffect(() => {
    const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, []);

  const items = [...local, ...remote.items];
  const choose = (s) => { setQ(''); setOpen(false); setActive(-1); onSelect(s); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const s = items[active >= 0 ? active : 0]; if (s) choose(s); }
    else if (e.key === 'Escape') setOpen(false);
  };

  const has = selection && selection.kind !== 'world';
  const r = has ? bboxRetrievable(selection.bbox) : null;
  const showList = open && q.trim().length >= 2;

  return (
    <div className="geo" ref={boxRef}>
      <div className="geo-input">
        <input type="search" value={q} placeholder="Search a country, state, city, or “lat, lon”" aria-label="Search places or coordinates"
          role="combobox" aria-expanded={showList} aria-autocomplete="list"
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(-1); }} onFocus={() => setOpen(true)} onKeyDown={onKey} />
        <div className={'geo-list-wrap' + (showList ? ' open' : '')}>
          <ul className="geo-list" role="listbox">
            {items.map((s, i) => (
              <li key={`${s.kind}-${s.label}-${i}`} role="option" aria-selected={i === active}
                className={i === active ? 'on' : ''} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); choose(s); }}>
                <span>{s.label}</span><span className="muted">{s.level}</span>
              </li>
            ))}
            {remote.loading && <li className="geo-note muted">Searching…</li>}
            {!remote.loading && items.length === 0 && !remote.error && <li className="geo-note muted">No matches. Try “lat, lon” (e.g. 21.5, 78.9).</li>}
            {remote.error && <li className="geo-note muted">{remote.error}</li>}
          </ul>
        </div>
      </div>
      <div className="geo-actions">
        <button type="button" onClick={onDraw} title="Open the globe and drag a rectangle">Draw on globe</button>
        <button type="button" onClick={onWorld} title="Return to the worldwide view">Worldwide</button>
        {has && <button type="button" className="geo-clear" onClick={onClear}>Clear</button>}
      </div>
      <p className="hint">Tip: you can also click the globe to pick a point.</p>
      {has && (
        <div className="geo-selected" role="status">
          <div><b>{selection.label}</b> <span className="muted">· {selection.level}</span></div>
          <div className="muted">
            {selection.point ? `${fmtCoord(selection.point.lat, selection.point.lon)} · ` : ''}{selection.bbox.join(', ')} (W, S, E, N)
          </div>
          {r && !r.ok && <div className="geo-warn">{r.w}° × {r.h}° exceeds the {LIMITS.maxBboxDegrees}° retrieval limit. It is outlined on the globe; click a spot or draw a smaller box to load fire data.</div>}
        </div>
      )}
    </div>
  );
}
