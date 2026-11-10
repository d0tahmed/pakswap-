// Drive world layout, shared by the renderer, the physics and the tests (no three.js here).
// "PakSwap Drift Park": a 2.6 km circuit, a big drift pad with skidpad rings and gymkhana cones,
// a paddock with garages, an access road, grass, gravel traps, tyre walls and a perimeter wall.
// Units are metres, x points east, y points north. Surfaces live in a 0.5 m raster for O(1) lookups.

export const SURFACES = [
  { id: 0, kind: 'grass', mu: 0.62, roll: 7, rough: 0.35, dust: '#7a6a48' },
  { id: 1, kind: 'asphalt', mu: 1, roll: 1, rough: 0 },
  { id: 2, kind: 'kerb', mu: 0.9, roll: 1.4, rough: 1 },
  { id: 3, kind: 'gravel', mu: 0.5, roll: 30, rough: 0.8, dust: '#b7a27c' },
  { id: 4, kind: 'concrete', mu: 0.97, roll: 1, rough: 0.04 },
  { id: 5, kind: 'dirt', mu: 0.68, roll: 4, rough: 0.5, dust: '#9c7b55' },
];
export const S_GRASS = 0, S_ASPHALT = 1, S_KERB = 2, S_GRAVEL = 3, S_CONCRETE = 4, S_DIRT = 5;

export const BOUNDS = { x0: -470, x1: 470, y0: -340, y1: 340 };
const CELL = 0.5;

// Circuit control points, counter-clockwise. Main straight along the south side, heading east.
const CIRCUIT = [
  [-230, -240], [-60, -240], [110, -240], [250, -240],
  [318, -222], [345, -170], [328, -118], [292, -88], [290, -45], [330, -8], [385, 30],
  [400, 95], [372, 160], [315, 196], [240, 200],
  [190, 172], [150, 130], [100, 120], [62, 160], [40, 222], [-20, 250],
  [-140, 252], [-240, 238], [-318, 200], [-356, 140], [-350, 75],
  [-322, 25], [-340, -35], [-392, -72], [-405, -140], [-380, -200], [-320, -235],
];
export const TRACK_HALF = 6.5;
const KERB_W = 1.3;

// Gates in the perimeter wall (open world access) and the spectator car park.
export const GATES = [{ side: 'S', at: 0, w: 22 }, { side: 'N', at: -60, w: 22 }, { side: 'W', at: 60, w: 22 }];
export const LOT = { x0: -150, y0: -322, x1: 150, y1: -284 };
// Drift pad and paddock (axis-aligned rectangles: x0, y0, x1, y1).
export const PAD = { x0: -175, y0: -150, x1: 35, y1: 40 };
export const PADDOCK = { x0: -230, y0: -214, x1: 110, y1: -176 };
// access road from the paddock to the drift pad
const ROAD = [[-40, -182], [-40, -165], [-40, -147]];
const ROAD_HALF = 5;

