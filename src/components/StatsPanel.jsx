export default function StatsPanel({ stats, scopeLabel, ds, reconciliation }) {
  const tiles = [
    ['MODIS observation records', stats.modis],
    ['VIIRS observation records', stats.viirs],
    ['Total observation records', stats.total],
    ['Candidate matches (MODIS–VIIRS pairs)', stats.candidatePairs],
    ['Unmatched MODIS observations', stats.unmatchedModis],
    ['Unmatched VIIRS observations', stats.unmatchedViirs],
  ];
  const partial = ds.truncated.observations || ds.truncated.pairs || ds.truncated.unmatched;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Statistics</h2><span className="muted">{scopeLabel}</span></div>
      <div className="stat-grid">
        {tiles.map(([label, v]) => <div key={label}><b>{v}</b><span>{label}</span></div>)}
      </div>
      {stats.unknownStatus > 0 && <p className="note">{stats.unknownStatus} record(s) have unknown matching status because the API's match list was truncated.</p>}
      {stats.withoutCoordinates > 0 && <p className="note">{stats.withoutCoordinates} record(s) have no valid coordinates: counted, but not drawn and not matched.</p>}
      {partial && <p className="note warn">The API response was truncated (limit per request). Counts here cover only the returned records; API totals: MODIS {ds.apiCounts.modis ?? '—'}, VIIRS {ds.apiCounts.viirs ?? '—'}, candidate pairs {ds.apiCounts.candidatePairs ?? '—'}.</p>}
      {reconciliation && <p className={'note ' + (reconciliation.ok ? '' : 'warn')}>{reconciliation.ok ? 'Totals agree across compare and summary endpoints.' : 'Totals do not agree across endpoints.'} <span className="muted">({reconciliation.detail})</span></p>}
      <p className="note">
        These are observation <b>records</b>, not unique fires. A candidate match is only a potential relationship (close in space and date), not a confirmed same-fire detection.
        {!ds.temporalMatchingAvailable && ' Temporal matching is unavailable: MODIS in Earth Engine has no acquisition time.'}
        {' '}Unique fire events: not determined.
      </p>
    </section>
  );
}
