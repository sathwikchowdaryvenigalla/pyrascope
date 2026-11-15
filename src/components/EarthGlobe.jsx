import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import TileLayer from './TileLayer.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DETAIL_TILES } from '../config.js';
import { applyShade, createAtmosphere } from './earthShading.js';

// Tried in order. Drop a higher-resolution equirectangular image at public/textures/earth.jpg for more detail.
const SOURCES = [
  '/textures/earth.jpg',
  'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg',
  'https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/earth-blue-marble.jpg',
];
const EARTH_KM = 6371;

const GEO_M = new THREE.CircleGeometry(1, 24);
const GEO_V = new THREE.CircleGeometry(1, 4);
GEO_V.rotateZ(Math.PI / 4);
const GEO_RING = new THREE.RingGeometry(1, 1.25, 40);
const mat = (c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
// One material per category: shape = sensor (circle MODIS, diamond VIIRS); colour = candidate-match status.
const MATS = {
  unmatched: { MODIS: mat('#FF5364'), VIIRS: mat('#D62839') },
  candidate: { MODIS: mat('#FFC53D'), VIIRS: mat('#FFC53D') },
  unknown: { MODIS: mat('#9AA0A6'), VIIRS: mat('#9AA0A6') },
};
const MAT_RING = mat('#FFFFFF');
const MAT_DIM = new THREE.MeshBasicMaterial({ color: '#9AA0A6', side: THREE.DoubleSide, transparent: true, opacity: 0.22, depthWrite: false });
const MAT_HOT_RING = new THREE.MeshBasicMaterial({ color: '#FFFFFF', side: THREE.DoubleSide, transparent: true, opacity: 0.75, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
const SEL_COLOR = '#00E5FF';
const MAT_SEL_LINE = new THREE.LineBasicMaterial({ color: SEL_COLOR });
const MAT_SEL_POINT = new THREE.MeshBasicMaterial({ color: SEL_COLOR, side: THREE.DoubleSide, depthTest: false });
const GEO_POINT = new THREE.RingGeometry(0.7, 1, 32);

const toVec = (lat, lon, r) => {
  const phi = ((90 - lat) * Math.PI) / 180, th = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th));
};

// Closed outline of a lat/lon rectangle, sampled every <=2 degrees so edges follow the sphere.
function bboxRing(b, r) {
  const [w, s, e, n] = b, pts = [];
  const ew = Math.max(2, Math.ceil((e - w) / 2)), ns = Math.max(2, Math.ceil((n - s) / 2));
  for (let i = 0; i <= ew; i++) pts.push(toVec(s, w + ((e - w) * i) / ew, r));
  for (let i = 1; i <= ns; i++) pts.push(toVec(s + ((n - s) * i) / ns, e, r));
  for (let i = 1; i <= ew; i++) pts.push(toVec(n, e - ((e - w) * i) / ew, r));
  for (let i = 1; i <= ns; i++) pts.push(toVec(n - ((n - s) * i) / ns, w, r));
  return pts;
}
const outline = (b) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(bboxRing(b, 1.0002)), MAT_SEL_LINE); l.renderOrder = 60; return l; };