// ---------------------------------------------------------------- small helpers
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Centripetal Catmull-Rom through the points, resampled every `step` metres.
export function ribbon(points, closed, step = 2) {
  const P = points;
  const n = P.length;
  const get = (i) => (closed ? P[(i + n) % n] : P[Math.max(0, Math.min(n - 1, i))]);
  const dense = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const d = (a, b) => Math.max(1e-4, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5));
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    const N = 40;
    for (let k = 0; k < N; k++) {
      const t = t1 + ((t2 - t1) * k) / N;
      const lerp = (a, b, ta, tb) => [(a[0] * (tb - t) + b[0] * (t - ta)) / (tb - ta), (a[1] * (tb - t) + b[1] * (t - ta)) / (tb - ta)];
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      dense.push(lerp(B1, B2, t1, t2));
    }
  }
  if (!closed) dense.push(P[n - 1]);
  // arc-length resample
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  let total = cum[cum.length - 1];
  if (closed) total += Math.hypot(dense[0][0] - dense[dense.length - 1][0], dense[0][1] - dense[dense.length - 1][1]);
  const count = Math.max(2, Math.round(total / step));
  const ds = total / count;
  const pts = [];
  let j = 0;
  const m = dense.length;
  for (let k = 0; k < (closed ? count : count + 1); k++) {
    const s = Math.min(total, k * ds);
    while (j < m - 1 && cum[j + 1] < s) j++;
    let a = dense[j], b, la;
    if (j < m - 1) { b = dense[j + 1]; la = cum[j + 1] - cum[j]; } else { b = dense[0]; la = total - cum[m - 1]; }
    const f = la > 1e-9 ? (s - cum[j]) / la : 0;
    pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  const N2 = pts.length;
  const x = new Float32Array(N2), y = new Float32Array(N2), tx = new Float32Array(N2), ty = new Float32Array(N2), sArr = new Float32Array(N2), curv = new Float32Array(N2);
  for (let i = 0; i < N2; i++) {
    x[i] = pts[i][0]; y[i] = pts[i][1]; sArr[i] = i * ds;
    const a = closed ? pts[(i - 1 + N2) % N2] : pts[Math.max(0, i - 1)];
    const b = closed ? pts[(i + 1) % N2] : pts[Math.min(N2 - 1, i + 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    tx[i] = (b[0] - a[0]) / L; ty[i] = (b[1] - a[1]) / L;
  }
  for (let i = 0; i < N2; i++) {
    const ia = closed ? (i - 2 + N2) % N2 : Math.max(0, i - 2), ib = closed ? (i + 2) % N2 : Math.min(N2 - 1, i + 2);
    const a0 = Math.atan2(ty[ia], tx[ia]), a1 = Math.atan2(ty[ib], tx[ib]);
    let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    curv[i] = d / (ds * (closed ? 4 : Math.max(1, ib - ia)));
  }
  return { x, y, tx, ty, s: sArr, curv, n: N2, ds, length: total, closed };
}

// ---------------------------------------------------------------- the layout
export function buildLayout() {
  const R = rng(20240917);
  const circuit = ribbon(CIRCUIT, true, 2);
  circuit.half = TRACK_HALF;
  // smoothed curvature decides kerbs, gravel and barriers
  const n = circuit.n;
  const ks = new Float32Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (let k = -4; k <= 4; k++) a += circuit.curv[(i + k + n) % n]; ks[i] = a / 9; }
  circuit.ks = ks;
  // kerbs: inside of every corner tighter than 120 m, outside of corners tighter than 70 m
  const kerbL = new Uint8Array(n), kerbR = new Uint8Array(n), trap = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const k = ks[i];
    if (Math.abs(k) > 1 / 120) { if (k > 0) kerbL[i] = 1; else kerbR[i] = 1; }
    if (Math.abs(k) > 1 / 70) { if (k > 0) kerbR[i] = 1; else kerbL[i] = 1; }
  }
  // grow kerbs a little and drop isolated bits
  const grow = (arr, by) => { const o = arr.slice(); for (let i = 0; i < n; i++) if (arr[i]) for (let k = -by; k <= by; k++) o[(i + k + n) % n] = 1; return o; };
  circuit.kerbL = grow(kerbL, 5); circuit.kerbR = grow(kerbR, 5);
  // gravel traps on the outside of slow corners, extending past the exit
  for (let i = 0; i < n; i++) {
    const k = ks[i];
    if (Math.abs(k) > 1 / 80) { const side = k > 0 ? -1 : 1; for (let j = -6; j <= 22; j++) trap[(i + j + n) % n] = side; }
  }
  circuit.trap = trap;
  // keep the main straight and the start area clean
  const sStart = 70; // start line sits 70 m along the spline (on the main straight)
  circuit.sStart = sStart;
  const road = ribbon(ROAD, false, 1);
  road.half = ROAD_HALF;

  // ---------------------------------------------------------------- surfaces raster
  const W = Math.round((BOUNDS.x1 - BOUNDS.x0) / CELL), H = Math.round((BOUNDS.y1 - BOUNDS.y0) / CELL);
  const grid = new Uint8Array(W * H); // 0 = grass
  const toCell = (x, y) => [Math.floor((x - BOUNDS.x0) / CELL), Math.floor((y - BOUNDS.y0) / CELL)];
  const fillQuad = (q, id, onlyOver) => {
    // q: four [x, y] corners of a convex quad
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of q) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const [cx0, cy0] = toCell(x0, y0), [cx1, cy1] = toCell(x1, y1);
    let sign = 0;
    for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; const c = (b[0] - a[0]) * (q[(k + 2) % 4][1] - a[1]) - (b[1] - a[1]) * (q[(k + 2) % 4][0] - a[0]); if (c !== 0) { sign = Math.sign(c); break; } }
    for (let cy = Math.max(0, cy0); cy <= Math.min(H - 1, cy1); cy++) {
      const py = BOUNDS.y0 + (cy + 0.5) * CELL;
      for (let cx = Math.max(0, cx0); cx <= Math.min(W - 1, cx1); cx++) {
        const px = BOUNDS.x0 + (cx + 0.5) * CELL;
        let inside = true;
        for (let k = 0; k < 4; k++) {
          const a = q[k], b = q[(k + 1) % 4];
          const c = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
          if (c * sign < -1e-9) { inside = false; break; }
        }
        if (!inside) continue;
        const o = cy * W + cx;
        if (onlyOver != null && !onlyOver.includes(grid[o])) continue;
        grid[o] = id;
      }
    }
  };
  const fillRect = (r, id) => {
    const [cx0, cy0] = toCell(r.x0, r.y0), [cx1, cy1] = toCell(r.x1 - 1e-6, r.y1 - 1e-6);
    for (let cy = Math.max(0, cy0); cy <= Math.min(H - 1, cy1); cy++) grid.fill(id, cy * W + Math.max(0, cx0), cy * W + Math.min(W - 1, cx1) + 1);
  };
  // band along a ribbon between lateral offsets o0..o1 (positive = left of travel)
  const fillBand = (rb, o0, o1, id, mask, onlyOver) => {
    const N = rb.n, last = rb.closed ? N : N - 1;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % N;
      if (mask && !(mask(i) && mask(j))) continue;
      const nxi = -rb.ty[i], nyi = rb.tx[i], nxj = -rb.ty[j], nyj = rb.tx[j];
      fillQuad([
        [rb.x[i] + nxi * o0, rb.y[i] + nyi * o0], [rb.x[j] + nxj * o0, rb.y[j] + nyj * o0],
        [rb.x[j] + nxj * o1, rb.y[j] + nyj * o1], [rb.x[i] + nxi * o1, rb.y[i] + nyi * o1],
      ], id, onlyOver);
    }
  };
  const hw = TRACK_HALF;
  // gravel traps (outside of corners), then kerbs, then tarmac on top
  fillBand(circuit, hw + KERB_W, hw + 17, S_GRAVEL, (i) => circuit.trap[i] === 1);
  fillBand(circuit, -hw - 17, -hw - KERB_W, S_GRAVEL, (i) => circuit.trap[i] === -1);
  fillRect(PADDOCK, S_CONCRETE);
  fillRect(PAD, S_ASPHALT);
  fillBand(road, -ROAD_HALF, ROAD_HALF, S_ASPHALT);
  // paddock exits onto the circuit (two short concrete ramps through the pit wall gaps)
  for (const [x0, x1] of [[-222, -196], [86, 112]]) fillRect({ x0, y0: -235, x1, y1: -213 }, S_CONCRETE);
  // spectator car park behind the grandstand and the lane to the south gate
  fillRect(LOT, S_ASPHALT);
  fillRect({ x0: -7, y0: BOUNDS.y0, x1: 7, y1: LOT.y0 + 1 }, S_ASPHALT);
  fillBand(circuit, hw, hw + KERB_W, S_KERB, (i) => circuit.kerbL[i] === 1);
  fillBand(circuit, -hw - KERB_W, -hw, S_KERB, (i) => circuit.kerbR[i] === 1);
  fillBand(circuit, -hw, hw, S_ASPHALT);
  // a ring of dirt service track just inside the perimeter wall
  const dirtPts = [];
  for (let k = 0; k < 64; k++) {
    const a = (k / 64) * Math.PI * 2;
    const rx = (BOUNDS.x1 - BOUNDS.x0) / 2 - 22, ry = (BOUNDS.y1 - BOUNDS.y0) / 2 - 22;
    const c = Math.cos(a), s = Math.sin(a);
    const e = 6; // superellipse
    dirtPts.push([Math.sign(c) * Math.pow(Math.abs(c), 2 / e) * rx, Math.sign(s) * Math.pow(Math.abs(s), 2 / e) * ry]);
  }
  const dirt = ribbon(dirtPts, true, 3); dirt.half = 4;
  fillBand(dirt, -4, 4, S_DIRT, null, [S_GRASS]);

  const surfaceAt = (x, y) => {
    const cx = Math.floor((x - BOUNDS.x0) / CELL), cy = Math.floor((y - BOUNDS.y0) / CELL);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return SURFACES[S_GRASS];
    return SURFACES[grid[cy * W + cx]];
  };

  // ---------------------------------------------------------------- colliders
  const walls = []; // {ax, ay, bx, by, t, nx, ny (open side, 0 = two-sided), kind, h}
  const posts = []; // {x, y, r, kind}
  const addWall = (ax, ay, bx, by, kind, t = 0.35, oneSided = null, h = 1.1) => {
    let nx = 0, ny = 0;
    if (oneSided) { nx = oneSided[0]; ny = oneSided[1]; }
    walls.push({ ax, ay, bx, by, t, nx, ny, kind, h });
  };
  const addPolyWall = (pts, kind, openSide, t, h, closed) => {
    // openSide: +1 = open to the left of the polyline direction, -1 = right, 0 = two sided
    const m = pts.length, last = closed ? m : m - 1;
    for (let i = 0; i < last; i++) {
      const a = pts[i], b = pts[(i + 1) % m];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 0.05) continue;
      const os = openSide ? [(-dy / L) * openSide, (dx / L) * openSide] : null;
      addWall(a[0], a[1], b[0], b[1], kind, t, os, h);
    }
  };
  // perimeter wall (open to the inside), broken by the gates
  const B = BOUNDS, m = 6;
  const corners = [[B.x0 + m, B.y0 + m], [B.x1 - m, B.y0 + m], [B.x1 - m, B.y1 - m], [B.x0 + m, B.y1 - m]];
  const sideOf = { S: 0, E: 1, N: 2, W: 3 };
  const perimeterRuns = [];
  for (let k = 0; k < 4; k++) {
    const a = corners[k], b = corners[(k + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    // gaps along this side, as distances from corner a
    const gaps = GATES.filter((g) => sideOf[g.side] === k).map((g) => {
      const c = k === 0 || k === 2 ? g.at : g.at; // gate position along x (S, N) or y (E, W)
      const along = k === 0 ? c - a[0] : k === 2 ? a[0] - c : k === 1 ? c - a[1] : a[1] - c;
      return [along - g.w / 2, along + g.w / 2];
    }).sort((p, q) => p[0] - q[0]);
    let s0 = 0;
    for (const [g0, g1] of [...gaps, [len, len]]) {
      if (g0 - s0 > 1) {
        const run = [];
        for (let d = s0; d < g0; d += 20) run.push([a[0] + ux * d, a[1] + uy * d]);
        run.push([a[0] + ux * g0, a[1] + uy * g0]);
        addPolyWall(run, 'concrete', 1, 0.4, 1.4, false);
        perimeterRuns.push(run);
      }
      s0 = g1;
    }
  }
  // tyre walls behind the gravel traps
  const trapRuns = [];
  for (let i = 0; i < n; i++) {
    const side = circuit.trap[i];
    const prev = circuit.trap[(i - 1 + n) % n];
    if (side && side !== prev) {
      const run = [];
      let j = i;
      while (circuit.trap[j % n] === side && run.length < n) { run.push(j % n); j++; }
      trapRuns.push({ side, run });
    }
  }
  const barrierRuns = [];
  for (const tr of trapRuns) {
    const off = (hw + 18.5) * tr.side * -1 * -1; // left offset sign: side 1 = left
    const pts = [];
    for (let k = 0; k < tr.run.length; k += 2) {
      const i = tr.run[k];
      const o = tr.side === 1 ? hw + 18.5 : -(hw + 18.5);
      void off;
      pts.push([circuit.x[i] - circuit.ty[i] * o, circuit.y[i] + circuit.tx[i] * o]);
    }
    if (pts.length > 1) {
      // open towards the track: track is to the right of a left-side barrier
      addPolyWall(pts, 'tyres', tr.side === 1 ? -1 : 1, 0.55, 0.95, false);
      barrierRuns.push({ pts, side: tr.side });
    }
  }
  // main straight: grandstand wall on the outside (south), pit wall on the inside with gaps
  const straightPts = (offset, s0, s1) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = circuit.s[i];
      if (s >= s0 && s <= s1 && i % 2 === 0) out.push([circuit.x[i] - circuit.ty[i] * offset, circuit.y[i] + circuit.tx[i] * offset]);
    }
    return out;
  };
  // straight runs from s = 0 at x=-230 to about s = 480
  const gWall = straightPts(-(hw + 7), 10, 470);
  addPolyWall(gWall, 'concrete', 1, 0.35, 1.2, false);
  const pitWall = straightPts(hw + 4, 42, 300).filter((p) => !(p[0] > 86 && p[0] < 110) && !(p[0] > -220 && p[0] < -196));
  // split the pit wall where there are gaps
  let cur = [];
  const pitRuns = [];
  for (let i = 0; i < pitWall.length; i++) {
    if (cur.length && Math.hypot(pitWall[i][0] - cur[cur.length - 1][0], pitWall[i][1] - cur[cur.length - 1][1]) > 6) { pitRuns.push(cur); cur = []; }
    cur.push(pitWall[i]);
  }
  if (cur.length) pitRuns.push(cur);
  for (const pr of pitRuns) addPolyWall(pr, 'pitwall', 0, 0.3, 1.0, false);
  // garages along the north edge of the paddock (solid block)
  const GAR = [{ x0: -200, y0: -175.5, x1: -54, y1: -158 }, { x0: -26, y0: -175.5, x1: 80, y1: -158 }];
  for (const g of GAR) addPolyWall([[g.x0, g.y0], [g.x1, g.y0], [g.x1, g.y1], [g.x0, g.y1]], 'building', -1, 0.4, 6, true);

  // the free ends of barriers and walls are round so a car can hit them with its flank
  const endsOf = (pts, r) => { if (pts.length > 1) { posts.push({ x: pts[0][0], y: pts[0][1], r, kind: 'wallend' }); const q = pts[pts.length - 1]; posts.push({ x: q[0], y: q[1], r, kind: 'wallend' }); } };
  for (const br of barrierRuns) endsOf(br.pts, 0.55);
  for (const pr of pitRuns) endsOf(pr, 0.3);
  for (const pr of perimeterRuns) endsOf(pr, 0.45);
  endsOf(gWall, 0.35);
  // gantry legs over the start line
  const iStart = Math.round(sStart / circuit.ds);
  const gx = circuit.x[iStart], gy = circuit.y[iStart], gnx = -circuit.ty[iStart], gny = circuit.tx[iStart];
  const gantry = { x: gx, y: gy, nx: gnx, ny: gny, tx: circuit.tx[iStart], ty: circuit.ty[iStart], span: hw * 2 + 6 };
  posts.push({ x: gx + gnx * (hw + 2.6), y: gy + gny * (hw + 2.6), r: 0.45, kind: 'gantry' }, { x: gx - gnx * (hw + 2.6), y: gy - gny * (hw + 2.6), r: 0.45, kind: 'gantry' });
  // grandstand behind the outside wall
  const stand = { a: straightPts(-(hw + 11), 120, 330) };

  // floodlight towers around the pad and along the circuit
  const lamps = [];
  for (const [x, y] of [[PAD.x0 - 6, PAD.y0 - 6], [PAD.x1 + 6, PAD.y0 - 6], [PAD.x0 - 6, PAD.y1 + 6], [PAD.x1 + 6, PAD.y1 + 6], [(PAD.x0 + PAD.x1) / 2, PAD.y1 + 6], [(PAD.x0 + PAD.x1) / 2, PAD.y0 - 6]]) lamps.push({ x, y, h: 22, kind: 'tower', aim: [(PAD.x0 + PAD.x1) / 2, (PAD.y0 + PAD.y1) / 2] });
  for (let i = 0; i < n; i += 30) {
    const side = circuit.ks[i] > 0 ? -1 : 1; // outside of the bend
    const o = (hw + (circuit.trap[i] ? 21.5 : 10)) * side;
    const x = circuit.x[i] - circuit.ty[i] * o, y = circuit.y[i] + circuit.tx[i] * o;
    if (x < B.x0 + 14 || x > B.x1 - 14 || y < B.y0 + 14 || y > B.y1 - 14) continue;
    if (surfaceAt(x, y).id !== S_GRASS) continue;
    lamps.push({ x, y, h: 14, kind: 'pole', aim: [circuit.x[i], circuit.y[i]] });
  }
  for (const l of lamps) posts.push({ x: l.x, y: l.y, r: l.kind === 'tower' ? 0.5 : 0.22, kind: 'lamp' });

  // trees: a dense belt outside the wall, scattered clumps in the infield grass
  const trees = [];
  const clearOf = (x, y, d) => {
    for (let a = 0; a < 8; a++) {
      const px = x + Math.cos((a / 8) * Math.PI * 2) * d, py = y + Math.sin((a / 8) * Math.PI * 2) * d;
      if (surfaceAt(px, py).id !== S_GRASS) return false;
    }
    return surfaceAt(x, y).id === S_GRASS;
  };
  for (let k = 0; k < 5000 && trees.filter((t) => t.inside).length < 160; k++) {
    const x = B.x0 + 30 + R() * (B.x1 - B.x0 - 60), y = B.y0 + 30 + R() * (B.y1 - B.y0 - 60);
    if (!clearOf(x, y, 24)) continue;
    if (posts.some((p) => Math.hypot(p.x - x, p.y - y) < 8)) continue;
    // clumps: accept more often next to an existing tree
    const near = trees.some((t) => t.inside && Math.hypot(t.x - x, t.y - y) < 14);
    if (!near && R() < 0.75) continue;
    trees.push({ x, y, s: 0.75 + R() * 0.6, kind: R() < 0.35 ? 'poplar' : R() < 0.5 ? 'palm' : 'round', inside: true });
  }
  for (const t of trees) if (t.inside) posts.push({ x: t.x, y: t.y, r: 0.35 * t.s, kind: 'tree' });

  // billboards: on the outside of the circuit facing the track
  const boards = [];
  const BOARD_TEXTS = ['PAKSWAP DRIFT PARK', 'LAHORE TYRE HOUSE', 'KARACHI NITRO CO', 'CHAI BREAK 24/7', 'HUNZA SPEED SHOP', 'PINDI BOYS DRIFT CLUB', 'INDUS GEARBOX WORKS', 'SHAHEEN SPARK PLUGS', 'MULTAN MUFFLERS', 'QUETTA COOLANTS', 'PESHAWAR PISTONS', 'SIALKOT STEERING CO'];
  let bi = 0;
  for (let i = 12; i < n; i += 38) {
    const side = circuit.ks[i] > 0 ? -1 : 1;
    const o = (hw + (circuit.trap[i] ? 23 : 12)) * side;
    const x = circuit.x[i] - circuit.ty[i] * o, y = circuit.y[i] + circuit.tx[i] * o;
    if (x < B.x0 + 14 || x > B.x1 - 14 || y < B.y0 + 14 || y > B.y1 - 14) continue;
    if (!clearOf(x, y, 5)) continue;
    // face the track
    const fx = circuit.x[i] - x, fy = circuit.y[i] - y, fl = Math.hypot(fx, fy);
    boards.push({ x, y, dx: fx / fl, dy: fy / fl, w: 12, h: 3.2, text: BOARD_TEXTS[bi % BOARD_TEXTS.length], style: bi % 4 });
    posts.push({ x: x - (fy / fl) * 5, y: y + (fx / fl) * 5, r: 0.25, kind: 'board' }, { x: x + (fy / fl) * 5, y: y - (fx / fl) * 5, r: 0.25, kind: 'board' });
    bi++;
  }

  // flags (Pakistan) along the paddock and the pad
  const flags = [];
  for (let k = 0; k < 9; k++) flags.push({ x: PADDOCK.x0 + 22 + k * 36, y: PADDOCK.y1 + 13.5, h: 11 });
  for (let k = 0; k < 5; k++) flags.push({ x: PAD.x0 + 20 + k * 42, y: PAD.y1 + 14, h: 9 });
  for (const f of flags) posts.push({ x: f.x, y: f.y, r: 0.12, kind: 'flag' });

  // drift pad furniture: skidpad rings, cone gates, tyre-stack islands
  const pc = [(PAD.x0 + PAD.x1) / 2, (PAD.y0 + PAD.y1) / 2];
  const rings = [{ x: PAD.x0 + 48, y: pc[1], r: 24 }, { x: PAD.x1 - 48, y: pc[1], r: 24 }];
  const cones = [];
  // cones mark both skidpad rings
  for (const rg of rings) for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; cones.push([rg.x + Math.cos(a) * (rg.r - 7), rg.y + Math.sin(a) * (rg.r - 7)]); }
  // a slalom line across the pad (south side) and a gate box on the north side
  for (let k = 0; k < 9; k++) cones.push([PAD.x0 + 34 + k * 17.5, PAD.y0 + 20]);
  for (let k = 0; k < 7; k++) { cones.push([PAD.x0 + 50 + k * 18, PAD.y1 - 16]); cones.push([PAD.x0 + 50 + k * 18, PAD.y1 - 28]); }
  // tyre stack islands in the middle (solid)
  const islands = [[pc[0], pc[1] + 2], [pc[0] - 2, pc[1] - 44]];
  for (const [x, y] of islands) posts.push({ x, y, r: 1.6, kind: 'tyrestack' });

  // spawn points (x, y, heading)
  const spawns = {
    pad: { x: PAD.x0 + 18, y: pc[1] - 4, psi: 0, label: 'Drift pad' },
    circuit: { x: circuit.x[iStart - 9], y: circuit.y[iStart - 9], psi: Math.atan2(circuit.ty[iStart - 9], circuit.tx[iStart - 9]), label: 'Circuit' },
    paddock: { x: -60, y: -190, psi: Math.PI, label: 'Paddock' },
  };

  // ---------------------------------------------------------------- broadphase for colliders
  const GC = 16;
  const gw = Math.ceil((B.x1 - B.x0) / GC), gh = Math.ceil((B.y1 - B.y0) / GC);
  const cells = Array.from({ length: gw * gh }, () => []);
  const addBox = (x0, y0, x1, y1, ref) => {
    const cx0 = Math.max(0, Math.floor((x0 - B.x0) / GC)), cy0 = Math.max(0, Math.floor((y0 - B.y0) / GC));
    const cx1 = Math.min(gw - 1, Math.floor((x1 - B.x0) / GC)), cy1 = Math.min(gh - 1, Math.floor((y1 - B.y0) / GC));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cells[cy * gw + cx].push(ref);
  };
  walls.forEach((w, i) => { const e = w.t + 3; addBox(Math.min(w.ax, w.bx) - e, Math.min(w.ay, w.by) - e, Math.max(w.ax, w.bx) + e, Math.max(w.ay, w.by) + e, i); });
  posts.forEach((p, i) => addBox(p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r, -1 - i));

  // nearest circuit sample (for lap timing, reset and the minimap)
  const SG = 20;
  const sgw = Math.ceil((B.x1 - B.x0) / SG), sgh = Math.ceil((B.y1 - B.y0) / SG);
  const scells = Array.from({ length: sgw * sgh }, () => []);
  for (let i = 0; i < n; i++) {
    const cx = Math.floor((circuit.x[i] - B.x0) / SG), cy = Math.floor((circuit.y[i] - B.y0) / SG);
    if (cx >= 0 && cy >= 0 && cx < sgw && cy < sgh) scells[cy * sgw + cx].push(i);
  }
  const nearestOnCircuit = (x, y, maxD = 60) => {
    const cx = Math.floor((x - B.x0) / SG), cy = Math.floor((y - B.y0) / SG);
    const rr = Math.ceil(maxD / SG);
    let best = -1, bd = maxD * maxD;
    for (let j = cy - rr; j <= cy + rr; j++) for (let k = cx - rr; k <= cx + rr; k++) {
      if (j < 0 || k < 0 || j >= sgh || k >= sgw) continue;
      for (const i of scells[j * sgw + k]) { const d = (circuit.x[i] - x) ** 2 + (circuit.y[i] - y) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    if (best < 0) return null;
    // lateral offset (positive = left of the racing direction)
    const lat = -(x - circuit.x[best]) * circuit.ty[best] + (y - circuit.y[best]) * circuit.tx[best];
    return { i: best, s: circuit.s[best], d: Math.sqrt(bd), lat };
  };

  return {
    bounds: B, cell: CELL, W, H, grid, surfaceAt, circuit, road, dirt, pad: PAD, paddock: PADDOCK, garages: GAR,
    walls, posts, cells, gw, gh, GC, lamps, trees, boards, flags, rings, cones, islands, spawns, gantry, stand, barrierRuns, pitRuns, gWall,
    nearestOnCircuit, sStart, iStart, lot: LOT, gates: GATES, perimeterRuns,
  };
}

// ---------------------------------------------------------------- world physics: surfaces, collisions, cones
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const CONE_R = 0.2;
const ZERO2 = [0, 0];
const ZERO2E = Object.freeze([]);

export class WorldPhysics {
  constructor(layout) {
    this.L = layout;
    this.stamp = new Uint32Array(layout.walls.length + layout.posts.length + 1);
    this.stampId = 1;
    this.events = [];
    this.cones = layout.cones.map(([x, y]) => ({ x, y, x0: x, y0: y, vx: 0, vy: 0, z: 0, vz: 0, yaw: 0, spin: 0, tip: 0, tipDir: 0, moving: false, down: false }));
    this.conesDirty = true;
  }

  surfaceAt(x, y) { return this.L.surfaceAt(x, y); }
  heightAt(x, y) { return this.L.heightAt ? this.L.heightAt(x, y) : 0; }
  groundAt(x, y) { return this.L.groundAt ? this.L.groundAt(x, y) : 0; }
  gradAt(x, y, out) { return this.L.gradAt ? this.L.gradAt(x, y, out) : ZERO2; }

  resetCones() {
    for (const c of this.cones) Object.assign(c, { x: c.x0, y: c.y0, vx: 0, vy: 0, z: 0, vz: 0, yaw: 0, spin: 0, tip: 0, moving: false, down: false });
    this.conesDirty = true;
  }

  // box: oriented box of the car (centre, cos/sin of heading, half length/width, sample points)
  collide(box, car) {
    const L = this.L, B = L.bounds, GC = L.GC;
    const hits = this.hits || (this.hits = []);
    hits.length = 0;
    const { cx, cy, cp, sp, hl, hw, pts } = box;
    const rad = Math.hypot(hl, hw) + 1.2;
    const gx0 = Math.max(0, Math.floor((cx - rad - B.x0) / GC)), gx1 = Math.min(L.gw - 1, Math.floor((cx + rad - B.x0) / GC));
    const gy0 = Math.max(0, Math.floor((cy - rad - B.y0) / GC)), gy1 = Math.min(L.gh - 1, Math.floor((cy + rad - B.y0) / GC));
    const sid = ++this.stampId;
    const nW = L.walls.length;
    const circleBox = (px, py, r, out) => {
      const dx0 = px - cx, dy0 = py - cy;
      const lx = dx0 * cp + dy0 * sp, ly = -dx0 * sp + dy0 * cp;
      const qx = clamp(lx, -hl, hl), qy = clamp(ly, -hw, hw);
      const dx = lx - qx, dy = ly - qy, d2 = dx * dx + dy * dy;
      if (d2 > r * r) return false;
      let nlx, nly, depth, clx = qx, cly = qy;
      if (d2 > 1e-10) { const d = Math.sqrt(d2); nlx = -dx / d; nly = -dy / d; depth = r - d; }
      else {
        const ox = hl - Math.abs(lx), oy = hw - Math.abs(ly);
        if (ox < oy) { nlx = -Math.sign(lx) || -1; nly = 0; depth = ox + r; } else { nlx = 0; nly = -Math.sign(ly) || -1; depth = oy + r; }
        clx = lx; cly = ly;
      }
      out.px = cx + clx * cp - cly * sp; out.py = cy + clx * sp + cly * cp;
      out.nx = nlx * cp - nly * sp; out.ny = nlx * sp + nly * cp; out.depth = depth;
      return true;
    };
    const tmp = this.tmpHit || (this.tmpHit = { px: 0, py: 0, nx: 0, ny: 0, depth: 0 });
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      for (const ref of L.cells[gy * L.gw + gx]) {
        const key = ref >= 0 ? ref : nW - 1 - ref;
        if (this.stamp[key] === sid) continue;
        this.stamp[key] = sid;
        if (ref >= 0) {
          const w = L.walls[ref];
          const dx = w.bx - w.ax, dy = w.by - w.ay, L2 = dx * dx + dy * dy;
          // quick reject by distance from the car centre to the segment
          let tc = ((cx - w.ax) * dx + (cy - w.ay) * dy) / L2; tc = clamp(tc, 0, 1);
          if (Math.hypot(cx - (w.ax + dx * tc), cy - (w.ay + dy * tc)) > rad + w.t + 3) continue;
          for (let k = 0; k < pts.length; k++) {
            const px = pts[k][0], py = pts[k][1];
            const t = ((px - w.ax) * dx + (py - w.ay) * dy) / L2;
            if (w.nx || w.ny) {
              if (t < 0 || t > 1) continue;
              const sd = (px - w.ax) * w.nx + (py - w.ay) * w.ny;
              if (sd < w.t && sd > -(w.d ?? 3)) hits.push({ px, py, nx: w.nx, ny: w.ny, depth: w.t - sd, kind: w.kind, restitution: w.kind === 'tyres' ? 0.3 : 0.2, friction: w.kind === 'tyres' ? 0.45 : 0.25 });
            } else {
              const tt = clamp(t, 0, 1);
              const qx = w.ax + dx * tt, qy = w.ay + dy * tt;
              const ex = px - qx, ey = py - qy, d = Math.hypot(ex, ey);
              if (d < w.t) {
                let nx, ny;
                if (d > 1e-6) { nx = ex / d; ny = ey / d; } else { const l = Math.sqrt(L2); nx = -dy / l; ny = dx / l; if ((cx - qx) * nx + (cy - qy) * ny < 0) { nx = -nx; ny = -ny; } }
                hits.push({ px, py, nx, ny, depth: w.t - d, kind: w.kind, restitution: 0.2, friction: 0.25 });
              }
            }
          }
        } else {
          const p = L.posts[-1 - ref];
          if (circleBox(p.x, p.y, p.r, tmp)) hits.push({ px: tmp.px, py: tmp.py, nx: tmp.nx, ny: tmp.ny, depth: tmp.depth, kind: p.kind, restitution: p.kind === 'tyrestack' ? 0.3 : 0.12, friction: 0.3 });
        }
      }
    }
    // moving and parked cars (oriented boxes with a velocity)
    if (this.dyn) {
      for (const o of this.dyn) {
        if (Math.abs(o.x - cx) > rad + 6 || Math.abs(o.y - cy) > rad + 6) continue;
        const oc = Math.cos(o.psi), os = Math.sin(o.psi);
        for (let k = 0; k < pts.length; k++) {
          const dx = pts[k][0] - o.x, dy = pts[k][1] - o.y;
          const lx = dx * oc + dy * os, ly = -dx * os + dy * oc;
          if (Math.abs(lx) >= o.hl || Math.abs(ly) >= o.hw) continue;
          const ox = o.hl - Math.abs(lx), oy = o.hw - Math.abs(ly);
          let nx, ny, depth;
          if (ox < oy) { const sg = Math.sign(lx) || 1; nx = oc * sg; ny = os * sg; depth = ox; } else { const sg = Math.sign(ly) || 1; nx = -os * sg; ny = oc * sg; depth = oy; }
          hits.push({ px: pts[k][0], py: pts[k][1], nx, ny, depth: Math.min(depth, 0.6), kind: 'car', restitution: 0.15, friction: 0.3, vx: o.vx, vy: o.vy, dyn: o });
        }
        for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const qx = o.x + oc * o.hl * a - os * o.hw * b, qy = o.y + os * o.hl * a + oc * o.hw * b;
          if (circleBox(qx, qy, 0.05, tmp)) hits.push({ px: tmp.px, py: tmp.py, nx: tmp.nx, ny: tmp.ny, depth: Math.min(tmp.depth, 0.6), kind: 'car', restitution: 0.15, friction: 0.3, vx: o.vx, vy: o.vy, dyn: o });
        }
      }
    }
    // cones: knocked away, they hardly slow the car
    if (car) {
      const cpv = Math.cos(car.psi), spv = Math.sin(car.psi);
      const vx = car.u * cpv - car.v * spv, vy = car.u * spv + car.v * cpv;
      for (const c of this.cones) {
        if (Math.abs(c.x - cx) > rad + 1 || Math.abs(c.y - cy) > rad + 1) continue;
        if (c.z > 0.4) continue;
        if (!circleBox(c.x, c.y, CONE_R, tmp)) continue;
        const rx = c.x - car.x, ry = c.y - car.y;
        const pvx = vx - car.r * ry, pvy = vy + car.r * rx;
        const sp2 = Math.hypot(pvx, pvy);
        // push the cone out of the car along the normal and give it the car's local velocity
        c.x -= tmp.nx * tmp.depth; c.y -= tmp.ny * tmp.depth;
        const kick = 1 + 0.25 * sp2;
        c.vx = pvx * 1.15 - tmp.nx * kick; c.vy = pvy * 1.15 - tmp.ny * kick;
        if (sp2 > 1.5) {
          c.vz = Math.min(5, 0.8 + sp2 * 0.18); c.spin = (Math.random() - 0.5) * 18;
          c.tipDir = Math.atan2(c.vy, c.vx);
          if (!c.down) this.events.push({ type: 'cone', v: sp2, x: c.x, y: c.y });
          c.down = true;
        }
        c.moving = true;
        this.conesDirty = true;
      }
    }
    return hits;
  }

  update(dt) {
    for (const c of this.cones) {
      if (!c.moving) continue;
      c.x += c.vx * dt; c.y += c.vy * dt;
      c.z += c.vz * dt; c.vz -= 9.81 * dt;
      if (c.z <= 0) { c.z = 0; c.vz = Math.abs(c.vz) > 1.2 ? -c.vz * 0.3 : 0; }
      const sp = Math.hypot(c.vx, c.vy);
      if (c.z === 0) {
        const dec = (c.down ? 5.5 : 9) * dt;
        if (sp <= dec) { c.vx = 0; c.vy = 0; } else { c.vx -= (c.vx / sp) * dec; c.vy -= (c.vy / sp) * dec; }
      }
      c.yaw += c.spin * dt; c.spin *= Math.exp(-dt * 2);
      if (c.down) c.tip = Math.min(Math.PI / 2, c.tip + dt * 7);
      if (sp < 0.03 && c.z === 0 && c.vz === 0 && (!c.down || c.tip >= Math.PI / 2)) c.moving = false;
      this.conesDirty = true;
    }
  }

  drain() { if (!this.events.length) return ZERO2E; const e = this.events; this.events = []; return e; }
}
