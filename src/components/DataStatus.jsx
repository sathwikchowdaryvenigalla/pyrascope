const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function sourceLine(name, ds, phase) {
  if (phase === 'loading') return 'retrieving…';
  if (phase === 'error') return 'not retrieved (request failed)';
  if (!ds) return 'not requested yet';
  const a = ds.availability?.[name];
  const n = name === 'MODIS' ? ds.apiCounts.modis : ds.apiCounts.viirs;
  if (!a) return `${n ?? '—'} observation record(s)`;
  const base = `${a.dataset_id ? `${a.dataset_id} · ` : ''}${n ?? 0} observation record(s) from ${a.fire_pixels_retrieved ?? '—'} fire pixel(s) in ${a.matching_images ?? '—'} daily image(s)`;
  const flag = a.complete === false ? ' · INCOMPLETE retrieval' : a.fire_pixels_retrieved === 0 ? ' · no fire pixels in this query' : ' · complete';
  return base + flag;
}

export default function DataStatus({ backend, fetchState, geeConnected }) {
  const { phase, dataset: ds, fetchedAt, fromClientCache, summaryError } = fetchState;
  const live = phase === 'success' && !!ds;
  const geeText = geeConnected ? 'connected (a query succeeded)'
    : backend.phase === 'unreachable' ? 'unknown (backend unreachable)'
    : backend.phase === 'checking' ? 'checking…'
    : backend.gee?.earth_engine_initialized ? 'initialised' : 'not initialised';
  return (
    <section className="panel data-status">
      <div className="panel-head"><h2>Data source &amp; status</h2></div>
      <dl className="meta wide">
        <dt>Origin</dt><dd>{live ? <b>LIVE API DATA</b> : 'No data loaded'}{live && <span className="muted"> · NASA FIRMS/LANCE (MODIS) and LANCE VIIRS 375 m, via Google Earth Engine; near-real-time, not science quality</span>}</dd>
        <dt>Earth Engine</dt><dd>{geeText}</dd>
        <dt>MODIS</dt><dd>{sourceLine('MODIS', ds, phase)}</dd>
        <dt>VIIRS</dt><dd>{sourceLine('VIIRS', ds, phase)}</dd>
        <dt>Last fetch</dt>
        <dd>{live ? <>{fmt(fetchedAt)}{ds.retrievedAtUtc && <span className="muted"> · backend retrieval {fmt(ds.retrievedAtUtc)}{ds.servedFromCache && (ds.servedFromCache.MODIS || ds.servedFromCache.VIIRS) ? ' (backend cache)' : ''}</span>}{fromClientCache && <span className="muted"> · reused in this browser session</span>}</> : '—'}</dd>
      </dl>
      {summaryError && <p className="note warn">Summary endpoint failed ({summaryError.message}); counts come from the compare endpoint only.</p>}
      {live && ds.warnings.map((w) => <p key={w} className="note warn">{w}</p>)}
      {live && ds.invalidRecords > 0 && <p className="note warn">{ds.invalidRecords} record(s) in the response were malformed and skipped.</p>}
    </section>
  );
}
