// Procedural car generator. The body is a loft of cross-sections built from shape.js profiles;
// lamps, grilles and plates are textured patches projected onto that surface.
import * as THREE from 'three';
import { bodyGeometry, engineBay } from '../sim/shape.js';
import { rideOffset } from '../sim/vehicle.js';
import { makePaintMaterial, applyPaint, applyLivery, makeGlassMaterial, setTint, sharedMaterials } from './materials.js';
import { buildWheel, disposeWheel } from './wheels.js';
import { buildEngineModel, buildBattery } from './engineModel.js';
import * as TX from './textures.js';

const SEG = { A: 0, B: 1, K: 2, C: 3, D: 4, E: 5, F: 6, G: 7 };
const NE = 5, NF = 4, NG = 5, NB = 4, NA = 3, ND = 4;
const SIDE_T = [0.17, 0.34, 0.5, 0.63, 0.72, 0.8, 0.88, 1];
const MI = { paint: 0, glass: 1, roof: 2, trim: 3, under: 4 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

function uniqueSorted(xs, minGap = 0.0015) {
  xs.sort((a, b) => a - b);
  const out = [];
  for (const x of xs) if (!out.length || x - out[out.length - 1] > minGap) out.push(x);
  return out;
}

export class CarModel {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'car';
    this.M = sharedMaterials();
    this.paint = makePaintMaterial();
    this.roofMat = makePaintMaterial();
    this.glass = makeGlassMaterial();
    this.trimMat = this.M.trim;
    this.materials = [this.paint, this.glass, this.roofMat, this.trimMat, this.M.under];
    this.xray = false;
    this.night = false;
    this.flames = [];
    this.wheelSpin = 0;
  }

  // ---------------------------------------------------------------- build
  build(car, cfg, info) {
    this.dispose();
    this.car = car;
    this.cfg = { ...cfg };
    this.info = info;
    const geo = bodyGeometry(car, { widebody: cfg.widebody });
    this.geo = geo;
    this.layout = computeLayout(car, geo);
    this.body = new THREE.Group(); // moves with ride height
    this.root.add(this.body);
    this.wheelRoot = new THREE.Group();
    this.root.add(this.wheelRoot);
    this.disposables = [];

    this.buildLoft();
    this.liners = [];
    this.buildArchLiners();
    this.buildDetails();
    this.buildInterior();
    this.kits = new THREE.Group(); this.body.add(this.kits);
    this.buildKits();
    this.buildWheels();
    this.buildEngine();
    this.buildLights();
    this.applyVisuals(cfg);
    this.setRide(cfg);
    this.setXray(this.xray);
    this.setNight(this.night);
    // solid parts cast real shadows onto the studio floor
    for (const grp of [this.body, this.wheelRoot]) grp.traverse((o) => {
      if (!o.isMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      o.castShadow = !(m && (m.transparent || m.blending === THREE.AdditiveBlending));
    });
    if (this.bodyMesh) this.bodyMesh.castShadow = true;
  }

  // A user-loaded 3D model replaces the generated body and wheels; engine X-ray keeps working.
  setCustom(custom) {
    if (this.custom && this.custom !== custom) this.custom.dispose();
    this.custom = custom || null;
    if (this.custom) {
      this.root.add(this.custom.root);
      this.custom.setXray(this.xray);
      this.custom.applyPaint(this.cfg.paint, this.cfg.finish, this.customPaint !== false);
    }
    if (this.cfg) this.setRide(this.cfg);
    this.applyCustomVisibility();
  }

  applyCustomVisibility() {
    const c = !!this.custom;
    if (this.bodyMesh) this.bodyMesh.visible = !c;
    if (this.exhaust) this.exhaust.visible = !c;
    for (const l of this.liners || []) l.visible = !c;
    for (const w of this.wheels || []) w.visible = !c;
    for (const sh of this.wheelShadows || []) sh.visible = !c;
    if (this.details) this.details.visible = !c && !this.xray;
    if (this.kits) this.kits.visible = !c && !this.xray;
    if (this.interior) this.interior.visible = !c && (!this.xray || !!this.cfg.cage);
  }

  dispose() {
    if (!this.body) return;
    const keep = new Set([this.paint, this.roofMat, this.glass, ...Object.values(this.M)]);
    const kill = (o) => {
      o.traverse((m) => {
        if (m.isMesh || m.isInstancedMesh || m.isLineSegments || m.isPoints) {
          if (!m.userData.sharedGeo) m.geometry?.dispose();
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mt of mats) if (mt && !keep.has(mt) && !mt.userData?.shared) mt.dispose();
        }
      });
    };
    if (this.wheels) for (const w of this.wheels) disposeWheel(w);
    kill(this.body); kill(this.wheelRoot);
    this.root.remove(this.body); this.root.remove(this.wheelRoot);
    this.body = null;
    this.flames = [];
  }

  // ---------------------------------------------------------------- loft
  buildLoft() {
    const g = this.geo, car = this.car, tpl = g.tpl;
    const xs0 = [];
    const step = 0.026;
    for (let x = g.xTail; x <= g.xNose; x += step) xs0.push(x);
    for (const d of [0.002, 0.007, 0.014, 0.024, 0.037, 0.053, 0.072, 0.095, 0.125, 0.16, 0.2]) { xs0.push(g.xTail + d, g.xNose - d); }
    xs0.push(g.xTail, g.xNose);
    for (const xa of [g.xF, g.xR]) for (const s of [-1, 1]) xs0.push(xa + s * g.Ra, xa + s * (g.Ra + 0.003), xa + s * g.Ra * 0.985, xa + s * g.Ra * 0.94, xa + s * g.Ra * 0.85);
    for (const k of [g.xCowl, g.xRoofF, g.xRoofR, g.xDeck, g.xCabBack]) if (k != null) xs0.push(k, k + 0.012, k - 0.012);
    if (g.xCabBack != null) xs0.push(g.xCabBack - 0.004, g.xCabBack - 0.03, g.xCabBack - 0.06);
    const xs = uniqueSorted(xs0.filter((x) => x >= g.xTail - 1e-9 && x <= g.xNose + 1e-9));
    this.xs = xs;
    const boxy = car.boxy || 0;
    const rB0 = 0.07 - boxy * 0.03, rS0 = 0.075 - boxy * 0.045, rR0 = 0.07 - boxy * 0.04;
    const inset0 = 0.04 - boxy * 0.022;
    const rocker0 = tpl.clad ? 0.11 : 0.05;
    const crown = 0.012 - boxy * 0.008;
    const creaseAmt = (car.era === 'classic' ? 0.0045 : 0.0085) * (1 - boxy * 0.45);
    const wedge = tpl.rear === 'notch' ? 0.03 : 0.015;
    const halfRings = [];
    const segLabels = [];
    for (const x of xs) {
      const zt = g.zTop(x);
      const zb = Math.max(g.zBot(x), g.arch(x));
      const hw = g.hw(x);
      const zBelt = g.zBelt + wedge * clamp((g.xRoofF - x) / g.L, 0, 1) * (1 - boxy);
      let cabin = zt > zBelt + 0.012 && x < g.xCowl + 0.03;
      if (g.xCabBack != null && x < g.xCabBack - 0.02) cabin = false;
      const zsh = cabin ? zBelt : zt;
      const avail = Math.max(0.02, zsh - zb);
      const rB = Math.min(rB0, avail * 0.3, hw * 0.3);
      const rS = Math.min(rS0, avail * 0.3, hw * 0.3);
      const rk = Math.min(rocker0, avail * 0.22);
      const pts = []; const seg = [];
      const push = (lat, y, s) => { pts.push(lat, y); seg.push(s); };
      for (let i = 0; i < NA; i++) push(((hw - rB) * i) / (NA - 1), zb, SEG.A);
      for (let i = 1; i <= NB; i++) { const a = -Math.PI / 2 + (i / NB) * (Math.PI / 2); push(hw - rB + rB * Math.cos(a), zb + rB + rB * Math.sin(a), SEG.B); }
      push(hw, zb + rB + rk * 0.5, SEG.K); push(hw, zb + rB + rk, SEG.K);
      const y0 = zb + rB + rk, y1 = zsh - rS;
      const bulge = (0.012 - boxy * 0.009) * clamp((y1 - y0) / 0.25, 0, 1);
      // body side with a shoulder character line: a crisp ridge two thirds up the door that catches reflections
      const crease = creaseAmt * clamp((y1 - y0 - 0.12) / 0.2, 0, 1);
      for (const t of SIDE_T) {
        const ridge = crease * Math.max(0, 1 - Math.abs(t - 0.8) / 0.085);
        push(hw + bulge * Math.sin(Math.PI * t) + ridge, y0 + (y1 - y0) * t, SEG.C);
      }
      for (let i = 1; i <= ND; i++) { const a = (i / ND) * (Math.PI / 2); push(hw - rS + rS * Math.cos(a), zsh - rS + rS * Math.sin(a), SEG.D); }
      if (cabin) {
        const k = clamp((zt - zBelt) / 0.07, 0, 1);
        const g0 = hw - rS - inset0 * k;
        const rR = Math.min(rR0, (zt - zBelt) * 0.4, g0 * 0.35);
        const tumble = tpl.tumble;
        const gAt = (y) => g0 - tumble * (y - zBelt);
        for (let i = 0; i < NE; i++) { const t = i / (NE - 1); const y = zBelt + (zt - rR - zBelt) * t; push(gAt(y), y, SEG.E); }
        const gR = gAt(zt - rR);
        for (let i = 1; i <= NF; i++) { const a = (i / NF) * (Math.PI / 2); push(gR - rR + rR * Math.cos(a), zt - rR + rR * Math.sin(a), SEG.F); }
        const start = gR - rR;
        for (let i = 1; i <= NG; i++) { const t = i / NG; const lat = start * (1 - t); push(lat, zt + crown * (1 - (lat / Math.max(start, 0.01)) ** 2), SEG.G); }
      } else {
        for (let i = 0; i < NE; i++) push(hw - rS, zsh, SEG.E);
        for (let i = 1; i <= NF; i++) push(hw - rS, zsh, SEG.F);
        const start = hw - rS;
        for (let i = 1; i <= NG; i++) { const t = i / NG; const lat = start * (1 - t); push(lat, zt + crown * 0.6 * (1 - (lat / Math.max(start, 0.01)) ** 2), SEG.G); }
      }
      halfRings.push({ x, pts: Float32Array.from(pts), cabin, zt, zb, hw });
      segLabels.push(seg);
    }
    // pillow rounding beyond the end stations so the fascia is not a flat plate
    const round = (end) => {
      const src = end > 0 ? halfRings[halfRings.length - 1] : halfRings[0];
      let ymin = Infinity, ymax = -Infinity;
      for (let i = 1; i < src.pts.length; i += 2) { ymin = Math.min(ymin, src.pts[i]); ymax = Math.max(ymax, src.pts[i]); }
      const yc = ymin + (ymax - ymin) * 0.48;
      const soft = 1 - boxy * 0.6;
      const sc = boxy > 0.7 ? [0.975, 0.92, 0.8, 0.5] : [0.95, 0.83, 0.62, 0.3];
      const dx = [0.012, 0.026, 0.038, 0.045].map((d) => d * soft + 0.004);
      const out = [];
      for (let i = 0; i < 4; i++) {
        const p = new Float32Array(src.pts.length);
        for (let k = 0; k < p.length; k += 2) { p[k] = src.pts[k] * sc[i]; p[k + 1] = yc + (src.pts[k + 1] - yc) * sc[i]; }
        out.push({ x: src.x + end * dx[i], pts: p, cabin: false, zt: src.zt, zb: src.zb, hw: src.hw * sc[i], pillow: true });
      }
      return out;
    };
    const head = round(-1).reverse();
    const tail = round(1);
    const labels0 = segLabels[0];
    for (let i = 0; i < head.length; i++) { halfRings.unshift(head[i]); segLabels.unshift(labels0); }
    for (const r of tail) { halfRings.push(r); segLabels.push(labels0); }
    xs.length = 0; for (const r of halfRings) xs.push(r.x);
    this.halfRings = halfRings;
    const h = segLabels[0].length;
    const M = 2 * h - 2;
    const nS = xs.length;
    const pos = new Float32Array((nS * M + 2 * (M + 1)) * 3);
    let vi = 0;
    const ringStart = [];
    for (let s = 0; s < nS; s++) {
      ringStart.push(vi);
      const r = halfRings[s];
      for (let j = 0; j < h; j++) { pos[vi * 3] = r.x; pos[vi * 3 + 1] = r.pts[j * 2 + 1]; pos[vi * 3 + 2] = r.pts[j * 2]; vi++; }
      for (let j = h - 2; j >= 1; j--) { pos[vi * 3] = r.x; pos[vi * 3 + 1] = r.pts[j * 2 + 1]; pos[vi * 3 + 2] = -r.pts[j * 2]; vi++; }
    }
    const fullSeg = [];
    const sl = segLabels[0];
    for (let j = 0; j < h; j++) fullSeg.push(sl[j]);
    for (let j = h - 2; j >= 1; j--) fullSeg.push(sl[j]);
    // material classification per quad
    const L = this.layout;
    const two = !!this.cfg.roof;
    const idx = [[], [], [], [], []];
    const pushQuad = (m, a, b, c, d) => { idx[m].push(a, c, b, a, d, c); };
    for (let s = 0; s < nS - 1; s++) {
      const xm = (xs[s] + xs[s + 1]) / 2;
      const cab = halfRings[s].cabin && halfRings[s + 1].cabin;
      const topZone = L.topZone(xm);
      const sideZone = L.sideZone(xm);
      const clad = !!this.geo.tpl.clad;
      const sideMat = sideZone === 'glass' ? MI.glass : sideZone === 'bpillar' ? (L.blackPillars ? MI.trim : two ? MI.roof : MI.paint) : two ? MI.roof : MI.paint;
      const topMat = topZone === 'glass' ? MI.glass : topZone === 'roof' ? MI.roof : MI.paint;
      const edgeMat = topZone === 'glass' || topZone === 'roof' ? MI.roof : MI.paint;
      for (let k = 0; k < M; k++) {
        const k2 = (k + 1) % M;
        const sa = fullSeg[k], sb = fullSeg[k2];
        const lo = Math.min(sa, sb), hi = Math.max(sa, sb);
        let m;
        const pillow = halfRings[s].pillow || halfRings[s + 1].pillow;
        if (pillow) m = hi === SEG.A ? MI.under : MI.paint;
        else if (hi === SEG.A) m = MI.under;
        else if (hi <= SEG.K) m = clad ? MI.trim : lo === SEG.A ? MI.under : MI.paint;
        else if (hi <= SEG.D || !cab) m = MI.paint;
        else if (hi === SEG.E) m = lo === SEG.E ? sideMat : (sideZone === 'glass' ? MI.trim : MI.paint);
        else if (hi === SEG.F) m = lo === SEG.E && sideZone === 'glass' ? MI.trim : edgeMat;
        else m = lo === SEG.G ? topMat : edgeMat;
        pushQuad(m, ringStart[s] + k, ringStart[s] + k2, ringStart[s + 1] + k2, ringStart[s + 1] + k);
      }
    }
    // caps (separate vertices for crisp edges)
    const capBase = vi;
    const addCap = (s, dir) => {
      const start = vi;
      let cy = 0;
      for (let k = 0; k < M; k++) { const p = ringStart[s] + k; pos[vi * 3] = pos[p * 3]; pos[vi * 3 + 1] = pos[p * 3 + 1]; pos[vi * 3 + 2] = pos[p * 3 + 2]; cy += pos[p * 3 + 1]; vi++; }
      const c = vi;
      pos[vi * 3] = xs[s] + dir * 0.006; pos[vi * 3 + 1] = cy / M; pos[vi * 3 + 2] = 0; vi++;
      for (let k = 0; k < M; k++) {
        const a = start + k, b = start + ((k + 1) % M);
        if (dir > 0) idx[MI.paint].push(c, a, b); else idx[MI.paint].push(c, b, a);
      }
    };
    addCap(nS - 1, 1);
    addCap(0, -1);
    void capBase;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, vi * 3), 3));
    const all = [];
    let off = 0;
    for (let m = 0; m < 5; m++) { geom.addGroup(off, idx[m].length, m); off += idx[m].length; all.push(...idx[m]); }
    geom.setIndex(all);
    geom.computeVertexNormals();
    // ensure outward winding: probe a right-side vertex
    const nrm = geom.getAttribute('normal');
    const probe = ringStart[Math.floor(nS / 2)] + Math.floor(h / 2) - 3;
    if (nrm.getZ(probe) < 0) {
      for (let i = 0; i < all.length; i += 3) { const t = all[i + 1]; all[i + 1] = all[i + 2]; all[i + 2] = t; }
      geom.setIndex(all);
      geom.computeVertexNormals();
    }
    this.bodyMesh = new THREE.Mesh(geom, this.materials);
    this.body.add(this.bodyMesh);
    this.halfH = h;
    // shader dimensions and panel seams
    const u = this.paint.userData.u;
    u.uDims.value.set(g.L, g.W, g.H, g.GC);
    u.uBelt.value = g.zBelt;
    const seams = L.seams.concat([99, 99, 99, 99]).slice(0, 4);
    u.uSeamX.value = seams;
    u.uSeamY.value.set(g.GC + 0.06, g.zBelt - 0.012);
    const hoodHW = g.W / 2 - 0.15;
    const hasHood = this.car.body !== 'van';
    u.uHood.value.set(hasHood ? g.xNose - 0.13 : 99, hasHood ? g.xCowl + 0.02 : 99, hasHood ? hoodHW : 0, 0);
    if (g.tpl.rear === 'notch') u.uDeck.value.set(g.xDeck - 0.03, g.xTail + 0.07, g.W / 2 - 0.16, 1);
    else u.uDeck.value.set(99, 99, 0, 0);
    const r2 = this.roofMat.userData.u;
    r2.uSeamOn.value = 0;
    r2.uDims.value.copy(u.uDims.value);
  }

  // ---------------------------------------------------------------- surface queries
  extentAt(i, y) {
    const r = this.halfRings[i].pts;
    let best = -1;
    for (let k = 0; k < r.length / 2 - 1; k++) {
      const ya = r[2 * k + 1], yb = r[2 * k + 3];
      if ((ya - y) * (yb - y) <= 0 && ya !== yb) {
        const t = (y - ya) / (yb - ya);
        const lat = r[2 * k] + t * (r[2 * k + 2] - r[2 * k]);
        if (lat > best) best = lat;
      }
    }
    return best;
  }
  heightAt(i, lat) {
    const r = this.halfRings[i].pts;
    let best = -1;
    for (let k = 0; k < r.length / 2 - 1; k++) {
      const la = r[2 * k], lb = r[2 * k + 2];
      if ((la - lat) * (lb - lat) <= 0 && la !== lb) {
        const t = (lat - la) / (lb - la);
        const y = r[2 * k + 1] + t * (r[2 * k + 3] - r[2 * k + 1]);
        if (y > best) best = y;
      }
    }
    return best;
  }
  stationIndex(x) {
    const xs = this.xs;
    let lo = 0, hi = xs.length - 1;
    if (x <= xs[0]) return 0;
    if (x >= xs[hi]) return hi - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] > x) hi = m; else lo = m; }
    return lo;
  }
  sideZ(x, y) {
    const i = this.stationIndex(x);
    const a = this.extentAt(i, y), b = this.extentAt(i + 1, y);
    if (a < 0 && b < 0) return null;
    const t = (x - this.xs[i]) / (this.xs[i + 1] - this.xs[i]);
    if (a < 0) return b; if (b < 0) return a;
    return lerp(a, b, t);
  }
  topY(x, z) {
    const i = this.stationIndex(x);
    const a = this.heightAt(i, Math.abs(z)), b = this.heightAt(i + 1, Math.abs(z));
    if (a < 0 && b < 0) return null;
    const t = (x - this.xs[i]) / (this.xs[i + 1] - this.xs[i]);
    if (a < 0) return b; if (b < 0) return a;
    return lerp(a, b, t);
  }
  endX(y, z, front) {
    const az = Math.abs(z);
    const n = this.xs.length;
    const first = front ? n - 1 : 0;
    let prevE = this.extentAt(first, y);
    if (prevE >= az) return this.xs[first] + (front ? 0.004 : -0.004);
    for (let s = 1; s < n; s++) {
      const i = front ? n - 1 - s : s;
      const e = this.extentAt(i, y);
      if (e >= az) {
        const j = front ? i + 1 : i - 1;
        const t = prevE < 0 ? 0.5 : (e - az) / Math.max(1e-6, e - prevE);
        return this.xs[i] + (this.xs[j] - this.xs[i]) * clamp(t, 0, 1);
      }
      prevE = e;
    }
    return null;
  }

  // Projected decal patch. kind: front | rear | sideR | sideL | top
  patch(kind, r, nu, nv, off, material, maxDepth = Infinity) {
    const P = [];
    const g0 = this.geo;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const u = i / (nu - 1), v = j / (nv - 1);
      let p = null;
      if (kind === 'front' || kind === 'rear') {
        const z = lerp(r.z0, r.z1, u), y = lerp(r.y0, r.y1, v);
        const x = this.endX(y, z, kind === 'front');
        // depth limit keeps a patch on the end face instead of draping it down the flank
        if (x != null && Math.abs(x - (kind === 'front' ? g0.xNose : g0.xTail)) <= maxDepth) p = [x, y, z];
      } else if (kind === 'sideR' || kind === 'sideL') {
        const x = lerp(r.x0, r.x1, u), y = lerp(r.y0, r.y1, v);
        const z = this.sideZ(x, y);
        if (z != null) p = [x, y, kind === 'sideR' ? z : -z];
      } else {
        const x = lerp(r.x0, r.x1, u), z = lerp(r.z0, r.z1, v);
        const y = this.topY(x, z);
        if (y != null) p = [x, y, z];
      }
      P.push(p);
    }
    const nrm = [];
    const at = (i, j) => P[clamp(j, 0, nv - 1) * nu + clamp(i, 0, nu - 1)];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const p = at(i, j);
      if (!p) { nrm.push(null); continue; }
      const a = at(i + 1, j) || p, b = at(i - 1, j) || p, c = at(i, j + 1) || p, d = at(i, j - 1) || p;
      const du = new THREE.Vector3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const dv = new THREE.Vector3(c[0] - d[0], c[1] - d[1], c[2] - d[2]);
      const n = new THREE.Vector3().crossVectors(du, dv).normalize();
      const want = kind === 'front' ? [1, 0, 0] : kind === 'rear' ? [-1, 0, 0] : kind === 'sideR' ? [0, 0, 1] : kind === 'sideL' ? [0, 0, -1] : [0, 1, 0];
      if (n.x * want[0] + n.y * want[1] + n.z * want[2] < 0) n.negate();
      if (!isFinite(n.x)) n.set(...want);
      nrm.push(n);
    }
    const pos = [], uv = [], idx = [];
    const map = new Map();
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const k = j * nu + i; const p = P[k]; if (!p) continue;
      const n = nrm[k];
      map.set(k, pos.length / 3);
      pos.push(p[0] + n.x * off, p[1] + n.y * off, p[2] + n.z * off);
      let uu = i / (nu - 1);
      if (kind === 'front' || kind === 'sideL') uu = 1 - uu;
      uv.push(uu, j / (nv - 1));
    }
    for (let j = 0; j < nv - 1; j++) for (let i = 0; i < nu - 1; i++) {
      const a = map.get(j * nu + i), b = map.get(j * nu + i + 1), c = map.get((j + 1) * nu + i + 1), d = map.get((j + 1) * nu + i);
      if (a == null || b == null || c == null || d == null) continue;
      idx.push(a, b, c, a, c, d);
    }
    if (!idx.length) return null;
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    gg.setIndex(idx);
    gg.computeVertexNormals();
    // fix winding against the expected direction
    const nn = gg.getAttribute('normal');
    const want = kind === 'front' ? new THREE.Vector3(1, 0, 0) : kind === 'rear' ? new THREE.Vector3(-1, 0, 0) : kind === 'sideR' ? new THREE.Vector3(0, 0, 1) : kind === 'sideL' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    let dot = 0; for (let i = 0; i < nn.count; i++) dot += nn.getX(i) * want.x + nn.getY(i) * want.y + nn.getZ(i) * want.z;
    if (dot < 0) { const ix = gg.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } gg.index.needsUpdate = true; gg.computeVertexNormals(); }
    const mesh = new THREE.Mesh(gg, material);
    mesh.renderOrder = 2;
    return mesh;
  }

  decalMat(map, emissive, opts = {}) {
    const m = new THREE.MeshStandardMaterial({
      map, transparent: true, alphaTest: 0.03, roughness: opts.rough ?? 0.15, metalness: opts.metal ?? 0.1,
      emissiveMap: emissive || null, emissive: new THREE.Color(emissive ? (opts.emColor || '#ffffff') : '#000000'), emissiveIntensity: opts.emI ?? 0.2,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, envMapIntensity: 1.4, side: THREE.FrontSide,
    });
    return m;
  }

  lensMat(color, opacity) {
    return new THREE.MeshPhysicalMaterial({ color, transparent: true, opacity, roughness: 0.03, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 2.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  }

  // Window seal along the bottom of the side glass: chrome on classics, satin black on modern cars.
  buildBeltMouldings(det) {
    const g = this.geo, L = this.layout, car = this.car, tpl = g.tpl;
    if (!L.sideWins.length || car.body === 'van') return;
    const x0 = Math.max(g.xTail + 0.05, Math.min(...L.sideWins.map((w) => w[0])) - 0.02);
    const x1 = Math.min(g.xCowl, Math.max(...L.sideWins.map((w) => w[1])) + 0.015);
    const boxy = car.boxy || 0;
    const wedge = tpl.rear === 'notch' ? 0.03 : 0.015;
    const chrome = car.era === 'classic' && car.body !== 'jeep';
    const mat = chrome ? this.M.chrome.clone() : new THREE.MeshStandardMaterial({ color: '#0d0e10', roughness: 0.32, metalness: 0.35 });
    mat.side = THREE.DoubleSide;
    for (const s of [1, -1]) {
      const pos = [], idx = [];
      let n = 0;
      for (let x = x0; x <= x1 + 1e-6; x += 0.025) {
        const yb = g.zBelt + wedge * clamp((g.xRoofF - x) / g.L, 0, 1) * (1 - boxy);
        const z = this.sideZ(x, yb + 0.012);
        if (z == null) continue;
        const zo = z + 0.004, zi = z - 0.006;
        pos.push(x, yb - 0.004, s * zo, x, yb + 0.016, s * zo, x, yb + 0.016, s * zi);
        if (n > 0) { const a = (n - 1) * 3, b = n * 3; idx.push(a, b, b + 1, a, b + 1, a + 1, a + 1, b + 1, b + 2, a + 1, b + 2, a + 2); }
        n++;
      }
      if (n < 2) continue;
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      gg.setIndex(idx);
      gg.computeVertexNormals();
      det.add(new THREE.Mesh(gg, mat));
    }
  }

  // ---------------------------------------------------------------- details
  buildDetails() {
    const g = this.geo, car = this.car, L = this.layout;
    const det = new THREE.Group(); this.details = det; this.body.add(det);
    const yTopF = g.zTop(g.xNose), yBotF = Math.max(g.zBot(g.xNose), 0.15);
    const hwN = g.hw(g.xNose - 0.06);
    const style = car.lights;
    const sizes = { round: [0.2, 0.2], rect: [0.28, 0.15], modern90: [0.34, 0.17], modern: [0.4, 0.17], led: [0.44, 0.13] }[style];
    let [wL, hL] = sizes;
    wL = Math.min(wL, g.W * 0.27);
    let yL = yTopF - 0.035 - hL / 2;
    if (car.body === 'van') yL = yBotF + (yTopF - yBotF) * 0.6;
    if (car.body === 'jeep') yL = yTopF - 0.12;
    const zc = hwN - wL / 2 - (style === 'round' || style === 'rect' ? 0.07 : 0.015);
    this.headlights = [];
    const hlt = TX.headlightTextures(style, this.cfg.headlight || 'white');
    for (const s of [1, -1]) {
      const m = this.decalMat(hlt.map, hlt.emissive, { emI: 0.35 });
      const z0 = s > 0 ? zc - wL / 2 : -zc - wL / 2, z1 = z0 + wL;
      const p = this.patch('front', { z0, z1, y0: yL - hL / 2, y1: yL + hL / 2 }, 14, 6, 0.004, m);
      if (p) { if (s < 0) { m.map = hlt.map; } det.add(p); this.headlights.push(p); }
      // clear polycarbonate lens over the lamp, so it reads as glass and catches reflections
      const ln = this.patch('front', { z0: z0 - 0.008, z1: z1 + 0.008, y0: yL - hL / 2 - 0.008, y1: yL + hL / 2 + 0.008 }, 14, 6, 0.011, this.lensMat('#ffffff', 0.16), 0.16);
      if (ln) { ln.renderOrder = 3; det.add(ln); }
    }
    // mirror the left lamp texture so both point outward
    if (this.headlights[1]) { const uv = this.headlights[1].geometry.getAttribute('uv'); for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); uv.needsUpdate = true; }
    if (style === 'round' && car.body !== 'jeep') {
      // separate amber indicators below round lamps
      for (const s of [1, -1]) {
        const m = new THREE.MeshStandardMaterial({ color: '#d98a16', emissive: '#ff9a1a', emissiveIntensity: 0.15, roughness: 0.2 });
        const p = this.patch('front', { z0: s * zc - 0.06, z1: s * zc + 0.06, y0: yL - hL / 2 - 0.09, y1: yL - hL / 2 - 0.04 }, 4, 3, 0.004, m);
        if (p) det.add(p);
      }
    }
    // grille
    const gStyle = car.grille;
    const gHalf = Math.max(0.12, zc - wL / 2 - 0.035);
    const gH = gStyle === 'closed' ? 0.2 : car.body === 'van' ? 0.12 : style === 'led' ? 0.12 : 0.11;
    const gy = car.body === 'van' ? yL : yL - (style === 'led' ? 0.02 : 0.0);
    const grMat = this.decalMat(TX.grilleTexture(gStyle, gStyle === 'chrome'), null, { rough: 0.35, metal: gStyle === 'chrome' ? 0.8 : 0.2 });
    const gr = this.patch('front', { z0: -gHalf, z1: gHalf, y0: gy - gH / 2, y1: gy + gH / 2 }, 12, 5, 0.003, grMat);
    if (gr) det.add(gr);
    // lower intake and front plate
    const plateY = yBotF + Math.min(0.2, (yL - hL / 2 - yBotF) * 0.55);
    if (gStyle !== 'closed' && car.body !== 'van' && car.bumpers !== 'black') {
      const it = this.patch('front', { z0: -g.W * 0.36, z1: g.W * 0.36, y0: yBotF + 0.03, y1: Math.min(plateY - 0.07, yBotF + 0.13) }, 12, 4, 0.003, this.decalMat(TX.intakeTexture(), null, { rough: 0.6 }));
      if (it) det.add(it);
    }
    this.plateMats = [];
    const pm = this.decalMat(TX.plateTexture(this.cfg.plate), null, { rough: 0.35 });
    this.plateMats.push(pm);
    const fp = this.patch('front', { z0: -0.25, z1: 0.25, y0: plateY - 0.06, y1: plateY + 0.06 }, 6, 3, 0.006, pm);
    if (fp) det.add(fp);
    // fog lamps on modern cars
    if (style === 'modern' || style === 'led') {
      for (const s of [1, -1]) {
        const m = new THREE.MeshStandardMaterial({ color: '#dfe6ee', emissive: '#ffffff', emissiveIntensity: 0.05, roughness: 0.1, metalness: 0.4 });
        const p = this.patch('front', { z0: s * g.W * 0.38 - 0.045, z1: s * g.W * 0.38 + 0.045, y0: yBotF + 0.06, y1: yBotF + 0.11 }, 4, 3, 0.004, m);
        if (p) det.add(p);
      }
    }
    // black bumpers on classics
    if (car.bumpers === 'black') {
      det.add(this.wrapStrip(true, yBotF + 0.02, yBotF + 0.13, 0.035, this.M.plastic));
      det.add(this.wrapStrip(false, Math.max(g.zBot(g.xTail), 0.15) + 0.02, Math.max(g.zBot(g.xTail), 0.15) + 0.13, 0.035, this.M.plastic));
    }
    // ---------------- rear
    const yTopR = g.zTop(g.xTail), yBotR = Math.max(g.zBot(g.xTail), 0.15);
    const hwT = g.hw(g.xTail + 0.06);
    let wT = { round: 0.15, rect: 0.24, modern90: 0.28, modern: 0.34, led: 0.4 }[style];
    let hT = { round: 0.15, rect: 0.13, modern90: 0.14, modern: 0.13, led: 0.09 }[style];
    let yT = yTopR - 0.03 - hT / 2;
    if (car.body === 'van' || car.body === 'jeep') { yT = yBotR + 0.32; wT = 0.13; hT = 0.24; }
    if (car.body === 'pickup') { yT = yTopR - 0.2; wT = 0.11; hT = 0.3; }
    wT = Math.min(wT, g.W * 0.26);
    const tlt = TX.taillightTextures(style);
    this.taillights = [];
    const zt = hwT - wT / 2 - 0.01;
    for (const s of [1, -1]) {
      const m = this.decalMat(tlt.map, tlt.emissive, { emColor: '#ff2a2a', emI: 0.35 });
      const z0 = s > 0 ? zt - wT / 2 : -zt - wT / 2;
      const p = this.patch('rear', { z0, z1: z0 + wT, y0: yT - hT / 2, y1: yT + hT / 2 }, 12, 6, 0.004, m);
      if (p) { det.add(p); this.taillights.push(p); }
      const ln = this.patch('rear', { z0: z0 - 0.006, z1: z0 + wT + 0.006, y0: yT - hT / 2 - 0.006, y1: yT + hT / 2 + 0.006 }, 12, 6, 0.01, this.lensMat('#ff4a4a', 0.2), 0.14);
      if (ln) { ln.renderOrder = 3; det.add(ln); }
    }
    if (this.taillights[1]) { const uv = this.taillights[1].geometry.getAttribute('uv'); for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); uv.needsUpdate = true; }
    // LED light bar between tail lamps on new cars
    if (style === 'led' && !['van', 'jeep', 'pickup'].includes(car.body)) {
      const m = new THREE.MeshStandardMaterial({ color: '#4a0a0e', emissive: '#ff2020', emissiveIntensity: 0.25, roughness: 0.2 });
      const p = this.patch('rear', { z0: -zt + wT / 2, z1: zt - wT / 2, y0: yT - 0.012, y1: yT + 0.012 }, 10, 2, 0.004, m);
      if (p) { det.add(p); this.taillights.push(p); }
    }
    const rpY = car.body === 'van' || car.body === 'jeep' ? yBotR + 0.15 : car.body === 'pickup' ? yTopR - 0.28 : Math.max(yBotR + 0.12, yT - hT / 2 - 0.12);
    const rpm = this.decalMat(TX.plateTexture(this.cfg.plate), null, { rough: 0.35 });
    this.plateMats.push(rpm);
    const rp = this.patch('rear', { z0: -0.25, z1: 0.25, y0: rpY - 0.06, y1: rpY + 0.06 }, 6, 3, 0.006, rpm);
    if (rp) det.add(rp);
    // rear window on box rears
    if (car.body === 'van' || car.body === 'jeep') {
      const m = new THREE.MeshPhysicalMaterial({ map: TX.windowTexture(), transparent: true, alphaTest: 0.05, roughness: 0.05, metalness: 0.1, clearcoat: 1, polygonOffset: true, polygonOffsetFactor: -2 });
      const p = this.patch('rear', { z0: -g.W * 0.36, z1: g.W * 0.36, y0: g.zBelt + 0.02, y1: g.H - 0.16 }, 8, 4, 0.004, m);
      if (p) det.add(p);
      if (car.body === 'jeep') {
        const sp = buildWheel({ R: g.R, rim: g.tyre.d, width: g.tyre.w / 1000, style: 'offroad', rimColor: '#2a2c30', tyres: 'at', caliper: '#222' });
        sp.rotation.y = -Math.PI / 2;
        sp.position.set(g.xTail - g.tyre.w / 2000 - 0.02, g.zBelt - 0.05, 0);
        sp.children.forEach((c) => { if (!c.isGroup) c.visible = false; });
        det.add(sp);
        this.spare = sp;
      }
    }
    // mirrors
    const mx = g.xCowl - 0.13;
    for (const s of [1, -1]) {
      const sz = this.sideZ(mx, g.zBelt - 0.02) ?? g.W / 2;
      const grp = new THREE.Group();
      const housing = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), this.paint);
      housing.scale.set(0.075, 0.055, 0.1);
      housing.position.set(-0.02, 0.07, s * 0.1);
      const glassM = new THREE.Mesh(new THREE.CircleGeometry(0.05, 16), this.M.chrome);
      glassM.position.set(-0.08, 0.07, s * 0.1); glassM.rotation.y = -Math.PI / 2; glassM.scale.set(1.4, 1, 1);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.03, 0.08), this.M.trim);
      arm.position.set(0, 0.035, s * 0.04);
      grp.add(housing, glassM, arm);
      grp.position.set(mx, g.zBelt, s * sz);
      det.add(grp);
    }
    // door handles
    const hm = car.era === 'classic' ? this.M.chrome : this.paint;
    for (const hx of L.handles) for (const s of [1, -1]) {
      const y = g.zBelt - 0.075;
      const z = this.sideZ(hx, y);
      if (z == null) continue;
      const hnd = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.022, 0.018), hm);
      hnd.position.set(hx, y, s * (z + 0.006));
      det.add(hnd);
    }
    // wipers
    for (const zz of [0.05, -g.W * 0.32]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.01, g.W * 0.36), this.M.trim);
      const x = g.xCowl - 0.05;
      w.position.set(x, (this.topY(x, zz) ?? g.zCowl) + 0.012, zz + g.W * 0.12);
      w.rotation.y = 0.12;
      det.add(w);
    }
    // antenna
    if (car.era === 'classic') {
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.004, 0.7, 6), this.M.chrome);
      ant.position.set(g.xCowl - 0.05, g.zCowl + 0.35, (this.sideZ(g.xCowl - 0.05, g.zCowl) ?? g.W / 2) + 0.01);
      ant.rotation.z = 0.35;
      det.add(ant);
    } else if (!['pickup', 'van'].includes(car.body)) {
      const fin = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), this.M.trim);
      fin.scale.set(0.09, 0.05, 0.022);
      const fx = g.xRoofR + 0.08;
      fin.position.set(fx, this.topY(fx, 0) ?? g.H, 0);
      det.add(fin);
    }
    this.buildBeltMouldings(det);
    // exhaust tips
    this.buildExhaust();
    // underglow plane
    const glowM = new THREE.MeshBasicMaterial({ map: TX.glowTexture(), color: '#000000', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(g.L * 1.55, g.W * 2.5), glowM);
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.012;
    glow.renderOrder = 1;
    this.wheelRoot.add(glow);
    this.glowPlane = glow;
  }

  // A strip that follows the body outline around the nose or tail (bumpers, lips).
  wrapStrip(front, y0, y1, out, material, reach = 0.32) {
    const g = this.geo;
    const ym = (y0 + y1) / 2;
    const pts = [];
    const xEnd = front ? g.xNose : g.xTail;
    const xs = this.xs.filter((x) => (front ? x > xEnd - reach : x < xEnd + reach));
    const ordered = front ? xs : xs.slice().reverse();
    for (const x of ordered) { const z = this.sideZ(x, ym); if (z != null) pts.push([x, z]); }
    const last = pts[pts.length - 1];
    if (!last) return new THREE.Group();
    const faceHalf = last[1];
    const n = 8;
    for (let i = 1; i < n; i++) pts.push([xEnd, faceHalf * (1 - (2 * i) / n)]);
    const mirror = pts.slice(0, -n + 1).reverse().map(([x, z]) => [x, -z]);
    const path = pts.concat(mirror);
    const pos = [], idx = [];
    for (let i = 0; i < path.length; i++) {
      const [x, z] = path[i];
      const [xa, za] = path[Math.max(0, i - 1)], [xb, zb] = path[Math.min(path.length - 1, i + 1)];
      let nx = zb - za, nz = -(xb - xa);
      const len = Math.hypot(nx, nz) || 1; nx /= len; nz /= len;
      // outward = away from car centre
      if (nx * (x - (front ? g.xNose - 0.6 : g.xTail + 0.6)) + nz * z < 0) { nx = -nx; nz = -nz; }
      pos.push(x, y0, z, x + nx * out, y0, z + nz * out, x + nx * out, y1, z + nz * out, x, y1, z);
    }
    for (let i = 0; i < path.length - 1; i++) {
      const a = i * 4, b = (i + 1) * 4;
      idx.push(a + 1, b + 1, b + 2, a + 1, b + 2, a + 2); // outer
      idx.push(a + 2, b + 2, b + 3, a + 2, b + 3, a + 3); // top
      idx.push(a, b, b + 1, a, b + 1, a + 1); // bottom
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    gg.setIndex(idx);
    gg.computeVertexNormals();
    const m = new THREE.Mesh(gg, material.clone ? material : material);
    m.material = material.clone(); m.material.side = THREE.DoubleSide;
    return m;
  }

  buildExhaust() {
    const g = this.geo, cfg = this.cfg;
    if (this.exhaust) { this.body.remove(this.exhaust); this.exhaust.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); }
    const grp = new THREE.Group(); this.exhaust = grp; this.body.add(grp);
    this.flames = [];
    const ev = this.info.engine.fuel === 'electric';
    if (ev) return;
    let mode = cfg.tips || 'auto';
    if (mode === 'auto') mode = cfg.exhaust === 'straight' ? 'dual' : cfg.exhaust === 'sport' ? 'dual' : 'single';
    const r = cfg.exhaust === 'straight' ? 0.048 : cfg.exhaust === 'sport' ? 0.042 : 0.028;
    const yB = Math.max(g.zBot(g.xTail + 0.05), 0.16);
    const y = Math.max(g.GC + 0.06, yB - 0.035);
    let zs;
    if (mode === 'single') zs = [-g.W * 0.3];
    else if (mode === 'dual') zs = [-g.W * 0.33, g.W * 0.33];
    else if (mode === 'quad') zs = [-g.W * 0.36, -g.W * 0.28, g.W * 0.28, g.W * 0.36];
    else zs = [-0.075, 0, 0.075];
    const tipMat = cfg.exhaust === 'stock' && mode === 'single' ? this.M.darkMetal : this.M.chrome;
    for (const z of zs) {
      const x = (this.endX(y + 0.05, z, false) ?? g.xTail) - 0.02;
      const len = 0.16;
      const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.95, len, 20, 1, true), tipMat);
      t.rotation.z = Math.PI / 2; t.position.set(x + len / 2 - 0.05, y, z);
      const inner = new THREE.Mesh(new THREE.CircleGeometry(r * 0.92, 20), this.M.under);
      inner.rotation.y = -Math.PI / 2; inner.position.set(x - 0.045, y, z);
      grp.add(t, inner);
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.42), new THREE.MeshBasicMaterial({ map: TX.flameTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      fl.rotation.z = Math.PI / 2; fl.position.set(x - 0.25, y, z); fl.visible = false;
      const fl2 = fl.clone(); fl2.rotation.x = Math.PI / 2;
      grp.add(fl, fl2);
      this.flames.push(fl, fl2);
    }
  }

  buildArchLiners() {
    const g = this.geo;
    const track = g.W - 2 * (g.tyre.w / 1000) - 0.05;
    for (const xa of [g.xF, g.xR]) {
      const geom = new THREE.CylinderGeometry(g.Ra - 0.004, g.Ra - 0.004, Math.max(0.2, g.W - 0.06), 28, 1, true, -Math.PI / 2, Math.PI);
      geom.rotateX(-Math.PI / 2); // upper half: the wheel-well roof seen through the arch
      const m = new THREE.Mesh(geom, this.M.liner);
      m.position.set(xa, g.R, 0);
      this.body.add(m);
      (this.liners || (this.liners = [])).push(m);
      const inner = new THREE.Mesh(new THREE.BoxGeometry(g.Ra * 1.9, g.Ra, Math.max(0.1, track - 0.2)), this.M.under);
      inner.position.set(xa, g.R + g.Ra * 0.45, 0);
      this.body.add(inner);
      this.liners.push(inner);
    }
  }

  buildInterior() {
    const g = this.geo, car = this.car, L = this.layout;
    const grp = new THREE.Group(); this.interior = grp; this.body.add(grp);
    const M = this.M;
    const floorY = Math.max(g.GC + 0.12, g.zBelt - 0.55);
    const seatW = Math.min(0.5, g.W * 0.3);
    const fx = L.seatFront;
    const dz = g.W * 0.22;
    const seat = (x, z, w, light) => {
      const s = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, w), light ? M.interiorLight : M.interior); base.position.set(0, floorY + 0.22, 0);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.58, w * 0.95), light ? M.interiorLight : M.interior); back.position.set(-0.24, floorY + 0.55, 0); back.rotation.z = 0.2;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, w * 0.55), M.interior); head.position.set(-0.32, floorY + 0.9, 0); head.rotation.z = 0.2;
      s.add(base, back, head); s.position.set(x, 0, z);
      return s;
    };
    const light = car.id.includes('fortuner') || car.id.includes('lc300') || car.id.includes('sonata');
    if (L.cabinLen > 0.6) {
      grp.add(seat(fx, dz, seatW, light), seat(fx, -dz, seatW, light));
      if (L.cabinLen > 1.4 && car.body !== 'pickup') grp.add(seat(fx - 0.85, 0, g.W * 0.7, light));
      else if (car.body === 'pickup') grp.add(seat(fx - 0.78, 0, g.W * 0.7, light));
    }
    const dashTop = g.zBelt + 0.03;
    let dashFront = g.xCowl - 0.1;
    for (let x = g.xCowl - 0.05; x > g.xCowl - 0.9; x -= 0.02) { const ty = this.topY(x, 0); if (ty != null && ty > dashTop + 0.05) { dashFront = x; break; } }
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, g.W * 0.82), M.interior);
    dash.position.set(dashFront - 0.2, dashTop - 0.08, 0);
    grp.add(dash);
    const sw = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.018, 8, 28), M.interior);
    sw.position.set(dashFront - 0.48, g.zBelt + 0.04, dz);
    sw.rotation.y = Math.PI / 2; sw.rotation.x = 0; sw.rotation.z = 0.0;
    sw.rotateOnAxis(new THREE.Vector3(0, 0, 1), 0.45);
    grp.add(sw);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.5, L.cabinLen), 0.02, g.W * 0.86), M.interior);
    floor.position.set(L.cabinMid, floorY, 0);
    grp.add(floor);
    // roll cage
    this.cage = new THREE.Group();
    const tubeM = new THREE.MeshStandardMaterial({ color: '#c8102e', roughness: 0.4, metalness: 0.5 });
    const hoopX = fx - 0.4;
    const roofY = g.H - 0.07;
    for (const x of [hoopX, g.xCowl - 0.3]) {
      const pts = [[x, floorY, -g.W * 0.4], [x, roofY - 0.06, -g.W * 0.36], [x, roofY, -g.W * 0.25], [x, roofY, g.W * 0.25], [x, roofY - 0.06, g.W * 0.36], [x, floorY, g.W * 0.4]];
      const c = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
      this.cage.add(new THREE.Mesh(new THREE.TubeGeometry(c, 30, 0.02, 8), tubeM));
    }
    for (const s of [1, -1]) {
      const c = new THREE.LineCurve3(new THREE.Vector3(hoopX, roofY, s * g.W * 0.25), new THREE.Vector3(hoopX - 0.9, floorY + 0.2, s * g.W * 0.36));
      this.cage.add(new THREE.Mesh(new THREE.TubeGeometry(c, 2, 0.02, 8), tubeM));
    }
    this.cage.visible = false;
    grp.add(this.cage);
  }

  // ---------------------------------------------------------------- kits
  buildKits() {
    const g = this.geo, car = this.car, cfg = this.cfg;
    const K = this.kits;
    while (K.children.length) { const c = K.children.pop(); c.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); } }); }
    const trim = this.M.trim;
    const carbonish = cfg.hood === 'carbon' ? this.M.carbon : trim;
    if (cfg.lip) {
      const yb = Math.max(g.zBot(g.xNose - 0.03), 0.12);
      K.add(this.wrapStrip(true, yb - 0.016, yb - 0.002, 0.055, carbonish, 0.45));
    }
    if (cfg.skirts) {
      const x0 = g.xR + g.Ra + 0.04, x1 = g.xF - g.Ra - 0.04;
      for (const s of [1, -1]) {
        const y = g.GC + 0.045;
        const z = (this.sideZ((x0 + x1) / 2, y + 0.04) ?? g.W / 2) + 0.012;
        const sk = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.07, 0.035), carbonish);
        sk.position.set((x0 + x1) / 2, y, s * z);
        K.add(sk);
      }
    }
    if (cfg.diffuser) {
      const yb = Math.max(g.zBot(g.xTail + 0.05), 0.15);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.015, g.W * 0.7), carbonish);
      plate.position.set(g.xTail + 0.14, yb - 0.02, 0); plate.rotation.z = -0.12;
      K.add(plate);
      for (let i = 0; i < 5; i++) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.012), carbonish);
        f.position.set(g.xTail + 0.13, yb - 0.05, (i - 2) * g.W * 0.15);
        K.add(f);
      }
    }
    // spoilers
    const sp = cfg.spoiler || 'none';
    const rear = g.tpl.rear;
    if (sp !== 'none') {
      const spMat = sp === 'wing' ? this.M.carbon : this.paint;
      if (sp === 'wing') {
        let x, y;
        if (rear === 'notch') { x = g.xTail + 0.2; y = (this.topY(x, 0) ?? g.zDeck) + 0.24; }
        else if (rear === 'hatch' && g.tpl.rw < 40) { x = g.xTail + 0.18; y = (this.topY(x, 0) ?? g.zHatch) + 0.2; }
        else if (rear === 'bed') { x = g.xTail + 0.25; y = g.zRail + 0.32; }
        else { x = g.xRoofR + 0.06; y = g.H + 0.12; }
        const shape = new THREE.Shape();
        shape.moveTo(0.16, 0); shape.quadraticCurveTo(0.05, 0.05, -0.12, 0.02); shape.lineTo(-0.13, -0.005); shape.quadraticCurveTo(0.02, 0.01, 0.16, 0);
        const wg = new THREE.ExtrudeGeometry(shape, { depth: g.W * 0.9, bevelEnabled: false, curveSegments: 12 });
        wg.translate(0, 0, -g.W * 0.45);
        const wing = new THREE.Mesh(wg, spMat); wing.position.set(x, y, 0); wing.rotation.z = 0.08;
        K.add(wing);
        for (const s of [1, -1]) {
          const ep = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.008), trim); ep.position.set(x + 0.01, y + 0.01, s * g.W * 0.45); K.add(ep);
          const baseY = this.topY(x, s * g.W * 0.28) ?? (y - 0.2);
          const st = new THREE.Mesh(new THREE.BoxGeometry(0.06, y - baseY, 0.012), trim); st.position.set(x, (y + baseY) / 2, s * g.W * 0.28); K.add(st);
        }
      } else {
        const big = sp === 'ducktail';
        let x, y, zw = g.W * 0.82;
        if (rear === 'notch' && sp !== 'roof') { x = g.xTail + 0.05; y = this.topY(x + 0.02, 0) ?? g.zDeck; }
        else { x = g.xRoofR - 0.02; y = this.topY(x + 0.05, 0) ?? g.H; zw = g.W * 0.7; }
        const shape = new THREE.Shape();
        const h = big ? 0.07 : 0.03, d = big ? 0.2 : 0.12;
        shape.moveTo(d * 0.6, 0); shape.lineTo(-d * 0.4, h); shape.lineTo(-d * 0.45, h * 0.6); shape.lineTo(-d * 0.2, 0); shape.closePath();
        const gg = new THREE.ExtrudeGeometry(shape, { depth: zw, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 2 });
        gg.translate(0, 0, -zw / 2);
        const m = new THREE.Mesh(gg, rear === 'notch' && sp !== 'roof' ? this.paint : this.paint);
        m.position.set(x, y - 0.004, 0);
        K.add(m);
      }
    }
    // hood
    const hx0 = g.xCowl + 0.12, hx1 = g.xNose - 0.25;
    const needsScoop = this.info.fit && this.info.fit.needsScoop && this.info.engine.fuel !== 'electric';
    if ((cfg.hood === 'scoop' || needsScoop) && hx1 > hx0 && car.body !== 'van') {
      const xm = hx0 + (hx1 - hx0) * 0.35;
      const yS = this.topY(xm, 0) ?? g.zCowl;
      const sh = new THREE.Shape();
      const len = Math.min(0.55, (hx1 - hx0) * 0.8), hgt = needsScoop ? 0.11 : 0.07;
      sh.moveTo(-len / 2, 0); sh.lineTo(len / 2, 0); sh.lineTo(len / 2 - 0.02, hgt); sh.quadraticCurveTo(-len / 4, hgt * 1.05, -len / 2, 0.01); sh.closePath();
      const sg = new THREE.ExtrudeGeometry(sh, { depth: 0.36, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 3 });
      sg.translate(0, 0, -0.18);
      const scoop = new THREE.Mesh(sg, this.paint);
      scoop.position.set(xm, yS - 0.01, 0); scoop.rotation.z = -0.03;
      K.add(scoop);
      const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.34, hgt * 0.75), this.M.under);
      mouth.rotation.y = Math.PI / 2; mouth.position.set(xm + len / 2 + 0.005, yS + hgt * 0.45, 0);
      K.add(mouth);
    }
    if (cfg.hood === 'vented' && hx1 > hx0) {
      const vm = this.decalMat(TX.ventTexture(), null, { rough: 0.5 });
      for (const s of [1, -1]) {
        const p = this.patch('top', { x0: hx0 + (hx1 - hx0) * 0.35, x1: hx0 + (hx1 - hx0) * 0.75, z0: s * g.W * 0.18 - 0.1, z1: s * g.W * 0.18 + 0.1 }, 5, 4, 0.004, vm);
        if (p) K.add(p);
      }
    }
    // widebody flares
    if (cfg.widebody) {
      for (const xa of [g.xF, g.xR]) for (const s of [1, -1]) {
        const tg = new THREE.TorusGeometry(g.Ra + 0.015, 0.03, 8, 28, Math.PI);
        const fl = new THREE.Mesh(tg, trim);
        fl.scale.set(1, 1, 0.6);
        fl.position.set(xa, g.R, s * (g.hw(xa) - 0.005));
        K.add(fl);
      }
    }
    // roof accessories
    const ra = cfg.roofAcc || 'none';
    if (ra !== 'none' && g.xRoofF - g.xRoofR > 0.4) {
      const x0 = g.xRoofR + 0.08, x1 = g.xRoofF - 0.05;
      const yR = (this.topY((x0 + x1) / 2, 0) ?? g.H) + 0.06;
      const rw = (this.halfRingWidthAt((x0 + x1) / 2) ?? g.W * 0.35) - 0.06;
      const rails = () => {
        for (const s of [1, -1]) { const r = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.03, 0.03), this.M.darkMetal); r.position.set((x0 + x1) / 2, yR, s * rw); K.add(r); }
        for (const t of [0.2, 0.8]) { const c = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.025, rw * 2 + 0.06), this.M.trim); c.position.set(lerp(x0, x1, t), yR + 0.025, 0); K.add(c); }
      };
      if (ra === 'rack' || ra === 'luggage') rails();
      if (ra === 'box') {
        rails();
        const b = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.MeshPhysicalMaterial({ color: '#16171a', roughness: 0.3, clearcoat: 1 }));
        b.scale.set((x1 - x0) * 0.45, 0.11, rw * 0.75); b.position.set((x0 + x1) / 2, yR + 0.1, 0);
        K.add(b);
      }
      if (ra === 'luggage') {
        const cols = ['#7a3b1d', '#1f4f7a', '#2f6b35', '#8c1c2a', '#c79a2b'];
        let xx = x0 + 0.08;
        for (let i = 0; xx < x1 - 0.15; i++) {
          const bw = 0.25 + (i % 3) * 0.1, bh = 0.14 + (i % 2) * 0.08;
          const bx = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, rw * 1.6 * (0.7 + (i % 2) * 0.25)), new THREE.MeshStandardMaterial({ color: cols[i % cols.length], roughness: 0.85 }));
          bx.position.set(xx + bw / 2, yR + 0.04 + bh / 2, ((i % 3) - 1) * 0.05); bx.rotation.y = (i % 2 ? 0.08 : -0.06);
          K.add(bx); xx += bw + 0.03;
        }
        const rope = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.01, 0.012), new THREE.MeshStandardMaterial({ color: '#d6c79a' }));
        rope.position.set((x0 + x1) / 2, yR + 0.26, 0); K.add(rope);
      }
      if (ra === 'lightbar') {
        const lb = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, rw * 2), this.M.trim);
        lb.position.set(x1 - 0.05, yR + 0.04, 0); K.add(lb);
        const lens = new THREE.Mesh(new THREE.PlaneGeometry(rw * 1.9, 0.05), new THREE.MeshStandardMaterial({ color: '#e8f2ff', emissive: '#e8f2ff', emissiveIntensity: 0.3 }));
        lens.rotation.y = Math.PI / 2; lens.position.set(x1 - 0.005, yR + 0.04, 0); K.add(lens);
        this.lightbarLens = lens;
        for (const s of [1, -1]) { const st = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.03), this.M.trim); st.position.set(x1 - 0.05, yR - 0.02, s * rw * 0.95); K.add(st); }
      }
    }
    // bull bar
    if (cfg.bullbar) {
      const x = g.xNose + 0.09;
      const yb = Math.max(g.zBot(g.xNose), 0.2);
      const yt = g.zTop(g.xNose) + 0.02;
      const zw = g.W * 0.3;
      const pts = [[x - 0.06, yb, -zw], [x, yt - 0.05, -zw], [x, yt, -zw * 0.6], [x, yt, zw * 0.6], [x, yt - 0.05, zw], [x - 0.06, yb, zw]];
      const c = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
      K.add(new THREE.Mesh(new THREE.TubeGeometry(c, 40, 0.028, 10), this.M.chrome));
      const c2 = new THREE.LineCurve3(new THREE.Vector3(x + 0.01, (yb + yt) / 2, -zw), new THREE.Vector3(x + 0.01, (yb + yt) / 2, zw));
      K.add(new THREE.Mesh(new THREE.TubeGeometry(c2, 2, 0.022, 10), this.M.chrome));
    }
    if (cfg.snorkel) {
      const xs = g.xF + 0.05;
      const zR = (this.sideZ(xs, g.zBelt - 0.1) ?? g.W / 2) + 0.03;
      const raw = [[xs, g.zBelt - 0.25], [g.xCowl + 0.04, g.zBelt - 0.04], [g.xCowl - 0.06, g.zBelt + 0.1], [lerp(g.xCowl, g.xRoofF, 0.55), lerp(g.zCowl, g.H, 0.55)], [g.xRoofF + 0.05, g.H - 0.04]];
      const pts = raw.map(([x, y]) => [x, y, (this.sideZ(x, y) ?? zR) + 0.045]);
      const top = pts[pts.length - 1];
      pts.push([top[0] - 0.02, top[1] + 0.12, top[2] - 0.01]);
      const c = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
      K.add(new THREE.Mesh(new THREE.TubeGeometry(c, 40, 0.035, 10), this.M.trim));
      const hd = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 12), this.M.trim); hd.position.set(top[0] + 0.02, top[1] + 0.13, top[2] - 0.01); hd.rotation.z = Math.PI / 2; K.add(hd);
    }
    if (cfg.mudflaps) {
      for (const xa of [g.xF, g.xR]) for (const s of [1, -1]) {
        const mf = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.22, g.tyre.w / 1000 + 0.02), this.M.rubber);
        mf.position.set(xa - g.Ra - 0.01, g.GC + 0.02, s * (g.hw(xa) - g.tyre.w / 2000 - 0.02));
        K.add(mf);
      }
    }
    if (cfg.towhook) {
      const th = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.009, 6, 16), new THREE.MeshStandardMaterial({ color: '#e01b24', roughness: 0.4 }));
      const z = g.W * 0.3, y = Math.max(g.zBot(g.xNose), 0.15) + 0.06;
      th.position.set((this.endX(y, z, true) ?? g.xNose) + 0.02, y, z); th.rotation.y = Math.PI / 2;
      K.add(th);
    }
    if (this.cage) this.cage.visible = !!cfg.cage;
  }

  halfRingWidthAt(x) {
    const i = this.stationIndex(x);
    const r = this.halfRings[i];
    if (!r.cabin) return null;
    // lateral position of the roof edge (start of segment G)
    const p = r.pts;
    const h = p.length / 2;
    return p[(h - 6) * 2];
  }

  // ---------------------------------------------------------------- wheels
  buildWheels() {
    const g = this.geo, cfg = this.cfg, info = this.info;
    if (this.wheels) { for (const w of this.wheels) { this.wheelRoot.remove(w); disposeWheel(w); } }
    this.wheels = [];
    const R = info.veh ? info.veh.r : g.R;
    const width = ((info.veh ? info.veh.tyreW : g.tyre.w) / 1000) * 1.0;
    const rim = cfg.rimSize || g.tyre.d;
    const chrome = (cfg.rimColor || '').toLowerCase() === '#f4f4f4';
    for (const [xa, front] of [[g.xF, true], [g.xR, false]]) for (const s of [1, -1]) {
      const w = buildWheel({ R, rim, width, style: cfg.rimStyle, rimColor: cfg.rimColor, chrome, caliper: cfg.caliper, bbk: cfg.brakes === 'bbk' || cfg.brakes === 'ceramic', ceramic: cfg.brakes === 'ceramic', tyres: cfg.tyres, classic: this.car.era === 'classic', caliperAngle: front ? 2.4 : 2.6, lugs: this.car.kerb < 900 ? 4 : 5 });
      const zOut = g.hw(xa) - width / 2 - 0.018 + (cfg.widebody ? 0.03 : 0);
      w.position.set(xa, R, s * zOut);
      w.userData.side = s;
      if (s < 0) w.rotation.y = Math.PI;
      this.wheelRoot.add(w);
      this.wheels.push(w);
    }
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: TX.shadowTexture(), transparent: true, depthWrite: false, opacity: 0.85, color: '#000' }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = 0.006; sh.scale.set(g.L * 1.18, g.W * 1.32, 1); sh.renderOrder = 1;
    this.wheelRoot.add(sh);
    this.shadow = sh;
    this.wheelShadows = [];
    for (const w of this.wheels) {
      const s2 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sh.material);
      s2.rotation.x = -Math.PI / 2; s2.position.set(w.position.x, 0.008, w.position.z); s2.scale.set(R * 1.6, width * 1.8, 1);
      this.wheelRoot.add(s2);
      this.wheelShadows.push(s2);
    }
  }

  // ---------------------------------------------------------------- engine
  buildEngine() {
    const g = this.geo, info = this.info;
    if (this.engineGroup) { this.body.remove(this.engineGroup); this.engineGroup.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose?.(); } }); }
    const grp = new THREE.Group(); this.engineGroup = grp; this.body.add(grp);
    const e = info.engine;
    const fit = info.fit;
    const bay = fit ? fit.bay : engineBay(this.car, g);
    const em = buildEngineModel(e, this.cfg);
    const [Le, We, He] = e.dim.map((v) => v / 1000);
    const drive = info.veh ? info.veh.drive : this.car.drive;
    if (e.fuel === 'electric') {
      const placeMotor = (x) => { const m = buildEngineModel(e, this.cfg); m.position.set(x, g.R + 0.02, 0); m.rotation.y = Math.PI / 2; grp.add(m); };
      if (drive === 'AWD') { placeMotor(g.xF); placeMotor(g.xR); }
      else placeMotor(drive === 'RWD' ? g.xR : g.xF);
      const bl = buildBattery((g.xF - g.xR) - g.Ra * 2 - 0.1, g.W * 0.72, e.ev.kwh);
      bl.position.set((g.xF + g.xR) / 2, g.GC + 0.06, 0);
      grp.add(bl);
    } else {
      const inst = fit ? fit.installed : 'T';
      let x, y = bay.floor + He / 2 + 0.02;
      if (bay.mid) x = bay.cx;
      else if (inst === 'T') x = g.xF + 0.04;
      else x = g.xF + 0.3 - Le / 2;
      em.position.set(x, y, 0);
      if (inst === 'T') em.rotation.y = Math.PI / 2;
      grp.add(em);
      if (e.hyb) {
        const bl = buildBattery(0.45, g.W * 0.55, 8);
        bl.position.set(g.xR + g.Ra + 0.2, g.GC + 0.3, 0);
        grp.add(bl);
      }
      // bay outline in X-ray
      const ok = !fit || (fit.over.len < 0.02 && fit.over.wid < 0.02 && fit.over.ht < 0.03);
      const bx = new THREE.BoxGeometry(bay.len, bay.ht, bay.wid);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(bx), new THREE.LineBasicMaterial({ color: ok ? '#46d17d' : '#ff5d5d', transparent: true, opacity: 0.9 }));
      bx.dispose();
      edges.position.set(bay.mid ? bay.cx : bay.cx, bay.floor + bay.ht / 2, 0);
      edges.visible = false;
      grp.add(edges);
      this.bayBox = edges;
    }
    grp.visible = this.xray;
    this.engineCenter = new THREE.Vector3(bay.cx ?? g.xF, (bay.floor ?? g.GC) + 0.3, 0);
  }

  // ---------------------------------------------------------------- lights
  buildLights() {
    const g = this.geo;
    if (this.lightRig) { this.root.remove(this.lightRig); }
    const rig = new THREE.Group(); this.lightRig = rig; this.root.add(rig);
    this.beams = [];
    for (const s of [1, -1]) {
      const sp = new THREE.SpotLight('#fff6e8', 0, 18, 0.5, 0.6, 1.4);
      sp.position.set(g.xNose - 0.05, g.zTop(g.xNose) - 0.06, s * g.W * 0.32);
      sp.target.position.set(g.xNose + 6, 0, s * g.W * 0.5);
      rig.add(sp, sp.target);
      this.beams.push(sp);
    }
    this.glowLight = new THREE.PointLight('#ffffff', 0, 4, 1.5);
    this.glowLight.position.set(0, 0.12, 0);
    rig.add(this.glowLight);
  }

  // ---------------------------------------------------------------- state updates
  applyVisuals(cfg) {
    this.cfg = { ...this.cfg, ...cfg };
    const c = this.cfg;
    applyPaint(this.paint, c.paint, c.finish);
    applyLivery(this.paint, c.livery, c.liveryColor, c.paint);
    if (c.roof) { applyPaint(this.roofMat, c.roof, c.finish === 'matte' ? 'matte' : 'gloss'); applyLivery(this.roofMat, 'none', '#fff', c.roof); }
    else { applyPaint(this.roofMat, c.paint, c.finish); applyLivery(this.roofMat, c.livery === 'carbon' || c.livery === 'camo' || c.livery === 'truckart' || c.livery === 'stripes' ? c.livery : 'none', c.liveryColor, c.paint); }
    const carbonHood = c.hood === 'carbon' && this.car.body !== 'van';
    this.paint.userData.u.uHood.value.w = carbonHood ? 1 : 0;
    setTint(this.glass, c.tint ?? 25);
    for (const pm of this.plateMats || []) { pm.map?.dispose(); pm.map = TX.plateTexture(c.plate); pm.needsUpdate = true; }
    if (this.wheels) for (const w of this.wheels) {
      const u = w.userData;
      const chrome = (c.rimColor || '').toLowerCase() === '#f4f4f4';
      u.rimMat.color.set(c.rimColor || '#c9cdd2');
      u.rimMat.metalness = chrome ? 1 : 0.75; u.rimMat.roughness = chrome ? 0.06 : 0.28;
      u.calMat.color.set(c.caliper || '#3a3d42');
    }
    const hl = TX.headlightTextures(this.car.lights, c.headlight || 'white');
    for (const h of this.headlights || []) { h.material.map = hl.map; h.material.emissiveMap = hl.emissive; h.material.needsUpdate = true; }
    const beamCol = c.headlight === 'warm' ? '#ffd9a0' : c.headlight === 'ice' ? '#cfe9ff' : '#f4f8ff';
    for (const b of this.beams || []) b.color.set(beamCol);
    if (this.glowPlane) {
      this.glowPlane.material.color.set(c.underglow || '#000000');
      this.glowPlane.visible = !!c.underglow;
    }
    if (this.glowLight) { this.glowLight.color.set(c.underglow || '#ffffff'); this.glowLight.intensity = c.underglow ? (this.night ? 6 : 1.5) : 0; }
    if (this.custom) this.custom.applyPaint(c.paint, c.finish, this.customPaint !== false);
  }

  setRide(cfg) {
    const o = rideOffset(cfg) / 1000;
    if (this.body) this.body.position.y = o;
    if (this.custom) this.custom.root.position.y = o;
    for (const m of [this.paint, this.roofMat]) m.userData.u.uOrigin.value.set(0, o, 0);
  }

  setXray(on) {
    this.xray = on;
    if (!this.body) return;
    for (const m of [this.paint, this.roofMat]) { m.transparent = on; m.opacity = on ? 0.13 : 1; m.depthWrite = !on; m.needsUpdate = true; }
    this.glass.visible = !on;
    if (this.interior) this.interior.visible = !on || !!this.cfg.cage;
    if (this.details) this.details.visible = !on;
    if (this.kits) this.kits.visible = !on;
    if (this.engineGroup) this.engineGroup.visible = on;
    if (this.bayBox) this.bayBox.visible = on;
    this.trimMat.transparent = on; this.trimMat.opacity = on ? 0.15 : 1; this.trimMat.needsUpdate = true;
    this.M.under.transparent = on; this.M.under.opacity = on ? 0.1 : 1; this.M.under.depthWrite = !on; this.M.under.needsUpdate = true;
    this.M.liner.visible = !on;
    if (this.custom) this.custom.setXray(on);
    this.applyCustomVisibility();
  }

  setNight(on) {
    this.night = on;
    const em = on ? 2.4 : 0.35;
    for (const h of this.headlights || []) h.material.emissiveIntensity = em;
    for (const t of this.taillights || []) t.material.emissiveIntensity = on ? 1.6 : 0.3;
    for (const b of this.beams || []) b.intensity = on ? 30 : 0;
    if (this.lightbarLens) this.lightbarLens.material.emissiveIntensity = on ? 2 : 0.3;
    if (this.glowLight) this.glowLight.intensity = this.cfg.underglow ? (on ? 6 : 1.5) : 0;
    if (this.glowPlane) this.glowPlane.material.opacity = on ? 1 : 0.55;
  }

  spinWheels(dist) {
    if (this.custom) this.custom.spin(dist);
    if (!this.wheels) return;
    for (const w of this.wheels) {
      const r = w.userData.R;
      w.userData.spin.rotation.z = -(dist / r) * ((w.userData.side || 1) < 0 ? -1 : 1);
    }
  }

  // drive mode: wheel i (FR, FL, RR, RL) spun by its own angle and steered
  setWheelPose(i, spin, steer) {
    const w = this.wheels && this.wheels[i];
    if (!w) return;
    const side = w.userData.side || 1;
    w.rotation.y = (side < 0 ? Math.PI : 0) + steer;
    w.userData.spin.rotation.z = -spin * (side < 0 ? -1 : 1);
  }

  setFlames(on) {
    for (const f of this.flames) { f.visible = on; if (on) { f.scale.setScalar(0.7 + Math.random() * 0.6); f.material.opacity = 0.7 + Math.random() * 0.3; } }
  }
}

