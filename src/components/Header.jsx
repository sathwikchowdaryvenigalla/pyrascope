// dataState: 'none' (nothing loaded) | 'live' (displaying records returned by the backend)
export default function Header({ dataState, gee, away = false }) {
  const geeLabel = gee === 'connected' ? 'Earth Engine: connected' : gee === 'checking' ? 'Earth Engine: checking…' : gee === 'backend-down' ? 'Backend: unreachable' : 'Earth Engine: not connected';
  return (
    <header className={'header' + (away ? ' away' : '')} aria-hidden={away}>
      <div className="brand">
        <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="13" fill="none" stroke="#D62839" strokeWidth="3" />
          <circle cx="16" cy="16" r="5" fill="#D62839" />
        </svg>
        <div>
          <h1>PyraScope</h1>
          <p>One Earth. Two Satellites. A Clearer View of Fire.</p>
        </div>
      </div>
      <div className="indicators">
        <span className={'chip status-' + (gee === 'connected' ? 'ok' : gee === 'checking' ? 'wait' : 'bad')}><i className="dot" />{geeLabel}</span>
        <span className="chip sat"><i className="mk mk-modis" />MODIS</span>
        <span className="chip sat"><i className="mk mk-viirs" />VIIRS</span>
        {dataState === 'live' && <span className="badge live" title="Records shown were returned by the PyraScope API from NASA FIRMS/LANCE via Google Earth Engine">LIVE API DATA</span>}
      </div>
    </header>
  );
}