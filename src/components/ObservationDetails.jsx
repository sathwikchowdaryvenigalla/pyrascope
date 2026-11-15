import { confidenceText } from '../services/transform.js';
import EnvironmentalImpact from './EnvironmentalImpact.jsx';

const CAP = 200;
const NA = (why) => <span className="muted">— {why}</span>;
const STATUS = {
  candidate: 'Candidate match (potential relationship only)',
  unmatched: 'No candidate within thresholds',
  unknown: 'Unknown (API match list was truncated)',
  not_evaluated: 'Not evaluated (no valid coordinates)',
};

function fields(o, ds) {
  const partners = ds.pairsByObs.get(o.id) || [];
  const cls = o.source === 'MODIS';
  return [
    ['Latitude', o.hasCoords ? `${o.latitude.toFixed(5)}°` : NA('not provided')],
    ['Longitude', o.hasCoords ? `${o.longitude.toFixed(5)}°` : NA('not provided')],
    ['Acquisition date', o.date || NA('not provided')],
    ['Acquisition time (UTC)', o.timeUtc || NA(cls ? 'MODIS FIRMS in Earth Engine has only a daily image date' : 'not provided')],
    ['Satellite', o.platform || NA('not provided')],
    ['Instrument', o.instrument],
    ['Confidence', confidenceText(o) || NA('not provided')],
    ['FRP', o.frpMw !== null ? `${o.frpMw} MW` : NA(cls ? 'not available in the MODIS FIRMS dataset' : 'not provided')],
    ...o.brightness.map((b) => [b.label, b.kelvin !== null ? `${b.kelvin} K` : NA('not provided')]),
    ['Day / night', o.dayNight || NA(cls ? 'not provided by MODIS FIRMS in Earth Engine' : 'not provided')],
    ['Source dataset', ds.availability?.[o.source]?.dataset_id || NA('not provided')],
    ['Source image', o.imageId ? `${o.imageId}${o.imageDate ? ` (${o.imageDate})` : ''}` : NA('not provided')],
    ['Coordinate method', o.coordinateMethod ? `${o.coordinateMethod}${o.pixelCount ? ` · ${o.pixelCount} px` : ''}` : NA('not provided')],
    ['Matching status', STATUS[o.matchStatus] || o.matchStatus],
    ['Candidate partners', partners.length ? `${partners.length}` : NA('none')],
  ];
}

export default function ObservationDetails({ ds, observations, range, selectedDate, selectedId, onPick, onClear }) {
  const sorted = [...observations].sort((a, b) => `${a.date || ''}${a.timeUtc || ''}${a.id}`.localeCompare(`${b.date || ''}${b.timeUtc || ''}${b.id}`));
  const shown = sorted.slice(0, CAP);
  const chosen = ds.byId.get(selectedId) || null;
  const partners = chosen ? (ds.pairsByObs.get(chosen.id) || []).slice(0, 5) : [];
  return (
    <section className="panel">
      <div className="panel-head"><h2>Observation details</h2></div>
      <dl className="meta">
        <dt>Region</dt><dd>{range.bbox.join(', ')} <span className="muted">(W, S, E, N)</span></dd>
        <dt>Date</dt>
        <dd>{selectedDate || `${range.start} to ${range.end} (full range)`} {selectedDate && <button className="link" onClick={onClear}>Show full range</button>}</dd>
      </dl>
      {!selectedDate && <p className="hint">Select a highlighted date in the calendar for a single-day view.</p>}
      {sorted.length === 0 ? <p className="hint">No observation records match the current filters.</p> : (
        <>
          <p className="hint">Click a row (or a marker on the globe) to zoom to it and see all its fields.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Instrument</th>{!selectedDate && <th>Date</th>}<th>Time (UTC)</th><th>Matching</th><th>FRP (MW)</th></tr></thead>
              <tbody>
                {shown.map((o) => (
                  <tr key={o.id} tabIndex={0} className={'row' + (chosen && chosen.id === o.id ? ' picked' : '')}
                    onClick={() => onPick(o.id === selectedId ? null : o.id)} onKeyDown={(e) => e.key === 'Enter' && onPick(o.id === selectedId ? null : o.id)}>
                    <td><i className={'mk mk-' + o.source.toLowerCase()} /> {o.instrument}</td>
                    {!selectedDate && <td>{o.date || '—'}</td>}
                    <td>{o.timeUtc ? o.timeUtc.slice(11, 16) : '—'}</td>
                    <td>{o.matchStatus === 'candidate' ? 'candidate' : o.matchStatus === 'unmatched' ? 'none' : o.matchStatus === 'unknown' ? 'unknown' : 'n/a'}</td>
                    <td>{o.frpMw !== null ? o.frpMw : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {sorted.length > CAP && <p className="hint">Showing the first {CAP} of {sorted.length} records. Select a date to narrow the list.</p>}
      {chosen && (
        <div className="record">
          <h3>Record fields <button className="link" onClick={() => onPick(null)}>Clear selection</button></h3>
          <dl>
            {fields(chosen, ds).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          {partners.length > 0 && (
            <div className="partners">
              <b>Candidate partners (nearest first is not guaranteed; showing up to 5)</b>
              {partners.map((p) => (
                <button key={p.partnerId} type="button" className="link" onClick={() => ds.byId.has(p.partnerId) && onPick(p.partnerId)}>
                  {p.partnerId.split(':')[0]} · {p.distanceKm ?? '—'} km{p.temporalPossible ? '' : ' · no time comparison'}
                </button>
              ))}
            </div>
          )}
          <p className="note">MODIS and VIIRS brightness values come from different channels and sensors; they are shown under their original band names and are not interchangeable. Confidence scales also differ (MODIS 0–100 %, VIIRS low/nominal/high).</p>
        </div>
      )}
      {chosen && <EnvironmentalImpact key={chosen.id} o={chosen} matchLabel={STATUS[chosen.matchStatus] || chosen.matchStatus} />}
      <p className="note">Records are counted as individual observations. Nearby MODIS and VIIRS records may describe the same fire and are not treated as separate fires.</p>
    </section>
  );
}
