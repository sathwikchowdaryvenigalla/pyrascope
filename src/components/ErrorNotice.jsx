export default function ErrorNotice({ error, onRetry, retryLabel = 'Retry' }) {
  if (!error) return null;
  return (
    <div role="alert" className="msg error">
      <b>{error.kind === 'network' ? 'Backend unreachable' : error.kind === 'timeout' ? 'Request timed out' : 'Request failed'}</b>
      {error.code && <span className="muted"> [{error.code}{error.status ? ` · HTTP ${error.status}` : ''}]</span>}
      <div>{error.message}</div>
      {error.hint && <div className="muted">{error.hint}</div>}
      {onRetry && <button type="button" className="secondary" onClick={onRetry} style={{ marginTop: 6 }}>{retryLabel}</button>}
    </div>
  );
}
