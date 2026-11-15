// Small dependency-free SVG charts. Colour = sensor family (MODIS bright red, VIIRS deep red); hatched bars = source not available.
import { MONTHS } from '../services/historyAnalysis.js';

const C = { MODIS: '#FF5364', VIIRS: '#A91528', ALL: '#202124', A: '#D62839', B: '#3a6ea5' };
const W = 360, H = 150, P = { l: 38, r: 8, t: 8, b: 20 };
const nice = (m) => { if (m <= 0) return 1; const p = 10 ** Math.floor(Math.log10(m)); const f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
const short = (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : `${+v.toFixed(1)}`);

function Axes({ max, labels, step = 1 }) {
  return (
    <>
      {[0, 0.5, 1].map((f) => <g key={f}><line x1={P.l} x2={W - P.r} y1={H - P.b - f * (H - P.t - P.b)} y2={H - P.b - f * (H - P.t - P.b)} stroke="#DDE0E5" /><text x={P.l - 4} y={H - P.b - f * (H - P.t - P.b) + 3} fontSize="9" textAnchor="end" fill="#777">{short(max * f)}</text></g>)}
      {labels.map((l, i) => (i % step === 0 ? <text key={i} x={P.l + ((i + 0.5) * (W - P.l - P.r)) / labels.length} y={H - 6} fontSize="9" textAnchor="middle" fill="#777">{l}</text> : null))}
    </>
  );
}

/** Stacked bars per category: rows = [{label, parts:[{key, value|null}], unavailable:[keys], selected, onClick}] */
export function StackedBars({ rows, ariaLabel, onSelect, selected, keys = ['MODIS', 'VIIRS'] }) {
  const tot = rows.map((r) => r.parts.reduce((s, p) => s + (p.value || 0), 0));
  const max = nice(Math.max(1, ...tot)), bw = (W - P.l - P.r) / Math.max(1, rows.length);
  const step = Math.max(1, Math.ceil(rows.length / 9));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="hchart">
      <defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="#F7F8FA" /><line x1="0" y1="0" x2="0" y2="4" stroke="#b5b8bd" strokeWidth="1.5" /></pattern></defs>
      <Axes max={max} labels={rows.map((r) => r.label)} step={step} />
      {rows.map((r, i) => {
        let y = H - P.b;
        const x = P.l + i * bw + bw * 0.12, w = bw * 0.76, sel = selected === r.key;
        return (
          <g key={r.key} onClick={() => onSelect?.(r.key)} style={{ cursor: onSelect ? 'pointer' : 'default' }} tabIndex={onSelect ? 0 : undefined}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect?.(r.key)} aria-label={r.title}>
            <title>{r.title}</title>
            <rect x={P.l + i * bw} y={P.t} width={bw} height={H - P.t - P.b} fill={sel ? 'rgba(32,33,36,0.10)' : 'transparent'} />
            {r.unavailable?.length > 0 && <rect x={x} y={P.t} width={w} height={5} fill="url(#hatch)" stroke="#b5b8bd" strokeWidth=".5"><title>{`Not available: ${r.unavailable.join(', ')}`}</title></rect>}
            {r.parts.map((p) => { const h = ((p.value || 0) / max) * (H - P.t - P.b); y -= h; return h > 0 ? <rect key={p.key} x={x} y={y} width={w} height={h} fill={C[p.key]} /> : null; })}
          </g>
        );
      })}
      <g fontSize="9">{keys.map((k, i) => <g key={k} transform={`translate(${P.l + 6 + i * 60},${P.t + 8})`}><rect width="8" height="8" fill={C[k]} /><text x="11" y="8" fill="#555">{k}</text></g>)}</g>
    </svg>
  );
}

/** Lines over categories: series = [{key,label,color,values:[number|null]}] ; null = unavailable (gap, never zero). */
export function Lines({ labels, series, ariaLabel, unit = '' }) {
  const max = nice(Math.max(1, ...series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined))));
  const x = (i) => P.l + ((i + 0.5) * (W - P.l - P.r)) / labels.length, y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const step = Math.max(1, Math.ceil(labels.length / 9));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} className="hchart">
      <Axes max={max} labels={labels} step={step} />
      {series.map((s, si) => {
        const segs = []; let cur = [];
        s.values.forEach((v, i) => { if (v === null || v === undefined) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v), v, i]); });
        if (cur.length) segs.push(cur);
        return (
          <g key={s.key}>
            {segs.map((seg, k) => <polyline key={k} points={seg.map((p) => `${p[0]},${p[1]}`).join(' ')} fill="none" stroke={s.color} strokeWidth="1.8" strokeDasharray={s.dash} />)}
            {segs.flat().map((p) => <circle key={p[3]} cx={p[0]} cy={p[1]} r="2.2" fill={s.color}><title>{`${labels[p[3]]} · ${s.label}: ${+p[2].toFixed(1)}${unit}`}</title></circle>)}
            <g transform={`translate(${P.l + 6 + si * 78},${P.t + 8})`} fontSize="9"><rect width="8" height="3" y="3" fill={s.color} /><text x="11" y="8" fill="#555">{s.label}</text></g>
          </g>
        );
      })}
    </svg>
  );
}

export const monthLabels = MONTHS;
export const COLORS = C;
