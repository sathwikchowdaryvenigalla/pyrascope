import { CATEGORIES } from '../services/transform.js';

export default function Legend({ showUnknown }) {
  return (
    <div className="legend" aria-label="Legend">
      {CATEGORIES.map((c) => (
        <span key={c.key}><i className={`mk mk-${c.source.toLowerCase()} ${c.status}`} /> {c.label}</span>
      ))}
      {showUnknown && <span><i className="mk mk-modis unknown" /> status unknown (partial list)</span>}
    </div>
  );
}
