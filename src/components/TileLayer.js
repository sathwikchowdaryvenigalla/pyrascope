import * as THREE from 'three';
import { DETAIL_SOURCES } from '../config.js';
import { applyShade } from './earthShading.js';

// Streams NASA GIBS imagery (Web Mercator tiles) onto the globe and refines it as the camera moves closer.
const BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const LAYERS = ['BlueMarble_ShadedRelief_Bathymetry', 'BlueMarble_NextGeneration'].map((id) => ({
  id,
  maxZ: 8,
  url: (z, x, y) => `${BASE}/${id}/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`,
}));
const GIBS_MAX_Z = 8;   // native limit of the NASA Blue Marble layers (GoogleMapsCompatible_Level8)
const DETAIL_MAX_Z = 17; // deepest level requested from the high-detail source (~1 m/pixel); missing tiles fall back to their parent
const DETAIL_MIN_Z = 6;  // from this level up the sharper satellite-photo source replaces Blue Marble (500 m/pixel at best)
const MIN_Z = 3;         // never draw the blurry z0-z2 world tiles: the 2k base texture looks better until z3 arrives
const TEXEL_RATIO_PX = 200; // refine a tile once it covers more than this many DEVICE pixels (256 px texture => ~1.3 texels per pixel, i.e. crisp)
const MAX_ACTIVE = 10;     // concurrent tile downloads; the rest wait in a priority queue (coarse + centre first) and stale ones are cancelled
const RETRY_MS = 8000;     // a tile that failed to download is requested again after this long (x number of failures) ...
const MAX_RETRIES = 3;     // ... but only until it has failed this many times
const FADE_MS = 280;
const RAD = Math.PI / 180;
const yToLat = (y, n) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / RAD;
const vec = (lat, lon, r) => {
  const phi = (90 - lat) * RAD, th = (lon + 180) * RAD;
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th));
};

// Esri answers HTTP 200 with a flat light-grey "Map data not yet available" tile beyond its real coverage. Detect that
// (bright, almost no variation) so the sharper parent tile stays visible instead of a grey square.
function looksMissing(img) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data, n = d.length / 4;
    let s = 0, s2 = 0;
    for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; s += v; s2 += v * v; }
    const m = s / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m));
    return m > 190 && sd < 9;
  } catch { return false; } // canvas tainted: cannot tell
}

