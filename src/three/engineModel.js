// Procedural engine models sized to each engine's real dimensions.
// Local axes: x = crankshaft axis (accessory drive at +x), y = up, z = width (intake at +z).
import * as THREE from 'three';

const COVER = {
  'hon-b16b': '#b5121b', 'hon-b18c': '#b5121b', 'hon-k20a': '#b5121b', 'hon-k20c1': '#b5121b', 'hon-f20c': '#b5121b',
  'nis-rb26': '#a3161a', 'nis-sr20': '#a3161a', 'mit-4g63': '#a3161a', 'sub-ej257': '#a3161a',
  'toy-4age': '#9aa0a6', 'toy-2jz': '#2a2c30', 'toy-1jz': '#2a2c30', 'toy-3sgte': '#2a2c30', 'chv-ls3': '#141516', 'dod-hellcat': '#141516',
  'cum-6bt': '#d8cdb2', 'maz-13b': '#1d1e20', 'suz-busa': '#2b2d31', 'toy-2zzge': '#3c4046',
};
const BLOCK = { 'dod-hellcat': '#c4561a', 'cum-6bt': '#d8cdb2', 'chv-ls3': '#c9c9c9' };

function mats(engine) {
  const cover = COVER[engine.id] || (engine.fuel === 'diesel' ? '#1c1d20' : '#a9aeb4');
  return {
    block: new THREE.MeshStandardMaterial({ color: BLOCK[engine.id] || '#8f9399', roughness: 0.55, metalness: 0.7 }),
    cover: new THREE.MeshPhysicalMaterial({ color: cover, roughness: cover === '#a9aeb4' ? 0.3 : 0.45, metalness: cover === '#a9aeb4' ? 0.85 : 0.3, clearcoat: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: '#1b1c1f', roughness: 0.7, metalness: 0.3 }),
    pipe: new THREE.MeshStandardMaterial({ color: '#b9b2a6', roughness: 0.35, metalness: 0.9 }),
    hot: new THREE.MeshStandardMaterial({ color: '#7b5a45', roughness: 0.5, metalness: 0.85 }),
    alu: new THREE.MeshStandardMaterial({ color: '#c6cacf', roughness: 0.25, metalness: 0.95 }),
    blue: new THREE.MeshStandardMaterial({ color: '#2f6fb3', roughness: 0.4, metalness: 0.3 }),
    orange: new THREE.MeshStandardMaterial({ color: '#ff6a00', roughness: 0.5 }),
    rubber: new THREE.MeshStandardMaterial({ color: '#111', roughness: 0.9 }),
  };
}

function box(w, h, d, m, x = 0, y = 0, z = 0, r = 0) {
  const g = r > 0 ? roundedBox(w, h, d, r) : new THREE.BoxGeometry(w, h, d);
  const me = new THREE.Mesh(g, m); me.position.set(x, y, z); return me;
}

function roundedBox(w, h, d, r) {
  const s = new THREE.Shape();
  const hw = w / 2 - r, hh = h / 2 - r;
  s.moveTo(-hw, -h / 2); s.lineTo(hw, -h / 2); s.absarc(hw, -hh, r, -Math.PI / 2, 0); s.lineTo(w / 2, hh); s.absarc(hw, hh, r, 0, Math.PI / 2);
  s.lineTo(-hw, h / 2); s.absarc(-hw, hh, r, Math.PI / 2, Math.PI); s.lineTo(-w / 2, -hh); s.absarc(-hw, -hh, r, Math.PI, Math.PI * 1.5);
  const g = new THREE.ExtrudeGeometry(s, { depth: d - r * 2, bevelEnabled: true, bevelSize: r * 0.9, bevelThickness: r, bevelSegments: 3, curveSegments: 6 });
  g.translate(0, 0, -(d - r * 2) / 2);
  return g;
}

function cyl(r, len, m, axis = 'y', x = 0, y = 0, z = 0, seg = 18) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  const me = new THREE.Mesh(g, m); me.position.set(x, y, z); return me;
}

function tube(points, r, m) {
  const c = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.Mesh(new THREE.TubeGeometry(c, 24, r, 8, false), m);
}

