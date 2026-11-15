import { bboxRetrievable } from '../services/geo.js';
import { LIMITS } from '../config.js';

// Floating controls shown while the globe is in "draw a box" mode (everything else is hidden).
export default function DrawBar({ open, box, tool, onTool, onRedo, onCancel, onOk }) {
  const r = box ? bboxRetrievable(box) : null;
  return (
    <div className={'draw-bar' + (open ? '' : ' away')} role="region" aria-label="Draw a region" aria-hidden={!open}>
      <div className="seg" role="group" aria-label="Globe tool">
        <button type="button" aria-pressed={tool === 'draw'} onClick={() => onTool('draw')}>Draw</button>
        <button type="button" aria-pressed={tool === 'rotate'} onClick={() => onTool('rotate')}>Rotate</button>
      </div>
      <div className="draw-msg">
        {!box && (tool === 'draw' ? 'Drag across the globe to draw a rectangle.' : 'Rotate the globe, then switch back to Draw.')}
        {box && <><b>{r.w}° × {r.h}°</b><span className="muted"> · {box.join(', ')}</span>
          {!r.ok && <div className="geo-warn">Each side must be ≤ {LIMITS.maxBboxDegrees}°.</div>}</>}
      </div>
      {box && <button type="button" onClick={onRedo}>Redraw</button>}
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="button" className="primary" disabled={!box || !r.ok} onClick={onOk}>OK</button>
    </div>
  );
}