function buildGeo(z, x, y) {
  const n = 2 ** z, N = z <= 2 ? 32 : z <= 4 ? 16 : 8;
  const lonW = (x / n) * 360 - 180, lonSpan = 360 / n;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= N; j++) {
    const lat = yToLat(y + j / N, n);
    for (let i = 0; i <= N; i++) {
      const v = vec(lat, lonW + (lonSpan * i) / N, 1.00004);
      pos.push(v.x, v.y, v.z); uv.push(i / N, 1 - j / N);
    }
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export default class TileLayer {
  constructor(scene, camera, renderer, onStatus, onHiRes) {
    Object.assign(this, { scene, camera, renderer, onStatus, onHiRes });
    this.group = new THREE.Group();
    scene.add(this.group);
    this.tiles = new Map();
    this.layer = 0; this.errors = 0; this.loaded = 0; this.tick = 0;
    this.dirty = true; this.last = 0; this.dead = false; this.status = 'loading';
    this.detail = { on: DETAIL_SOURCES.length > 0, idx: 0, errors: 0, loaded: 0 };
    this.dz = DETAIL_SOURCES.length > 0 ? DETAIL_MIN_Z : Infinity; // tiles at z >= dz come from the detail source
    this.fading = new Set();
    this.pending = []; this.active = 0; this.fails = new Map(); // download queue + per-tile failure counts
  }

  urlFor(z, x, y) {
    return z >= this.dz
      ? DETAIL_SOURCES[this.detail.idx].url.replace('{z}', z).replace('{y}', y).replace('{x}', x)
      : LAYERS[this.layer].url(z, x, y);
  }

  nextDetail() { // current close-up source is unreachable: try the next one, or fall back to GIBS-only
    if (!this.detail.on) return;
    console.warn(`[PyraScope] Close-up imagery source ${this.detail.idx + 1}/${DETAIL_SOURCES.length} could not be loaded (blocked, offline or no CORS headers): ${DETAIL_SOURCES[this.detail.idx].url}`);
    [...this.tiles.values()].forEach((r) => { if (r.z >= this.dz) this.remove(r); });
    this.detail.idx++; this.detail.errors = 0; this.detail.loaded = 0;
    if (this.detail.idx >= DETAIL_SOURCES.length) {
      this.detail.on = false; this.dz = Infinity;
      console.warn('[PyraScope] No close-up imagery available: showing NASA Blue Marble only (about 600 m/pixel), so very close zoom is limited.');
      this.onHiRes && this.onHiRes(false);
    }
    this.dirty = true;
  }

  markDirty() { this.dirty = true; }
  setStatus(s) { if (s !== this.status) { this.status = s; this.onStatus(s); } }

  frame() {
    const now = performance.now();
    if (!this.dirty && now - this.last > 3000) this.dirty = true; // cheap periodic pass: retries failed tiles, keeps the queue fresh
    if (this.dirty && !this.dead && now - this.last > 120) { this.dirty = false; this.last = now; this.update(); }
    for (const r of this.fading) { // new tiles fade in over their parent instead of popping
      const k = Math.min(1, (now - r.t0) / FADE_MS), m = r.mesh.material;
      m.opacity = k;
      if (k >= 1) { m.transparent = false; m.needsUpdate = true; this.fading.delete(r); }
    }
  }

  ensure(z, x, y, cd = 0) {
    const key = `${this.layer}/${z}/${x}/${y}`;
    let rec = this.tiles.get(key);
    if (rec) {
      if (rec.state === 'error' && !rec.missing && rec.fails < MAX_RETRIES && performance.now() - rec.errAt > RETRY_MS * rec.fails) this.tiles.delete(key); // retry network hiccups a couple of times, then give up (probably a real 404)
      else { rec.cd = cd; return rec; }
    }
    rec = { key, z, x, y, state: 'queued', mesh: null, used: this.tick, cd, abort: null, missing: false, errAt: 0, fails: this.fails.get(key) || 0 };
    this.tiles.set(key, rec);
    this.pending.push(rec);
    return rec;
  }

  // Starts the next queued downloads (max MAX_ACTIVE at once).
  pump() {
    while (!this.dead && this.active < MAX_ACTIVE && this.pending.length) {
      const r = this.pending.shift();
      if (r.state === 'queued' && this.tiles.get(r.key) === r) this.start(r);
    }
  }

  start(rec) {
    const { z, x, y, key } = rec, layer = this.layer;
    rec.state = 'loading'; this.active++;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    let done = false;
    const finish = () => { if (done) return false; done = true; rec.abort = null; this.active--; return true; };
    rec.abort = () => { if (finish()) { img.onload = img.onerror = null; img.src = ''; } }; // cancel a download that is no longer needed
    const alive = () => !this.dead && layer === this.layer && this.tiles.get(key) === rec;

    img.onload = () => {
      if (!finish()) return;
      this.pump();
      if (!alive()) return;
      // no imagery here at this zoom (Esri sends a flat grey tile): remember it so the sharper parent stays and no children are requested
      if (z >= this.dz && z >= 11 && looksMissing(img)) { rec.state = 'error'; rec.missing = true; rec.errAt = performance.now(); this.dirty = true; return; }
      const tex = new THREE.Texture(img);
      tex.needsUpdate = true;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      const mat = applyShade(new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, depthWrite: false, transparent: true, opacity: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
      rec.mesh = new THREE.Mesh(buildGeo(z, x, y), mat);
      rec.mesh.renderOrder = z + 1;
      rec.mesh.visible = false;
      this.group.add(rec.mesh);
      rec.state = 'ready';
      rec.t0 = performance.now(); this.fading.add(rec);
      if (z >= this.dz) { if (!this.detail.loaded++ && this.onHiRes) this.onHiRes(true, DETAIL_SOURCES[this.detail.idx].attribution); }
      else this.loaded++;
      this.setStatus('ready');
      this.dirty = true;
    };
    img.onerror = () => {
      if (!finish()) return;
      this.pump();
      if (!alive()) return;
      rec.state = 'error'; rec.errAt = performance.now(); rec.fails++; this.fails.set(key, rec.fails);
      if (z >= this.dz) { if (++this.detail.errors >= 6 && this.detail.loaded === 0) this.nextDetail(); return; }
      this.errors++;
      if (this.loaded === 0 && this.errors >= 4) this.nextLayer();
    };
    img.src = this.urlFor(z, x, y);
  }

  remove(r) { // forget a tile: cancels its download if still running and frees its GPU resources
    if (r.abort) r.abort();
    this.drop(r);
    this.tiles.delete(r.key);
  }

  clear() {
    this.tiles.forEach((r) => { if (r.abort) r.abort(); this.drop(r); });
    this.tiles.clear();
    this.pending = [];
  }
  drop(r) {
    if (!r.mesh) return;
    this.fading.delete(r);
    this.group.remove(r.mesh);
    r.mesh.geometry.dispose(); r.mesh.material.map.dispose(); r.mesh.material.dispose();
  }
  nextLayer() {
    this.clear();
    this.layer++; this.errors = 0; this.loaded = 0;
    if (this.layer >= LAYERS.length) { this.dead = true; this.setStatus('failed'); return; }
    this.dirty = true;
  }

  update() {
    const cam = this.camera;
    const H = this.renderer.domElement.clientHeight || 800;
    const camPos = cam.position, d = camPos.length(), camDir = camPos.clone().normalize();
    const horizon = Math.acos(Math.min(1, 1 / d));
    const f = 1 / (2 * Math.tan((cam.fov * RAD) / 2));
    const dpr = this.renderer.getPixelRatio();
    const maxZ = this.detail.on ? DETAIL_MAX_Z : GIBS_MAX_Z;
    const keep = new Set();
    this.tick++;

    // Point on the globe straight below the camera (the camera always looks at the Earth's centre, so this is the screen centre).
    const nLat = Math.asin(Math.max(-1, Math.min(1, camDir.y))) / RAD;
    let nTh = Math.atan2(camDir.z, -camDir.x) / RAD; if (nTh < 0) nTh += 360;
    const nLon = nTh - 180;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const q = new THREE.Vector3();

    // Conservative frustum test: project 9 points of the tile; cull only when ALL of them are outside the same screen edge.
    // (Projecting just the tile CENTRE wrongly discarded big tiles that contain the spot being looked at as soon as the camera got
    // low, which hid every tile and left only the blurry 2k base texture.)
    const inView = (z, n, y, lonW, lonSpan) => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const p = vec(yToLat(y + j / 2, n), lonW + (lonSpan * i) / 2, 1);
        if (d - p.dot(camDir) <= 0.0002) return true; // at / behind the camera plane: cannot judge, keep it
        const u = p.project(cam);
        minX = Math.min(minX, u.x); maxX = Math.max(maxX, u.x); minY = Math.min(minY, u.y); maxY = Math.max(maxY, u.y);
      }
      const pad = z < 10 ? 0.3 : 0.12; // big tiles bulge between sample points, so they get more slack
      return !(maxX < -1 - pad || minX > 1 + pad || maxY < -1 - pad || minY > 1 + pad);
    };

    const visit = (z, x, y) => {
      const n = 2 ** z;
      const latN = yToLat(y, n), latS = yToLat(y + 1, n), cLat = yToLat(y + 0.5, n);
      const lonSpan = 360 / n, lonW = (x / n) * 360 - 180, cLon = lonW + lonSpan / 2;
      const c = vec(cLat, cLon, 1);
      const span = Math.max(lonSpan * Math.cos(cLat * RAD), latN - latS) * RAD;
      if (Math.acos(Math.max(-1, Math.min(1, c.dot(camDir)))) > horizon + span) return;
      const below = nLat >= latS && nLat <= latN && nLon >= lonW && nLon <= lonW + lonSpan; // the point under the camera is inside this tile
      if (z >= 5 && !below && !inView(z, n, y, lonW, lonSpan)) return;
      // On-screen size from the NEAREST point of the tile (not its centre): a large tile with the camera hovering just above it
      // is huge on screen, even though its centre is far away.
      q.copy(vec(clamp(nLat, latS, latN), clamp(nLon, lonW, lonW + lonSpan), 1));
      const px = (span / Math.max(1e-6, q.distanceTo(camPos))) * f * H;
      const v = c.clone().project(cam);
      if (z >= MIN_Z) {
        const rec = this.ensure(z, x, y, below ? 0 : Math.hypot(v.x, v.y));
        rec.used = this.tick;
        keep.add(rec.key);
        if (rec.state === 'error') return; // no imagery for this tile: its children would not exist either, so don't request them
      }
      if (z < maxZ && (z < MIN_Z || px * dpr > TEXEL_RATIO_PX)) for (let k = 0; k < 4; k++) visit(z + 1, 2 * x + (k & 1), 2 * y + (k >> 1));
    };
    visit(0, 0, 0);

    // Downloads for tiles that scrolled / zoomed out of view are cancelled so they cannot block the sharp tiles that ARE needed now.
    [...this.tiles.values()].forEach((r) => { if (!keep.has(r.key) && (r.state === 'queued' || r.state === 'loading')) this.remove(r); });
    this.pending = this.pending.filter((r) => r.state === 'queued' && this.tiles.get(r.key) === r);
    this.pending.sort((a, b) => a.z - b.z || a.cd - b.cd); // coarse ancestors first (instant fill), then finer levels, centre of the screen first
    this.pump();

    this.tiles.forEach((r) => { if (r.mesh) r.mesh.visible = keep.has(r.key); });
    if (this.tiles.size > 900) {
      [...this.tiles.values()].filter((r) => !keep.has(r.key)).sort((a, b) => a.used - b.used)
        .slice(0, this.tiles.size - 650).forEach((r) => { this.drop(r); this.tiles.delete(r.key); });
    }
  }

  dispose() {
    this.dead = true;
    this.clear();
    this.scene.remove(this.group);
  }
}