// Window spans, pillar positions, seams and seats derived from the body geometry.
export function computeLayout(car, g) {
  const tpl = g.tpl;
  const sideWins = [];
  const k = g.WB / 2.65;
  const threeDoor = car.doors === 3;
  const xB = Math.min(g.xRoofF - 0.08, g.xCowl - (threeDoor ? 1.28 : 1.05) * k);
  let xRearEnd;
  if (tpl.rear === 'notch') xRearEnd = g.xRoofR + 0.08;
  else if (tpl.rear === 'hatch') xRearEnd = g.xRoofR + (car.body === 'suv' || car.body === 'bigsuv' ? 0.2 : 0.26);
  else if (tpl.rear === 'box') xRearEnd = g.xTail + 0.12;
  else xRearEnd = g.xRoofR + 0.08;
  const pillars = tpl.pillars;
  const bp = 0.045;
  const front = [xB + bp, g.xCowl + 0.03];
  if (pillars === 'jeep') {
    sideWins.push(front);
    sideWins.push([xRearEnd, xB - 0.09]);
  } else if (pillars === 'van') {
    const xb = g.xF - 0.12;
    sideWins.push([xb + bp, g.xCowl + 0.03]);
    const xc = g.xR + 0.25;
    sideWins.push([xc + bp, xb - bp - 0.04]);
    sideWins.push([xRearEnd, xc - bp]);
  } else if (pillars === 'suv') {
    sideWins.push(front);
    const xc = Math.max(g.xR + 0.1, xRearEnd + 0.3);
    sideWins.push([xc + bp, xB - bp]);
    if (xc - bp - xRearEnd > 0.12) sideWins.push([xRearEnd, xc - bp]);
  } else if (tpl.rear === 'hatch' && tpl.rw < 45) {
    // sloping liftback: rear door glass runs to the door edge, then a quarter glass under the falling roof
    sideWins.push(front);
    const seamR = g.xR + g.Ra + 0.04;
    const run = (g.H - g.zHatch) / Math.tan((tpl.rw * Math.PI) / 180);
    const q0 = Math.max(g.xTail + 0.32, g.xRoofR - run * 0.42), q1 = seamR - 0.05;
    sideWins.push([Math.min(seamR + 0.03, xB - bp - 0.3), xB - bp]);
    if (q1 - q0 > 0.15) sideWins.push([q0, q1]);
  } else {
    sideWins.push(front);
    sideWins.push([xRearEnd, xB - bp]);
  }
  const firstStart = Math.min(...sideWins.map((w) => w[0]));
  const lastEnd = Math.max(...sideWins.map((w) => w[1]));
  const blackPillars = car.era !== 'classic' && car.body !== 'van';
  const topZone = (x) => {
    if (x > g.xCowl + 0.005) return 'body';
    if (x >= g.xRoofF) return 'glass';
    if (x >= g.xRoofR) return 'roof';
    if (tpl.rear === 'notch') return x >= g.xDeck ? 'glass' : 'body';
    if (tpl.rear === 'hatch') return 'glass';
    if (tpl.rear === 'box') return 'roof';
    return x >= g.xCabBack - 0.02 ? 'glass' : 'body';
  };
  const sideZone = (x) => {
    for (const w of sideWins) if (x >= w[0] && x <= w[1]) return 'glass';
    if (x > firstStart && x < lastEnd) return 'bpillar';
    return 'body';
  };
  // panel seams
  const seams = [];
  if (car.body === 'van') seams.push(g.xF - 0.16, g.xF - 0.95);
  else if (pillars === 'jeep') seams.push(g.xF - g.Ra - 0.05, xB - 0.08);
  else if (threeDoor) seams.push(g.xF - g.Ra - 0.05, xB);
  else seams.push(g.xF - g.Ra - 0.05, xB, g.xR + g.Ra + (tpl.rear === 'notch' ? 0.05 : 0.04));
  // handles sit just ahead of each door's rear edge
  const handles = car.body === 'van' ? [g.xF - 0.83] : pillars === 'jeep' ? [xB + 0.04] : threeDoor ? [xB + 0.14] : [xB + 0.14, (g.xR + g.Ra + 0.05) + 0.12];
  const seatFront = Math.min(xB + 0.28, g.xCowl - 0.65);
  const cabinLen = (car.body === 'pickup' ? g.xCabBack : g.xRoofR) != null ? (g.xCowl - 0.3) - (car.body === 'pickup' ? g.xCabBack : g.xRoofR) : 1.5;
  const cabinMid = (g.xCowl - 0.3 + (car.body === 'pickup' ? g.xCabBack : g.xRoofR)) / 2;
  return { sideWins, topZone, sideZone, blackPillars, seams, handles, xB, seatFront, cabinLen, cabinMid };
}