// A circle of `radiusKm` around (lat, lon), drawn ON the sphere: a filled disc (concentric rings, so it follows the curvature)
// plus an outline. Returns a THREE.Group.
function areaCircle(c) {
  const R = 6371, ang = Math.min(c.radiusKm / R, 1.4), lat0 = (c.lat * Math.PI) / 180, lon0 = (c.lon * Math.PI) / 180;
  const at = (rho, brg) => { // destination point from the centre at angular distance rho along bearing brg
    const lat = Math.asin(Math.sin(lat0) * Math.cos(rho) + Math.cos(lat0) * Math.sin(rho) * Math.cos(brg));
    const lon = lon0 + Math.atan2(Math.sin(brg) * Math.sin(rho) * Math.cos(lat0), Math.cos(rho) - Math.sin(lat0) * Math.sin(lat));
    return toVec((lat * 180) / Math.PI, (((lon * 180) / Math.PI + 540) % 360) - 180, 1.0006);
  };
  const SEG = 72, RINGS = Math.max(2, Math.min(14, Math.ceil(((ang * 180) / Math.PI) / 1.2)));
  const pos = [...toVec(c.lat, c.lon, 1.0006).toArray()], idx = [];
  for (let r = 1; r <= RINGS; r++) for (let i = 0; i < SEG; i++) pos.push(...at((ang * r) / RINGS, (i / SEG) * 2 * Math.PI).toArray());
  const vi = (r, i) => (r === 0 ? 0 : 1 + (r - 1) * SEG + (i % SEG));
  for (let i = 0; i < SEG; i++) idx.push(0, vi(1, i), vi(1, i + 1));
  for (let r = 1; r < RINGS; r++) for (let i = 0; i < SEG; i++) idx.push(vi(r, i), vi(r + 1, i), vi(r + 1, i + 1), vi(r, i), vi(r + 1, i + 1), vi(r, i + 1));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: c.color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  fill.renderOrder = 55;
  const ring = [];
  for (let i = 0; i <= SEG; i++) ring.push(at(ang, (i / SEG) * 2 * Math.PI));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color: c.color }));
  line.renderOrder = 56;
  const grp = new THREE.Group(); grp.add(fill); grp.add(line);
  return grp;
}

function gridTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#1b3b5f'; g.fillRect(0, 0, 1024, 512);
  return new THREE.CanvasTexture(c);
}