function turbo(M, x, y, z, s = 1) {
  const g = new THREE.Group();
  const snail = new THREE.Mesh(new THREE.TorusGeometry(0.06 * s, 0.035 * s, 12, 24), M.hot);
  snail.rotation.y = Math.PI / 2;
  const comp = new THREE.Mesh(new THREE.TorusGeometry(0.055 * s, 0.03 * s, 12, 24), M.alu);
  comp.rotation.y = Math.PI / 2; comp.position.x = 0.09 * s;
  const core = cyl(0.03 * s, 0.1 * s, M.dark, 'x', 0.045 * s, 0, 0);
  const inlet = cyl(0.04 * s, 0.07 * s, M.alu, 'x', 0.16 * s, 0, 0);
  g.add(snail, comp, core, inlet);
  g.position.set(x, y, z);
  return g;
}

export function buildEngineModel(engine, cfg = {}) {
  const M = mats(engine);
  const g = new THREE.Group();
  const [L, W, H] = engine.dim.map((v) => v / 1000);
  const turboOn = engine.asp === 'T' || engine.asp === 'TT' || engine.turbo || cfg.fi === 'turbo' || cfg.fi === 'bigturbo';
  const twin = engine.asp === 'TT';
  const scOn = engine.asp === 'SC' || cfg.fi === 'sc';
  const n = Math.max(1, engine.cyl);
  const lay = engine.layout;
  const bottom = -H / 2;

  if (lay === 'EV') {
    const motor = cyl(Math.min(W, H) * 0.42, L * 0.7, M.alu, 'x', 0, 0, 0, 28);
    const cap1 = cyl(Math.min(W, H) * 0.3, 0.04, M.dark, 'x', L * 0.37, 0, 0);
    const inv = box(L * 0.55, H * 0.28, W * 0.7, M.dark, -L * 0.05, H * 0.36, 0, 0.02);
    const red = box(L * 0.3, H * 0.6, W * 0.45, M.alu, -L * 0.35, -H * 0.05, 0, 0.03);
    g.add(motor, cap1, inv, red);
    for (let i = 0; i < 3; i++) g.add(tube([[-L * 0.1 + i * 0.05, H * 0.5, W * 0.2], [-L * 0.1 + i * 0.05, H * 0.62, W * 0.45], [-L * 0.25 + i * 0.05, H * 0.2, W * 0.55]], 0.014, M.orange));
    g.userData.kind = 'ev';
    return g;
  }

  if (lay === 'R2') {
    const slabs = 5;
    for (let i = 0; i < slabs; i++) {
      const isRotor = i % 2 === 1;
      g.add(box(L * (isRotor ? 0.2 : 0.12), H * 0.62, W * 0.62, isRotor ? M.block : M.alu, -L * 0.36 + i * L * 0.18, bottom + H * 0.42, 0, 0.04));
    }
    g.add(box(L * 0.75, H * 0.16, W * 0.5, M.cover, 0, bottom + H * 0.86, W * 0.05, 0.03));
    for (let i = 0; i < 4; i++) g.add(cyl(0.022, H * 0.2, M.alu, 'y', -L * 0.25 + i * L * 0.16, bottom + H * 0.72, W * 0.22));
    g.add(turbo(M, -L * 0.1, bottom + H * 0.5, -W * 0.42, 0.9));
    if (twin) g.add(turbo(M, L * 0.18, bottom + H * 0.42, -W * 0.42, 0.75));
    g.add(cyl(0.07, 0.03, M.dark, 'x', L * 0.5, bottom + H * 0.4, 0));
    return g;
  }

  if (engine.orient === 'BIKE') {
    const cylBlock = box(L * 0.75, H * 0.38, W * 0.45, M.block, 0, bottom + H * 0.62, 0, 0.02);
    cylBlock.rotation.z = 0.0;
    const head = box(L * 0.78, H * 0.16, W * 0.42, M.cover, 0, bottom + H * 0.88, 0.02, 0.02);
    const crank = box(L * 0.95, H * 0.36, W * 0.62, M.dark, 0, bottom + H * 0.25, -W * 0.05, 0.04);
    const gear = box(L * 0.6, H * 0.3, W * 0.42, M.alu, -L * 0.05, bottom + H * 0.22, -W * 0.48, 0.04);
    const spr = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 8, 24), M.dark);
    spr.position.set(0, bottom + H * 0.22, -W * 0.75);
    g.add(cylBlock, head, crank, gear, spr);
    for (let i = 0; i < 4; i++) g.add(tube([[-L * 0.3 + i * L * 0.2, bottom + H * 0.7, W * 0.25], [-L * 0.3 + i * L * 0.2, bottom + H * 0.5, W * 0.45], [0, bottom + H * 0.1, W * 0.4]], 0.016, M.pipe));
    return g;
  }

  if (lay === 'B4') {
    g.add(box(L * 0.7, H * 0.5, W * 0.4, M.block, 0, bottom + H * 0.4, 0, 0.03));
    for (const s of [-1, 1]) {
      g.add(box(L * 0.8, H * 0.42, W * 0.22, M.block, 0, bottom + H * 0.42, s * W * 0.32, 0.03));
      g.add(box(L * 0.82, H * 0.36, W * 0.08, M.cover, 0, bottom + H * 0.42, s * W * 0.46, 0.02));
    }
    g.add(box(L * 0.6, H * 0.18, W * 0.45, M.cover, -L * 0.05, bottom + H * 0.85, 0, 0.03));
    g.add(box(L * 0.35, H * 0.22, W * 0.5, M.alu, L * 0.05, bottom + H * 0.95, 0, 0.04));
    g.add(turbo(M, L * 0.1, bottom + H * 0.18, -W * 0.15, 1.1));
    g.add(cyl(0.08, 0.03, M.dark, 'x', L * 0.48, bottom + H * 0.45, 0));
    return g;
  }

  if (lay === 'V6' || lay === 'V8') {
    const perBank = n / 2;
    g.add(box(L * 0.88, H * 0.4, W * 0.5, M.block, 0, bottom + H * 0.27, 0, 0.03));
    g.add(box(L * 0.8, H * 0.12, W * 0.42, M.dark, 0, bottom + H * 0.06, 0, 0.02));
    for (const s of [-1, 1]) {
      const bank = new THREE.Group();
      bank.add(box(L * 0.86, H * 0.32, W * 0.28, M.block, 0, 0, 0, 0.02));
      bank.add(box(L * 0.84, H * 0.1, W * 0.26, M.cover, 0, H * 0.2, 0, 0.02));
      for (let i = 0; i < perBank; i++) bank.add(cyl(0.018, 0.06, M.dark, 'y', -L * 0.32 + (i * L * 0.64) / Math.max(1, perBank - 1), H * 0.27, 0));
      bank.position.set(0, bottom + H * 0.58, s * W * 0.22);
      bank.rotation.x = s * 0.62;
      g.add(bank);
      for (let i = 0; i < perBank; i++) {
        const x = -L * 0.32 + (i * L * 0.64) / Math.max(1, perBank - 1);
        g.add(tube([[x, bottom + H * 0.5, s * W * 0.42], [x, bottom + H * 0.32, s * W * 0.5], [L * 0.0, bottom + H * 0.12, s * W * 0.48]], 0.017, M.pipe));
      }
      if (turboOn) g.add(turbo(M, -L * 0.15, bottom + H * 0.25, s * W * 0.55, 0.9));
    }
    if (scOn) {
      g.add(box(L * 0.7, H * 0.26, W * 0.42, M.cover, -L * 0.04, bottom + H * 0.92, 0, 0.05));
      g.add(cyl(0.06, 0.04, M.alu, 'x', L * 0.36, bottom + H * 0.94, 0));
    } else {
      g.add(box(L * 0.7, H * 0.18, W * 0.36, lay === 'V8' ? M.dark : M.cover, 0, bottom + H * 0.86, 0, 0.04));
      for (let i = 0; i < n; i++) g.add(cyl(0.02, H * 0.12, M.dark, 'y', -L * 0.3 + (Math.floor(i / 2) * L * 0.6) / Math.max(1, n / 2 - 1), bottom + H * 0.74, (i % 2 ? 1 : -1) * W * 0.1));
    }
    g.add(cyl(0.09, 0.03, M.dark, 'x', L * 0.47, bottom + H * 0.42, 0));
    g.add(cyl(0.05, 0.03, M.dark, 'x', L * 0.47, bottom + H * 0.7, W * 0.25));
    g.add(cyl(0.06, 0.12, M.alu, 'x', L * 0.4, bottom + H * 0.62, -W * 0.33));
    return g;
  }

  // inline engines (I3 / I4 / I6, petrol and diesel)
  const diesel = engine.fuel === 'diesel';
  g.add(box(L * 0.82, H * 0.12, W * 0.42, M.dark, 0, bottom + H * 0.06, 0, 0.02));
  g.add(box(L * 0.92, H * 0.42, W * 0.5, M.block, 0, bottom + H * 0.33, 0, 0.03));
  g.add(box(L * 0.94, H * 0.14, W * 0.48, M.block, 0, bottom + H * 0.61, 0, 0.02));
  g.add(box(L * 0.88, H * 0.12, W * 0.38, M.cover, 0, bottom + H * 0.74, -W * 0.02, 0.03));
  // cam cover ribs and coils
  for (let i = 0; i < n; i++) {
    const x = -L * 0.36 + (i * L * 0.72) / Math.max(1, n - 1);
    g.add(cyl(diesel ? 0.012 : 0.02, H * 0.08, diesel ? M.alu : M.dark, 'y', x, bottom + H * 0.83, -W * 0.02));
  }
  // intake: plenum and runners on +z
  const plenumY = bottom + H * 0.58;
  g.add(cyl(H * 0.075, L * 0.75, M.alu, 'x', 0, plenumY, W * 0.42));
  for (let i = 0; i < n; i++) {
    const x = -L * 0.36 + (i * L * 0.72) / Math.max(1, n - 1);
    g.add(tube([[x, bottom + H * 0.62, W * 0.2], [x, bottom + H * 0.7, W * 0.33], [x, plenumY, W * 0.42]], H * 0.03, M.alu));
  }
  if (cfg.intake === 'itb' && !turboOn) for (let i = 0; i < n; i++) g.add(cyl(0.03, 0.07, M.alu, 'z', -L * 0.36 + (i * L * 0.72) / Math.max(1, n - 1), bottom + H * 0.66, W * 0.52));
  // exhaust on -z
  for (let i = 0; i < n; i++) {
    const x = -L * 0.36 + (i * L * 0.72) / Math.max(1, n - 1);
    g.add(tube([[x, bottom + H * 0.6, -W * 0.24], [x, bottom + H * 0.5, -W * 0.38], [turboOn ? -L * 0.05 : 0, bottom + H * 0.3, -W * 0.42]], H * 0.028, M.hot));
  }
  if (turboOn) {
    g.add(turbo(M, -L * 0.05, bottom + H * 0.32, -W * 0.5, cfg.fi === 'bigturbo' ? 1.35 : diesel ? 1.15 : 1));
    if (twin) g.add(turbo(M, L * 0.25, bottom + H * 0.32, -W * 0.5, 0.85));
    g.add(tube([[L * 0.12, bottom + H * 0.32, -W * 0.5], [L * 0.45, bottom + H * 0.2, -W * 0.3], [L * 0.5, bottom + H * 0.3, W * 0.3], [L * 0.3, plenumY, W * 0.45]], 0.028, M.alu));
  }
  if (scOn) g.add(box(L * 0.42, H * 0.2, W * 0.3, M.cover, L * 0.05, bottom + H * 0.62, W * 0.42, 0.04));
  if (diesel) {
    g.add(box(L * 0.22, H * 0.25, W * 0.18, M.dark, L * 0.25, bottom + H * 0.45, W * 0.28, 0.02));
    for (let i = 0; i < n; i++) g.add(tube([[L * 0.25, bottom + H * 0.6, W * 0.28], [-L * 0.36 + (i * L * 0.72) / Math.max(1, n - 1), bottom + H * 0.88, 0.0]], 0.006, M.alu));
  }
  // front accessory drive
  g.add(box(0.03, H * 0.6, W * 0.42, M.dark, L * 0.47, bottom + H * 0.42, 0, 0.01));
  g.add(cyl(0.075, 0.03, M.dark, 'x', L * 0.5, bottom + H * 0.22, 0));
  g.add(cyl(0.05, 0.03, M.alu, 'x', L * 0.5, bottom + H * 0.62, W * 0.12));
  g.add(cyl(0.055, 0.11, M.alu, 'x', L * 0.42, bottom + H * 0.5, W * 0.33));
  return g;
}

export function buildBattery(len, wid, kwh) {
  const M = mats({ id: 'x', fuel: 'electric' });
  const g = new THREE.Group();
  const h = 0.06 + Math.min(0.08, kwh / 1200);
  const pack = box(len, h, wid, M.blue, 0, 0, 0, 0.015);
  g.add(pack);
  const cells = Math.max(4, Math.round(kwh / 8));
  for (let i = 0; i < cells; i++) g.add(box(len / cells - 0.01, 0.006, wid * 0.86, M.alu, -len / 2 + (i + 0.5) * (len / cells), h / 2 + 0.003, 0));
  g.add(tube([[len / 2, 0, wid * 0.3], [len / 2 + 0.25, 0.1, wid * 0.32], [len / 2 + 0.5, 0.2, wid * 0.2]], 0.012, M.orange));
  return g;
}
