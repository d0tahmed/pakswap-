// Procedural wheels: tyre (lathe), rim face (extruded shape with spoke windows), barrel, brakes.
import * as THREE from 'three';
import { treadTexture } from './textures.js';
import { sharedMaterials } from './materials.js';

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

const geoCache = new Map();
function cachedGeo(key, fn) { if (!geoCache.has(key)) geoCache.set(key, fn()); return geoCache.get(key); }

function tyreGeometry(R, rimR, w, kind) {
  return cachedGeo(`tyre-${R.toFixed(3)}-${rimR.toFixed(3)}-${w.toFixed(3)}-${kind}`, () => {
    const pts = [];
    const sh = Math.min(0.035, (R - rimR) * 0.35);
    const hw = w / 2;
    const bulge = (R - rimR) * 0.08;
    const prof = [
      [rimR - 0.004, -hw * 0.82], [rimR + 0.01, -hw * 0.92], [rimR + (R - rimR) * 0.45, -hw - bulge], [R - sh, -hw + 0.004],
      [R - sh * 0.25, -hw + sh * 0.55], [R, -hw + sh * 1.4], [R, hw - sh * 1.4], [R - sh * 0.25, hw - sh * 0.55],
      [R - sh, hw - 0.004], [rimR + (R - rimR) * 0.45, hw + bulge], [rimR + 0.01, hw * 0.92], [rimR - 0.004, hw * 0.82],
    ];
    for (const [r, z] of prof) pts.push(new THREE.Vector2(r, z));
    const g = new THREE.LatheGeometry(pts, 72);
    g.rotateX(Math.PI / 2);
    return g;
  });
}

function barrelGeometry(rimR, w, lip) {
  return cachedGeo(`barrel-${rimR.toFixed(3)}-${w.toFixed(3)}-${lip}`, () => {
    const hw = w / 2;
    const pts = [
      new THREE.Vector2(rimR * 0.9, -hw * 0.85), new THREE.Vector2(rimR * 0.97, -hw * 0.9), new THREE.Vector2(rimR * 0.97, hw * 0.7),
      new THREE.Vector2(rimR + 0.006, hw * 0.8), new THREE.Vector2(rimR + 0.008, hw * 0.92), new THREE.Vector2(rimR - 0.004, hw * 0.96),
      new THREE.Vector2(rimR * (lip ? 0.84 : 0.93), hw * 0.95),
    ];
    const g = new THREE.LatheGeometry(pts, 64);
    g.rotateX(Math.PI / 2);
    return g;
  });
}