export default function EarthGlobe({ markers, focus, selectedId, onPick, creditNote = '', boundary = null, selPoint = null, drawMode = false, onGlobeClick, onBox, viewShift = 0, areas = null }) {
  const mount = useRef(null);
  const ref = useRef({ items: [] });
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const clickRef = useRef(onGlobeClick); clickRef.current = onGlobeClick;
  const boxRef = useRef(onBox); boxRef.current = onBox;
  const drawRef = useRef(drawMode); drawRef.current = drawMode;
  const shiftRef = useRef(viewShift); shiftRef.current = viewShift;
  const [tex, setTex] = useState('loading');
  const [detail, setDetail] = useState('loading');
  const [hiRes, setHiRes] = useState(null); // null = not needed yet, string = attribution of active close-up source, false = unavailable

  useEffect(() => {
    const el = mount.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#05070d');
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 60); // near/far are retuned every frame from the surface distance
    camera.position.copy(toVec(15, 80, 3.4));
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false; controls.minDistance = DETAIL_TILES ? 1.0015 : 1.1; controls.maxDistance = 6;
    controls.enableZoom = false; // replaced by altitude-based zoom below (OrbitControls scales the distance to the Earth's CENTRE, so one wheel notch jumps from far away to the ground)
    controls.enableDamping = true; controls.dampingFactor = 0.09; // smooth zoom / rotation // no close-up tiles configured: stop where Blue Marble (~600 m/px) is still acceptable

    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128), applyShade(new THREE.MeshBasicMaterial({ map: gridTexture() })));
    scene.add(earth);
    const atmosphere = createAtmosphere();
    scene.add(atmosphere);
    earth.renderOrder = -1;

    // subtle graticule every 15 degrees
    const lm = new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.16 });
    const line = (pts) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lm); l.renderOrder = 50; scene.add(l); };
    for (let lat = -75; lat <= 75; lat += 15) { const p = []; for (let lon = -180; lon <= 180; lon += 3) p.push(toVec(lat, lon, 1.0008)); line(p); }
    for (let lon = -180; lon < 180; lon += 15) { const p = []; for (let lat = -90; lat <= 90; lat += 3) p.push(toVec(lat, lon, 1.0008)); line(p); }

    const group = new THREE.Group();
    scene.add(group);
    const tiles = new TileLayer(scene, camera, renderer, setDetail, (ok, attribution) => {
      setHiRes(ok ? attribution : false);
      if (!ok) controls.minDistance = 1.1; // high-detail source unreachable: don't let the user zoom into upscaled pixels
    });
    controls.addEventListener('change', () => tiles.markDirty());
    controls.addEventListener('start', () => { ref.current.fly = null; }); // user input cancels a camera flight

    const selGroup = new THREE.Group(), draftGroup = new THREE.Group();
    scene.add(selGroup); scene.add(draftGroup);
    const areaGroup = new THREE.Group(); scene.add(areaGroup); ref.current.areaGroup = areaGroup; // activity circles live apart from the selection outline

    const pts = [];
    for (let i = 0; i < 700; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(30);
      pts.push(v.x, v.y, v.z);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 0.08 })));

    let cancelled = false;
    const load = (i) => {
      if (i >= SOURCES.length) return setTex('fallback');
      new THREE.TextureLoader().load(
        SOURCES[i],
        (t) => {
          if (cancelled) return;
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = renderer.capabilities.getMaxAnisotropy();
          t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
          const old = earth.material.map; earth.material.map = t; if (old) old.dispose(); earth.material.needsUpdate = true;
          setTex('ready');
        },
        undefined,
        () => !cancelled && load(i + 1)
      );
    };
    load(0);

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      // viewShift (px): moves the globe's centre to the right so it stays visible beside a docked menu
      if (shiftRef.current) camera.setViewOffset(w, h, -shiftRef.current, 0, w, h); else camera.clearViewOffset();
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el); resize(); ref.current.resize = resize;

    // screen point -> {lat, lon} by ray-casting the camera ray onto the (unrotated) unit sphere, so the result stays
    // exact for any camera rotation / zoom. Returns null when the pointer is not over the globe.
    const cv = renderer.domElement;
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    const hitLatLon = (e) => {
      const r = cv.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const h = ray.intersectObject(earth, false)[0];
      if (!h) return null;
      const p = h.point.clone().normalize();
      let lon = (Math.atan2(p.z, -p.x) * 180) / Math.PI - 180;
      if (lon < -180) lon += 360;
      return { lat: (Math.asin(THREE.MathUtils.clamp(p.y, -1, 1)) * 180) / Math.PI, lon };
    };
    const corners = (a, b) => [Math.min(a.lon, b.lon), Math.min(a.lat, b.lat), Math.max(a.lon, b.lon), Math.max(a.lat, b.lat)];
    const clearDraft = () => { draftGroup.children.forEach((c) => c.geometry.dispose()); draftGroup.clear(); };

    // click on a dot (screen-space nearest within 12 px, front-facing only); otherwise a click selects a location
    let down = null, drag = null;
    const onDown = (e) => {
      down = [e.clientX, e.clientY];
      if (drawRef.current && e.button === 0) { const h = hitLatLon(e); if (h) { drag = { a: h, b: h }; try { cv.setPointerCapture(e.pointerId); } catch { /* ignore */ } } }
    };
    const onMove = (e) => {
      if (!drag) return;
      const h = hitLatLon(e);
      if (!h) return;
      drag.b = h;
      clearDraft();
      const b = corners(drag.a, drag.b);
      if (b[2] > b[0] && b[3] > b[1]) draftGroup.add(outline(b));
    };
    const onUp = (e) => {
      if (drag) { // finish a drawn rectangle
        const b = corners(drag.a, drag.b); drag = null; clearDraft(); down = null;
        if (b[2] - b[0] > 0.05 && b[3] - b[1] > 0.05 && boxRef.current) boxRef.current(b.map((v) => Math.round(v * 1e4) / 1e4));
        return;
      }
      if (drawRef.current) return;
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || !pickRef.current) return;
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 144;
      for (const it of ref.current.items) {
        if (it.pos.dot(camera.position) <= it.pos.lengthSq()) continue;
        const v = it.pos.clone().project(camera);
        const d = (((v.x + 1) / 2) * r.width - x) ** 2 + (((1 - v.y) / 2) * r.height - y) ** 2;
        if (d < bd) { bd = d; best = it; }
      }
      if (best) { pickRef.current(best.id); return; }
      const g = hitLatLon(e);
      if (g && clickRef.current) clickRef.current(g.lat, g.lon);
    };
    // Altitude-based zoom (Google-Earth style): every wheel notch / pinch changes the HEIGHT above the ground by a fixed ratio and is
    // eased over a few frames. zoom.t = target altitude in Earth radii (null = follow the camera).
    const zoom = { t: null };
    ref.current.zoom = zoom;
    const altOf = () => camera.position.length() - 1;
    const clampAlt = (a) => THREE.MathUtils.clamp(a, controls.minDistance - 1, controls.maxDistance - 1);
    const onWheel = (e) => {
      e.preventDefault();
      ref.current.fly = null;
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1; // lines / pages -> pixels
      zoom.t = clampAlt((zoom.t ?? altOf()) * Math.exp(Math.max(-300, Math.min(300, e.deltaY * unit)) * 0.0016));
    };
    const fingers = new Map(); let pinch = 0;
    const pDown = (e) => { fingers.set(e.pointerId, [e.clientX, e.clientY]); pinch = 0; };
    const pMove = (e) => {
      if (!fingers.has(e.pointerId)) return;
      fingers.set(e.pointerId, [e.clientX, e.clientY]);
      if (fingers.size !== 2) return;
      const [a, b] = [...fingers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch && d > 0) { ref.current.fly = null; zoom.t = clampAlt((zoom.t ?? altOf()) * (pinch / d)); }
      pinch = d;
    };
    const pUp = (e) => { fingers.delete(e.pointerId); pinch = 0; };
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('pointerdown', pDown); cv.addEventListener('pointermove', pMove);
    cv.addEventListener('pointerup', pUp); cv.addEventListener('pointercancel', pUp);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerup', onUp);

    let raf;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const fly = ref.current.fly;
      if (fly) { // eased great-circle camera flight (focus changes)
        const k = Math.min(1, (performance.now() - fly.t0) / fly.dur);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        const qi = new THREE.Quaternion().slerp(fly.q, e);
        camera.position.copy(fly.a.clone().applyQuaternion(qi).multiplyScalar(fly.da + (fly.db - fly.da) * e));
        if (k >= 1) ref.current.fly = null;
      } else if (zoom.t !== null) { // eased altitude zoom
        const a = altOf(), nxt = a + (zoom.t - a) * 0.2;
        camera.position.setLength(1 + nxt);
        if (Math.abs(zoom.t - nxt) < 1e-5 + nxt * 0.003) zoom.t = null;
      }
      const dist = camera.position.length();
      const minS = (dist - 1) * 0.0026; // keeps dots ~3px; true pixel footprint takes over when zoomed in
      controls.rotateSpeed = Math.max(0.003, Math.min(0.6, 0.12 + (dist - 1) * 0.2, (dist - 1) * 0.25)); // slower the closer to the ground, so dragging moves the map naturally
      for (const it of ref.current.items) {
        const s = Math.max(it.phys, minS * (it.hot ? 2.2 : 1)) * (it.sel ? 1.8 : 1) * (it.foc ? 1.5 : it.dim ? 0.8 : 1); // historical hotspot cells are drawn larger so they stay visible at globe zoom
        it.mesh.scale.setScalar(s);
        if (it.ring) it.ring.scale.setScalar(s * 2.6);
      }
      const sp = ref.current.selPoint;
      if (sp) { sp.visible = dist - 1 > 0.12; sp.scale.setScalar(Math.max(0.004, (dist - 1) * 0.02)); } // blue selection ring hides once zoomed in, so it never covers the dots
      // Tight near plane close to the surface (precision for the thin tile offsets), generous when far. Never inside the Earth.
      const near = THREE.MathUtils.clamp((dist - 1) * 0.25, 0.0003, 0.6);
      if (Math.abs(near - camera.near) > camera.near * 0.05) { camera.near = near; camera.updateProjectionMatrix(); }
      controls.update();
      tiles.frame();
      renderer.render(scene, camera);
    };
    loop();
    ref.current.group = group; ref.current.camera = camera; ref.current.controls = controls;
    ref.current.selGroup = selGroup; ref.current.cv = cv;

    return () => {
      cancelled = true; tiles.dispose(); cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      cv.removeEventListener('wheel', onWheel); cv.removeEventListener('pointerdown', pDown); cv.removeEventListener('pointermove', pMove); cv.removeEventListener('pointerup', pUp); cv.removeEventListener('pointercancel', pUp);
      cv.removeEventListener('pointerdown', onDown); cv.removeEventListener('pointerup', onUp); cv.removeEventListener('pointermove', onMove);
      atmosphere.geometry.dispose(); atmosphere.material.dispose(); earth.material.map && earth.material.map.dispose();
      renderer.dispose(); el.removeChild(cv);
    };
  }, []);

  useEffect(() => {
    const g = ref.current.group;
    if (!g) return;
    g.clear();
    ref.current.items = markers.map((m) => {
      const mod = m.satellite === 'MODIS';
      const pos = toVec(m.latitude, m.longitude, 1.0001);
      const out = pos.clone().multiplyScalar(2);
      const status = (m.category || '').split('_')[1] || 'unknown';
      const mesh = new THREE.Mesh(mod ? GEO_M : GEO_V, m.dim ? MAT_DIM : (MATS[status] || MATS.unknown)[m.satellite]);
      mesh.position.copy(pos); mesh.lookAt(out); mesh.renderOrder = m.dim ? 98 : 100; g.add(mesh);
      const sel = m.id === selectedId;
      const hot = /_h(low|mid|high)$/.test(m.category || '');
      let ring = null;
      if (sel || (hot && status === 'hhigh' && !m.dim)) {
        ring = new THREE.Mesh(GEO_RING, sel ? MAT_RING : MAT_HOT_RING);
        ring.position.copy(toVec(m.latitude, m.longitude, 1.00015)); ring.lookAt(out); ring.renderOrder = 101; g.add(ring);
      }
      return { id: m.id, pos, phys: m.scan / 2 / EARTH_KM, mesh, ring, sel, hot, dim: !!m.dim, foc: !!m.focus };
    });
  }, [markers, selectedId]);

  // selection boundary (any size) and clicked-point marker
  const boundaryKey = boundary ? boundary.join(',') : '';
  useEffect(() => {
    const g = ref.current.selGroup;
    if (!g) return;
    g.children.forEach((c) => c.isLine && c.geometry.dispose());
    g.clear(); ref.current.selPoint = null;
    if (boundary) g.add(outline(boundary));
    if (selPoint) {
      const m = new THREE.Mesh(GEO_POINT, MAT_SEL_POINT);
      m.position.copy(toVec(selPoint.lat, selPoint.lon, 1.0003)); m.lookAt(m.position.clone().multiplyScalar(2)); m.renderOrder = 102;
      g.add(m); ref.current.selPoint = m;
    }
  }, [boundaryKey, selPoint?.lat, selPoint?.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  // activity-area circles (one per cluster of the tier chosen in the menu)
  useEffect(() => {
    const g = ref.current.areaGroup;
    if (!g) return undefined;
    const grp = new THREE.Group();
    (areas || []).forEach((c) => grp.add(areaCircle(c)));
    g.add(grp);
    return () => {
      g.remove(grp);
      grp.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    };
  }, [areas]);

  useEffect(() => { ref.current.resize?.(); }, [viewShift]);

  // while drawing a box, dragging draws instead of rotating (wheel zoom still works)
  useEffect(() => {
    const { controls, cv } = ref.current;
    if (!controls) return;
    controls.enableRotate = !drawMode;
    cv.style.cursor = drawMode ? 'crosshair' : '';
  }, [drawMode]);

  useEffect(() => {
    const { camera, controls } = ref.current;
    if (!focus || !camera) return;
    const to = toVec(focus.lat, focus.lon, 1).normalize(), a = camera.position.clone().normalize();
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (ref.current.zoom) ref.current.zoom.t = null;
    ref.current.fly = { a, q: new THREE.Quaternion().setFromUnitVectors(a, to), da: camera.position.length(), db: focus.dist, t0: performance.now(), dur: reduce ? 1 : 1100 };
  }, [focus?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="globe-wrap" ref={mount}>
      {tex === 'loading' && <div className="globe-status">Loading Earth texture…</div>}
      {tex === 'fallback' && <div className="globe-status">Earth texture unavailable offline. Add public/textures/earth.jpg.</div>}
      {tex !== 'loading' && tex !== 'fallback' && detail === 'failed' && <div className="globe-status">High-detail NASA imagery unavailable (offline?). Using base texture.</div>}
      {detail === 'ready' && <div className="credit">Imagery: NASA GIBS (Blue Marble){hiRes ? ` · close-up: ${hiRes}` : ''}{hiRes === false ? ' · close-up imagery unavailable (Blue Marble only, ~600 m/px)' : ''}{creditNote ? ` · ${creditNote}` : ''}</div>}
    </div>
  );
}
