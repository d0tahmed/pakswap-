// Procedural wheels: tyre (profile swept round the axle, with sidewall lettering), rim face
// (extruded shape with spoke windows), barrel, hub, brake disc and caliper.
// Local axes: z is the axle, +z points away from the car.
import * as THREE from 'three';
import { tyreTexture, releaseTyreTexture } from './textures.js';
import { sharedMaterials } from './materials.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;

function windowPath(r1, r2, a0, a1, round = 0.18) {
  const p = new THREE.Path();
  const span = a1 - a0;
  const ins = Math.min(span * round, 0.2);
  p.absarc(0, 0, r2, a0 + ins * 0.5, a1 - ins * 0.5, false);
  const pIn1 = [Math.cos(a1 - ins) * r1, Math.sin(a1 - ins) * r1];
  p.lineTo(pIn1[0], pIn1[1]);
  p.absarc(0, 0, r1, a1 - ins, a0 + ins, true);
  p.closePath();
  return p;
}

function circlePath(cx, cy, r) {
  const p = new THREE.Path();
  p.absarc(cx, cy, r, 0, TAU, true);
  return p;
}

function faceShape(style, R) {
  const s = new THREE.Shape();
  s.absarc(0, 0, R, 0, TAU, false);
  const add = (p) => s.holes.push(p);
  const rIn = R * 0.36, rOut = R * 0.86;
  if (style === 'five' || style === 'dish') {
    const n = style === 'dish' ? 6 : 5;
    const spoke = style === 'dish' ? 0.32 : 0.38;
    for (let i = 0; i < n; i++) { const a0 = (i / n) * TAU + spoke / 2, a1 = ((i + 1) / n) * TAU - spoke / 2; add(windowPath(rIn, rOut, a0, a1, 0.22)); }
  } else if (style === 'multi') {
    const n = 10;
    for (let i = 0; i < n; i++) { const a0 = (i / n) * TAU + 0.12, a1 = ((i + 1) / n) * TAU - 0.12; add(windowPath(rIn * 1.05, rOut, a0, a1, 0.1)); }
  } else if (style === 'y') {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const base = (i / n) * TAU;
      add(windowPath(rIn, rOut * 0.62, base + 0.24, base + TAU / n - 0.24, 0.2));
      add(windowPath(rOut * 0.6, rOut, base + 0.13, base + TAU / (2 * n) - 0.06, 0.15));
      add(windowPath(rOut * 0.6, rOut, base + TAU / (2 * n) + 0.06, base + TAU / n - 0.13, 0.15));
    }
  } else if (style === 'mesh') {
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
      add(windowPath(rIn, R * 0.6, a0 + 0.08, a1 - 0.08, 0.3));
      add(windowPath(R * 0.63, rOut, a0 + 0.06 + (a1 - a0) / 2, a1 + (a1 - a0) / 2 - 0.06, 0.25));
    }
  } else if (style === 'turbine') {
    const n = 14;
    for (let i = 0; i < n; i++) { const a0 = (i / n) * TAU + 0.05, a1 = a0 + 0.17; add(windowPath(R * 0.55, rOut, a0, a1, 0.3)); }
  } else if (style === 'offroad') {
    const n = 6;
    for (let i = 0; i < n; i++) { const a0 = (i / n) * TAU + 0.35, a1 = ((i + 1) / n) * TAU - 0.35; add(windowPath(rIn * 1.15, R * 0.74, a0, a1, 0.3)); }
  } else { // stock steel
    const n = 8;
    for (let i = 0; i < n; i++) { const a = (i / n) * TAU; add(circlePath(Math.cos(a) * R * 0.72, Math.sin(a) * R * 0.72, R * 0.07)); }
  }
  return s;
}

// ---------------------------------------------------------------- shared geometry cache
// Wheel parts are identical on all four corners and across rebuilds, so they are built once,
// reference counted, and the least recently used spare entries are freed.
const geoCache = new Map();
const CACHE_SPARE = 14;
let stamp = 0;
function acquire(key, fn) {
  let e = geoCache.get(key);
  if (!e) {
    e = { geo: fn(), refs: 0, used: 0 };
    e.geo.userData.cacheKey = key;
    e.geo.userData.shared = true;
    geoCache.set(key, e);
  }
  e.refs++; e.used = ++stamp;
  return e.geo;
}
function release(geo) {
  const e = geoCache.get(geo.userData.cacheKey);
  if (!e || e.geo !== geo) { geo.dispose(); return; }
  e.refs = Math.max(0, e.refs - 1);
}
function trimCache() {
  let spare = 0;
  for (const e of geoCache.values()) if (e.refs === 0) spare++;
  if (spare <= CACHE_SPARE) return;
  const idle = [...geoCache.entries()].filter(([, e]) => e.refs === 0).sort((a, b) => a[1].used - b[1].used);
  for (const [k, e] of idle.slice(0, spare - CACHE_SPARE)) { e.geo.dispose(); geoCache.delete(k); }
}
export function wheelCacheStats() { let live = 0; for (const e of geoCache.values()) if (e.refs > 0) live++; return { entries: geoCache.size, live }; }