export function buildWheel(o) {
  const M = sharedMaterials();
  const group = new THREE.Group();
  const spin = new THREE.Group();
  group.add(spin);
  const R = o.R, rimR = (o.rim * 0.0254) / 2, w = o.width;
  // tyre
  const tread = treadTexture(o.tyres === 'at' ? 'at' : o.tyres === 'semislick' || o.tyres === 'drag' ? 'semislick' : 'road');
  const tread2 = tread.clone(); tread2.needsUpdate = true; tread2.repeat.set(1, 1);
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.9, metalness: 0, bumpMap: tread2, bumpScale: 2.2 });
  const tyre = new THREE.Mesh(tyreGeometry(R, rimR, w, o.tyres), tyreMat);
  spin.add(tyre);
  // rim
  const chrome = o.chrome || o.style === 'stock' && o.classic;
  const rimMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(o.rimColor || '#c9cdd2'), metalness: chrome ? 1 : 0.75, roughness: chrome ? 0.06 : 0.28, clearcoat: chrome ? 0 : 0.8, clearcoatRoughness: 0.08, side: THREE.DoubleSide });
  const lipMat = o.style === 'dish' ? M.chrome : rimMat;
  const barrel = new THREE.Mesh(barrelGeometry(rimR, w, o.style === 'dish'), lipMat);
  spin.add(barrel);
  const faceDepth = o.style === 'offroad' ? 0.03 : 0.022;
  const recess = { dish: w * 0.35, five: w * 0.12, multi: w * 0.08, y: w * 0.1, mesh: w * 0.1, turbine: w * 0.02, offroad: w * 0.1, stock: w * 0.05 }[o.style] ?? w * 0.1;
  const faceGeo = cachedGeo(`face-${o.style}-${rimR.toFixed(3)}`, () => {
    const g = new THREE.ExtrudeGeometry(faceShape(o.style, rimR * 0.97), { depth: faceDepth, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 2, curveSegments: 18 });
    g.translate(0, 0, -faceDepth);
    return g;
  });
  const face = new THREE.Mesh(faceGeo, rimMat);
  face.position.z = w / 2 - recess;
  spin.add(face);
  if (o.style === 'dish') {
    const lipRing = new THREE.Mesh(new THREE.RingGeometry(rimR * 0.82, rimR * 1.0, 48), M.chrome);
    lipRing.position.z = w / 2 - 0.004; spin.add(lipRing);
  }
  if (o.style === 'offroad') {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(rimR * 0.95, 0.012, 8, 48), new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.5, metalness: 0.6 }));
    ring.position.z = w / 2 - 0.006; spin.add(ring);
    const boltG = new THREE.CylinderGeometry(0.006, 0.006, 0.012, 6); boltG.rotateX(Math.PI / 2);
    const bolts = new THREE.InstancedMesh(boltG, M.chrome, 24);
    const mm = new THREE.Matrix4();
    for (let i = 0; i < 24; i++) { const a = (i / 24) * TAU; mm.makeTranslation(Math.cos(a) * rimR * 0.95, Math.sin(a) * rimR * 0.95, w / 2 + 0.004); bolts.setMatrixAt(i, mm); }
    spin.add(bolts);
  }
  // hub, cap and lugs
  const back = new THREE.Mesh(new THREE.CircleGeometry(rimR * 0.95, 40), M.darkMetal);
  back.position.z = -w * 0.25; spin.add(back);
  const capR = o.style === 'stock' ? rimR * 0.62 : rimR * 0.17;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(capR, capR * 1.04, 0.022, 32).rotateX(Math.PI / 2), o.style === 'stock' ? new THREE.MeshStandardMaterial({ color: 0xbfc4c9, roughness: 0.35, metalness: 0.6 }) : M.darkMetal);
  cap.position.z = w / 2 - recess + 0.012;
  spin.add(cap);
  if (o.style === 'stock') {
    const slotsMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.7 });
    for (let i = 0; i < 10; i++) {
      const sl = new THREE.Mesh(new THREE.BoxGeometry(capR * 0.38, 0.012, 0.006), slotsMat);
      const a = (i / 10) * TAU; sl.position.set(Math.cos(a) * capR * 0.68, Math.sin(a) * capR * 0.68, cap.position.z + 0.012); sl.rotation.z = a; spin.add(sl);
    }
  } else {
    const lugG = new THREE.CylinderGeometry(0.009, 0.009, 0.02, 6); lugG.rotateX(Math.PI / 2);
    const nL = o.lugs || 5;
    const lugs = new THREE.InstancedMesh(lugG, M.chrome, nL);
    const mm = new THREE.Matrix4();
    for (let i = 0; i < nL; i++) { const a = (i / nL) * TAU; mm.makeTranslation(Math.cos(a) * rimR * 0.27, Math.sin(a) * rimR * 0.27, w / 2 - recess + 0.006); lugs.setMatrixAt(i, mm); }
    spin.add(lugs);
  }
  // brake disc and caliper (not spinning)
  const discR = Math.min(rimR * (o.bbk ? 0.86 : 0.76), R * 0.7);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(discR, discR, 0.026, 40).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: o.ceramic ? 0x4a4644 : 0x8d9196, roughness: 0.42, metalness: 0.9 }));
  disc.position.z = w / 2 - recess - 0.05;
  group.add(disc);
  const calMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(o.caliper || '#3a3d42'), roughness: 0.32, metalness: 0.2, clearcoat: 1 });
  const cal = new THREE.Mesh(new THREE.BoxGeometry(o.bbk ? 0.17 : 0.12, 0.06, o.bbk ? 0.07 : 0.055), calMat);
  const ang = o.caliperAngle ?? 0.55;
  cal.position.set(Math.cos(ang) * discR * 0.82, Math.sin(ang) * discR * 0.82, disc.position.z + 0.012);
  cal.rotation.z = ang + Math.PI / 2;
  group.add(cal);
  group.userData = { spin, tyreMat, rimMat, calMat, R };
  return group;
}

export function disposeWheel(g) {
  g.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) {
      const gk = [...geoCache.values()].includes(o.geometry);
      if (!gk) o.geometry.dispose();
    }
  });
  const u = g.userData;
  if (u.tyreMat) { u.tyreMat.bumpMap?.dispose(); u.tyreMat.dispose(); }
  u.rimMat?.dispose(); u.calMat?.dispose();
}
