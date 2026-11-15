// Observation-RECORD counts per acquisition date (not unique fires).
export default function FireCalendar({ month, onMonth, counts, range, selected, onSelect, partial }) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shift = (d) => {
    const dt = new Date(Date.UTC(y, m - 1 + d, 1));
    onMonth(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`);
  };
  const canPrev = month > range.start.slice(0, 7);
  const canNext = month < range.end.slice(0, 7);
  const max = Math.max(1, ...Object.values(counts).map((c) => c.total));
  const level = (n) => (n <= 0 ? 0 : n <= max / 3 ? 1 : n <= (2 * max) / 3 ? 2 : 3);
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const sel = selected ? counts[selected] : null;

  return (
    <section className="panel">
      <div className="panel-head">
        <button className="icon" onClick={() => shift(-1)} disabled={!canPrev} aria-label="Previous month">‹</button>
        <h2>Burning activity · {label}</h2>
        <button className="icon" onClick={() => shift(1)} disabled={!canNext} aria-label="Next month">›</button>
      </div>
      <div className="cal">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="dow">{d}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={i} />;
          const date = `${month}-${String(d).padStart(2, '0')}`;
          const inRange = date >= range.start && date <= range.end;
          const c = counts[date];
          const n = c ? c.total : 0;
          const title = !inRange ? 'Outside the retrieved date range' : c
            ? `${date}: MODIS ${c.modis} · VIIRS ${c.viirs} · total ${c.total} observation records · ${c.pairs} candidate pair(s)`
            : `${date}: no observation records returned`;
          return (
            <button key={i} disabled={!inRange || n === 0} className={`day lv${level(n)}` + (selected === date ? ' sel' : '')}
              onClick={() => onSelect(date)} title={title} aria-label={title}>
              {d}{n > 0 && <small>{n}</small>}
            </button>
          );
        })}
      </div>
      {sel && (
        <div className="day-detail" role="status">
          <b>{selected}</b> · MODIS {sel.modis} · VIIRS {sel.viirs} · total {sel.total} records · {sel.pairs} candidate pair(s)
        </div>
      )}
      <div className="cal-key"><span>Records/day:</span><i className="sw lv1" />low<i className="sw lv2" />mid<i className="sw lv3" />high
        <span className="muted">(relative to the busiest day; the number is the record count)</span></div>
      <p className="note">Counts are observation records from the API, not unique fires.{partial ? ' The API listed only part of the records, so these counts are incomplete.' : ''}</p>
    </section>
  );
}
