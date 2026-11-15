// "Card splits into sections" transition, played when retrieved data arrives.
//   1. a frosted ghost of the centred menu card glides to the side column,
//   2. it splits into one slice per section, which slide apart into the real panel positions,
//   3. the real panels fade in as the slices fade out.
// Pure Web Animations API on throw-away ghost elements: no React state, nothing to clean up on failure.
const EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
const SOFT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const T_MOVE = 520, T_SPLIT = 600, STAGGER = 50;

const px = (r) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

export function playSplit(card, side, host) {
  if (!card || !side || !host || !side.animate) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const stage = host.querySelector('.stage');
  const hdr = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hdr')) || 56;

  // The card is centred in the stage (below the header); offset sizes ignore its hide-transform.
  const w = card.offsetWidth, h = card.offsetHeight;
  const from = { left: (window.innerWidth - w) / 2, top: hdr + (window.innerHeight - hdr - h) / 2, width: w, height: h };

  const sr = side.getBoundingClientRect();
  const parts = [...side.children].map((el) => {
    const r = el.getBoundingClientRect();
    const top = Math.max(r.top, sr.top), bottom = Math.min(r.bottom, sr.bottom);
    return { el, left: r.left, width: r.width, top, height: bottom - top };
  });
  const vis = parts.filter((p) => p.height > 4);
  if (!vis.length) return;
  const colTop = vis[0].top, colH = vis[vis.length - 1].top + vis[vis.length - 1].height - colTop;
  const col = { left: vis[0].left, top: colTop, width: vis[0].width, height: colH };

  // real panels stay invisible until the slices arrive, then fade up
  parts.forEach((p) => {
    const i = Math.max(0, vis.indexOf(p));
    p.el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { duration: 380, delay: T_MOVE + T_SPLIT * 0.45 + i * STAGGER, easing: SOFT, fill: 'backwards' });
  });

  const mk = (rect, radius) => {
    const g = document.createElement('div');
    g.className = 'ghost';
    Object.assign(g.style, px(rect), { borderRadius: radius });
    host.insertBefore(g, stage);
    return g;
  };

  const ghost = mk(from, '26px');
  const a = ghost.animate([{ ...px(from), borderRadius: '26px' }, { ...px(col), borderRadius: '20px' }],
    { duration: T_MOVE, easing: EASE, fill: 'forwards' });
  a.onfinish = () => {
    ghost.remove();
    const sumH = vis.reduce((s, p) => s + p.height, 0);
    let y = col.top;
    vis.forEach((p, i) => {
      const sh = (col.height * p.height) / sumH;
      const slice = { left: col.left, top: y, width: col.width, height: sh };
      y += sh;
      const n = vis.length;
      const r0 = n === 1 ? '20px' : i === 0 ? '20px 20px 0 0' : i === n - 1 ? '0 0 20px 20px' : '0px';
      const g = mk(slice, r0);
      const done = { left: p.left, top: p.top, width: p.width, height: p.height };
      g.animate([
        { ...px(slice), borderRadius: r0, opacity: 1, offset: 0 },
        { ...px(done), borderRadius: '20px', opacity: 1, offset: 0.7 },
        { ...px(done), borderRadius: '20px', opacity: 0, offset: 1 },
      ], { duration: T_SPLIT, delay: i * STAGGER, easing: SOFT, fill: 'both' }).onfinish = () => g.remove();
    });
  };
  a.oncancel = () => ghost.remove();
}
