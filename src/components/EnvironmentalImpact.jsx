import { useEffect, useState } from 'react';
import { fireApi } from '../services/fireApi.js';
import { confidenceText } from '../services/transform.js';

const NA = (why) => <span className="muted">— {why}</span>;
const ICON = { vegetation: '🌿', habitat: '🌲', air_quality: '💨', soil: '🪨', settlements: '🏘', burned_area: '🔥' };
const BADGE = {
  estimated: ['Estimated', 'ei-est'], confirmed: ['Confirmed by supporting data', 'ei-conf'],
  insufficient: ['Insufficient evidence', 'ei-ins'], unavailable: ['Unavailable', 'ei-na'], none: ['No evidence', 'ei-ins'],
};
const badgeOf = (s) => (s.status === 'unavailable' ? BADGE.unavailable : s.status === 'insufficient' ? BADGE.insufficient : BADGE[s.evidence] || BADGE.none);

function Item({ s }) {
  const [label, cls] = badgeOf(s);
  const sources = s.sources.map((x) => x.name + (x.resolution ? ` · ${x.resolution}` : '')).join(' · ');
  return (
    <div className="ei-item">
      <div className="ei-item-head"><span className="ei-ico" aria-hidden="true">{ICON[s.id]}</span><b>{s.title}</b><span className={'ei-badge ' + cls}>{label}</span></div>
      <p className="ei-line">{s.headline}</p>
      {s.status === 'unavailable' && s.reason && <p className="ei-reason">{s.reason}</p>}
      {s.facts.length > 0 && <dl className="ei-facts">{s.facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>}
      {sources && <p className="ei-src">Source: {sources}</p>}
      {s.limitations.length > 0 && <details className="ei-lim"><summary>Limitations</summary><ul>{s.limitations.map((l) => <li key={l}>{l}</li>)}</ul></details>}
    </div>
  );
}

export default function EnvironmentalImpact({ o, matchLabel }) {
  const [st, setSt] = useState({ phase: 'idle' });
  const [tries, setTries] = useState(0);
  const canQuery = o.hasCoords && !!o.date;
  useEffect(() => {
    setSt({ phase: 'idle' });
    if (!canQuery) return undefined;
    const ctrl = new AbortController();
    setSt({ phase: 'loading' });
    fireApi.impact(o, { signal: ctrl.signal })
      .then((data) => setSt({ phase: 'ok', data }))
      .catch((e) => e.kind !== 'aborted' && setSt({ phase: 'error', error: e }));
    return () => ctrl.abort();
  }, [o.id, tries]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = st.data;
  const cls = o.source === 'MODIS';
  return (
    <div className="ei">
      <h3>Environmental Impact Assessment</h3>

      <div className="ei-tier"><span className="ei-badge ei-obs">Observed</span><span className="muted">Satellite detection, not damage</span></div>
      <dl className="ei-facts ei-obs-grid">
        <div><dt>Satellite · instrument</dt><dd>{[o.platform, o.instrument].filter(Boolean).join(' · ') || NA('not provided')}</dd></div>
        <div><dt>Location</dt><dd>{o.hasCoords ? `${o.latitude.toFixed(5)}°, ${o.longitude.toFixed(5)}°` : NA('not provided')}</dd></div>
        <div><dt>Acquired (UTC)</dt><dd>{o.timeUtc || (o.date ? `${o.date} (date only)` : NA('not provided'))}</dd></div>
        <div><dt>FRP</dt><dd>{o.frpMw !== null ? `${o.frpMw} MW` : NA(cls ? 'not in MODIS FIRMS dataset' : 'not provided')}</dd></div>
        <div><dt>Confidence</dt><dd>{confidenceText(o) || NA('not provided')}</dd></div>
        <div><dt>Day / night</dt><dd>{o.dayNight || NA('not provided')}</dd></div>
        <div><dt>Matching status</dt><dd>{matchLabel}</dd></div>
      </dl>

      {!canQuery && <p className="ei-reason">Data unavailable — this observation has no valid coordinates or date, so no environmental data can be queried.</p>}
      {st.phase === 'loading' && <p className="hint">Querying environmental datasets… (can take up to a minute)</p>}
      {st.phase === 'error' && (
        <p className="ei-reason">Data unavailable — additional environmental data required. {st.error.message} {st.error.hint || ''}{' '}
          <button className="link" onClick={() => setTries((n) => n + 1)}>Retry</button></p>
      )}

      {d && (
        <>
          <div className="ei-assess"><b>{d.assessment.category}</b><span className="muted">{d.assessment.detail}</span>
            <span className="muted">Evidence availability: {d.assessment.evidence_availability.datasets_returning_data} of {d.assessment.evidence_availability.datasets_queried} environmental datasets returned data{d.served_from_cache ? ' (cached)' : ''}. This is not a damage score.</span></div>
          {!d.earth_engine.available && <p className="ei-reason">Earth Engine unavailable: {d.earth_engine.message}</p>}

          <div className="ei-tier"><span className="ei-badge ei-est">Estimated</span><span className="muted">Exposure near the detection, not damage that occurred</span></div>
          {d.estimated.map((s) => <Item key={s.id} s={s} />)}

          <div className="ei-tier"><span className="ei-badge ei-conf">Confirmed</span><span className="muted">Only from an independent burned-area dataset</span></div>
          <Item s={d.confirmed} />

          <details className="ei-lim ei-global"><summary>Assessment limitations</summary><ul>{d.limitations.map((l) => <li key={l}>{l}</li>)}</ul></details>
        </>
      )}
    </div>
  );
}