// Tyre cross-section swept around the axle. v runs inboard bead (0) -> inboard sidewall ->
// tread (0.3 to 0.7) -> outboard sidewall -> outboard bead (1), matching tyreTexture().
function tyreGeometry(R, rimR, w) {
  return acquire(`tyre-${R.toFixed(3)}-${rimR.toFixed(3)}-${w.toFixed(3)}`, () => {
    const hw = w / 2;
    const wall = R - rimR;
    const sh = Math.min(0.03, wall * 0.34, hw * 0.45); // shoulder radius
    const bulge = wall * 0.085;
    const crown = Math.min(0.004, w * 0.012);
    const prof = []; // [r, z, v]
    const half = [];
    half.push([rimR - 0.006, hw * 0.8, 1.0]);
    half.push([rimR + 0.008, hw * 0.9, 0.975]);
    half.push([rimR + wall * 0.2, hw + bulge * 0.7, 0.93]);
    half.push([rimR + wall * 0.48, hw + bulge, 0.86]);
    half.push([rimR + wall * 0.74, hw + bulge * 0.55, 0.78]);
    const NS = 5;
    for (let i = 0; i <= NS; i++) {
      const a = (i / NS) * (Math.PI / 2);
      half.push([R - sh + sh * Math.sin(a), hw - sh + sh * Math.cos(a), 0.74 - 0.045 * (i / NS)]);
    }
    half.push([R + crown * 0.6, hw * 0.5, 0.6]);
    // "half" runs outboard bead -> tread; the section is inboard bead -> tread -> outboard bead
    for (const [r, z, v] of half) prof.push([r, -z, 1 - v]);
    prof.push([R + crown, 0, 0.5]);
    for (let i = half.length - 1; i >= 0; i--) prof.push(half[i]);
    const SEG = 64, n = prof.length;
    const pos = new Float32Array((SEG + 1) * n * 3), nor = new Float32Array((SEG + 1) * n * 3), uv = new Float32Array((SEG + 1) * n * 2);
    // profile normals (in the r-z plane), pointing away from the tyre's air chamber
    const pn = [];
    const cr = rimR + wall * 0.5;
    for (let k = 0; k < n; k++) {
      const a = prof[Math.max(0, k - 1)], b = prof[Math.min(n - 1, k + 1)];
      let nr = b[1] - a[1], nz = -(b[0] - a[0]);
      const l = Math.hypot(nr, nz) || 1; nr /= l; nz /= l;
      if (nr * (prof[k][0] - cr) + nz * prof[k][1] < 0) { nr = -nr; nz = -nz; }
      pn.push([nr, nz]);
    }
    let o = 0, ou = 0;
    for (let s = 0; s <= SEG; s++) {
      const th = (s / SEG) * TAU, c = Math.cos(th), sn = Math.sin(th);
      for (let k = 0; k < n; k++) {
        const [r, z, v] = prof[k];
        pos[o] = r * c; pos[o + 1] = r * sn; pos[o + 2] = z;
        nor[o] = pn[k][0] * c; nor[o + 1] = pn[k][0] * sn; nor[o + 2] = pn[k][1];
        uv[ou] = s / SEG; uv[ou + 1] = v;
        o += 3; ou += 2;
      }
    }
    const idx = [];
    for (let s = 0; s < SEG; s++) for (let k = 0; k < n - 1; k++) {
      const a = s * n + k, b = a + n, c = b + 1, d = a + 1;
      idx.push(a, b, d, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    // make the triangles face the way the normals point
    const ia = idx[0], ib = idx[1], ic = idx[2];
    const ax = pos[ib * 3] - pos[ia * 3], ay = pos[ib * 3 + 1] - pos[ia * 3 + 1], az = pos[ib * 3 + 2] - pos[ia * 3 + 2];
    const bx = pos[ic * 3] - pos[ia * 3], by = pos[ic * 3 + 1] - pos[ia * 3 + 1], bz = pos[ic * 3 + 2] - pos[ia * 3 + 2];
    const fx = ay * bz - az * by, fy = az * bx - ax * bz, fz = ax * by - ay * bx;
    if (fx * nor[ia * 3] + fy * nor[ia * 3 + 1] + fz * nor[ia * 3 + 2] < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); }
    g.computeBoundingSphere();
    return g;
  });
}

function barrelGeometry(rimR, w, lip) {
  return acquire(`barrel-${rimR.toFixed(3)}-${w.toFixed(3)}-${lip}`, () => {
    const hw = w / 2;
    const pts = [
      new THREE.Vector2(rimR * 0.9, -hw * 0.85), new THREE.Vector2(rimR * 0.97, -hw * 0.9), new THREE.Vector2(rimR * 0.97, hw * 0.7),
      new THREE.Vector2(rimR + 0.006, hw * 0.8), new THREE.Vector2(rimR + 0.008, hw * 0.92), new THREE.Vector2(rimR - 0.004, hw * 0.96),
      new THREE.Vector2(rimR * (lip ? 0.84 : 0.93), hw * 0.95),
    ];
    const g = new THREE.LatheGeometry(pts, 56);
    g.rotateX(Math.PI / 2);
    return g;
  });
}

function faceGeometry(style, rimR, faceDepth) {
  return acquire(`face-${style}-${rimR.toFixed(3)}`, () => {
    const g = new THREE.ExtrudeGeometry(faceShape(style, rimR * 0.97), { depth: faceDepth, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 2, curveSegments: 16 });
    g.translate(0, 0, -faceDepth);
    return g;
  });
}

// hub cap slots of the factory steel wheel, baked into one mesh
function slotsGeometry(capR) {
  return acquire(`slots-${capR.toFixed(3)}`, () => {
    const parts = [];
    for (let i = 0; i < 10; i++) {
      const b = new THREE.BoxGeometry(capR * 0.38, 0.012, 0.006);
      const a = (i / 10) * TAU;
      b.rotateZ(a); b.translate(Math.cos(a) * capR * 0.68, Math.sin(a) * capR * 0.68, 0);
      parts.push(b);
    }
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    return g;
  });
}

function simple(key, fn) { return acquire(key, fn); }

export function buildWheel(o) {
  const M = sharedMaterials();
  const group = new THREE.Group();
  const spin = new THREE.Group();
  group.add(spin);
  const R = o.R, rimR = (o.rim * 0.0254) / 2, w = o.width;
  // tyre
  const kind = o.tyres === 'at' ? 'at' : o.tyres === 'semislick' ? 'semislick' : o.tyres === 'drag' ? 'drag' : 'road';
  const label = o.label || `${Math.round(w * 1000)}/${Math.max(20, Math.round(((R - rimR) / w) * 100 / 5) * 5)} R${Math.round(o.rim)}`;
  const tyreTex = tyreTexture(kind, label);
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.88, metalness: 0, bumpMap: tyreTex, bumpScale: kind === 'at' ? 3.2 : 2.2 });
  const tyre = new THREE.Mesh(tyreGeometry(R, rimR, w), tyreMat);
  spin.add(tyre);
  // rim
  const chrome = o.chrome || o.style === 'stock' && o.classic;
  const rimMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(o.rimColor || '#c9cdd2'), metalness: chrome ? 1 : 0.75, roughness: chrome ? 0.06 : 0.28, clearcoat: chrome ? 0 : 0.8, clearcoatRoughness: 0.08, side: THREE.DoubleSide });
  const lipMat = o.style === 'dish' ? M.chrome : rimMat;
  const barrel = new THREE.Mesh(barrelGeometry(rimR, w, o.style === 'dish'), lipMat);
  spin.add(barrel);
  const faceDepth = o.style === 'offroad' ? 0.03 : 0.022;
  const recess = { dish: w * 0.35, five: w * 0.12, multi: w * 0.08, y: w * 0.1, mesh: w * 0.1, turbine: w * 0.02, offroad: w * 0.1, stock: w * 0.05 }[o.style] ?? w * 0.1;
  const face = new THREE.Mesh(faceGeometry(o.style, rimR, faceDepth), rimMat);
  face.position.z = w / 2 - recess;
  spin.add(face);
  if (o.style === 'dish') {
    const lipRing = new THREE.Mesh(simple(`lipring-${rimR.toFixed(3)}`, () => new THREE.RingGeometry(rimR * 0.82, rimR * 1.0, 48)), M.chrome);
    lipRing.position.z = w / 2 - 0.004; spin.add(lipRing);
  }
  let extraMat = null;
  if (o.style === 'offroad') {
    extraMat = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.5, metalness: 0.6 });
    const ring = new THREE.Mesh(simple(`bead-${rimR.toFixed(3)}`, () => new THREE.TorusGeometry(rimR * 0.95, 0.012, 8, 48)), extraMat);
    ring.position.z = w / 2 - 0.006; spin.add(ring);
    const bolts = new THREE.Mesh(simple(`beadbolts-${rimR.toFixed(3)}`, () => {
      const parts = [];
      for (let i = 0; i < 24; i++) { const b = new THREE.CylinderGeometry(0.006, 0.006, 0.012, 6); b.rotateX(Math.PI / 2); const a = (i / 24) * TAU; b.translate(Math.cos(a) * rimR * 0.95, Math.sin(a) * rimR * 0.95, 0); parts.push(b); }
      const g = mergeGeometries(parts, false); for (const p of parts) p.dispose(); return g;
    }), M.chrome);
    bolts.position.z = w / 2 + 0.004;
    spin.add(bolts);
  }
  // hub, cap and lugs
  const back = new THREE.Mesh(simple(`back-${rimR.toFixed(3)}`, () => new THREE.CircleGeometry(rimR * 0.95, 40)), M.darkMetal);
  back.position.z = -w * 0.25; spin.add(back);
  const capR = o.style === 'stock' ? rimR * 0.62 : rimR * 0.17;
  let capMat = null;
  if (o.style === 'stock') capMat = new THREE.MeshStandardMaterial({ color: 0xbfc4c9, roughness: 0.35, metalness: 0.6 });
  const cap = new THREE.Mesh(simple(`cap-${capR.toFixed(3)}`, () => new THREE.CylinderGeometry(capR, capR * 1.04, 0.022, 32).rotateX(Math.PI / 2)), capMat || M.darkMetal);
  cap.position.z = w / 2 - recess + 0.012;
  spin.add(cap);
  let slotsMat = null;
  if (o.style === 'stock') {
    slotsMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.7 });
    const slots = new THREE.Mesh(slotsGeometry(capR), slotsMat);
    slots.position.z = cap.position.z + 0.012;
    spin.add(slots);
  } else {
    const nL = o.lugs || 5;
    const lugs = new THREE.Mesh(simple(`lugs-${nL}-${rimR.toFixed(3)}`, () => {
      const parts = [];
      for (let i = 0; i < nL; i++) { const b = new THREE.CylinderGeometry(0.009, 0.009, 0.02, 6); b.rotateX(Math.PI / 2); const a = (i / nL) * TAU; b.translate(Math.cos(a) * rimR * 0.27, Math.sin(a) * rimR * 0.27, 0); parts.push(b); }
      const g = mergeGeometries(parts, false); for (const p of parts) p.dispose(); return g;
    }), M.chrome);
    lugs.position.z = w / 2 - recess + 0.006;
    spin.add(lugs);
  }
  // brake disc and caliper (not spinning)
  const discR = Math.min(rimR * (o.bbk ? 0.86 : 0.76), R * 0.7);
  const discMat = new THREE.MeshStandardMaterial({ color: o.ceramic ? 0x4a4644 : 0x8d9196, roughness: 0.42, metalness: 0.9 });
  const disc = new THREE.Mesh(simple(`disc-${discR.toFixed(3)}`, () => new THREE.CylinderGeometry(discR, discR, 0.026, 40).rotateX(Math.PI / 2)), discMat);
  disc.position.z = w / 2 - recess - 0.05;
  group.add(disc);
  const calMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(o.caliper || '#3a3d42'), roughness: 0.32, metalness: 0.2, clearcoat: 1 });
  const cal = new THREE.Mesh(simple(o.bbk ? 'caliper-bbk' : 'caliper', () => new THREE.BoxGeometry(o.bbk ? 0.17 : 0.12, 0.06, o.bbk ? 0.07 : 0.055)), calMat);
  const ang = o.caliperAngle ?? 0.55;
  cal.position.set(Math.cos(ang) * discR * 0.82, Math.sin(ang) * discR * 0.82, disc.position.z + 0.012);
  cal.rotation.z = ang + Math.PI / 2;
  group.add(cal);
  group.userData = { spin, tyreMat, rimMat, calMat, R, tyreTex, owned: [tyreMat, rimMat, calMat, discMat, capMat, slotsMat, extraMat].filter(Boolean) };
  return group;
}

export function disposeWheel(g) {
  g.traverse((o) => { if (o.isMesh && o.geometry) release(o.geometry); });
  const u = g.userData;
  for (const m of u.owned || []) m.dispose();
  if (u.tyreTex) releaseTyreTexture(u.tyreTex);
  g.userData = {};
  trimCache();
}
