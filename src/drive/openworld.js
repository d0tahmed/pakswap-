// The open world: a 5.2 km square of Punjab-to-Murree country around the PakSwap Drift Park.
// Motorway with a toll plaza and a service area, a city with a grid of streets, markets and a
// roundabout, a village with fields and a dhaba on the GT road, a mountain road climbing to a
// viewpoint, and a lake road. Pure data: terrain, roads, surfaces, colliders, props, spawns.
import { buildLayout, ribbon, SURFACES, S_GRASS, S_ASPHALT, S_KERB, S_GRAVEL, S_CONCRETE, S_DIRT, CONE_R } from './track.js';
import { Heightfield, makeBase, profileRoad, buildHeightfield, smoothstep, fbm, vnoise } from './terrain.js';

export const S_SIDEWALK = 6, S_WATER = 7, S_SAND = 8, S_ROCK = 9, S_FIELD = 10;
export const WORLD_SURFACES = [
  ...SURFACES,
  { id: 6, kind: 'sidewalk', mu: 0.95, roll: 1.1, rough: 0.1, lift: 0.15 },
  { id: 7, kind: 'water', mu: 0.25, roll: 80, rough: 0.6, water: true },
  { id: 8, kind: 'sand', mu: 0.55, roll: 14, rough: 0.5, dust: '#c8b48a' },
  { id: 9, kind: 'rock', mu: 0.78, roll: 2, rough: 0.6, dust: '#8a8274' },
  { id: 10, kind: 'field', mu: 0.6, roll: 11, rough: 0.5, dust: '#a08a5a' },
];

export const ROAD_TYPES = {
  // verge: level ground either side of the tarmac (wider than one terrain cell so the hill never
  // pokes through the road and the wheels always sit on a smooth surface)
  motorway: { half: 13, smooth: 240, maxGrade: 0.04, surface: S_ASPHALT, verge: 6, mark: 'motorway', lanes: [5.0, 8.7] },
  highway: { half: 5.6, smooth: 120, maxGrade: 0.07, surface: S_ASPHALT, verge: 6, mark: 'highway', lanes: [2.0] },
  gt: { half: 5.6, smooth: 110, maxGrade: 0.092, surface: S_ASPHALT, verge: 6, mark: 'highway', lanes: [2.0] },
  boulevard: { half: 8.5, smooth: 80, maxGrade: 0.06, surface: S_ASPHALT, verge: 6, mark: 'boulevard', sidewalk: 3.2, lanes: [2.6, 6.1] },
  street: { half: 4.8, smooth: 60, maxGrade: 0.08, surface: S_ASPHALT, verge: 6, mark: 'street', sidewalk: 2.6, lanes: [1.75] },
  ring: { half: 6.2, smooth: 30, maxGrade: 0.05, surface: S_ASPHALT, verge: 6, mark: 'ring', lanes: [2.5] },
  mountain: { half: 3.9, smooth: 50, maxGrade: 0.115, surface: S_ASPHALT, verge: 6, mark: 'mountain', lanes: [1.9] },
  dirt: { half: 2.7, smooth: 40, maxGrade: 0.14, surface: S_DIRT, verge: 6, mark: null, lanes: [0] },
  pad: { half: 10, smooth: 10, maxGrade: 1, surface: S_CONCRETE, verge: 4, mark: null },
};

const W = {
  bounds: { x0: -2600, y0: -2600, x1: 2600, y1: 2600 },
  res: 4,
  lake: { x: 1500, y: 430, rx: 380, ry: 300, depth: 26, level: -9 },
  pass: { y: -1140, w: 420 },
  flats: [
    { x0: -470, y0: -340, x1: 470, y1: 340, h: 0, blend: 170 }, // drift park
    { x0: 1020, y0: -2340, x1: 2180, y1: -1260, h: 3, blend: 230 }, // city
    { x: -1640, y: -470, r: 230, h: 2.5, blend: 200, k: 0.85 }, // village
  ],
};

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- tiled surface raster (0.5 m cells)
class SurfaceMap {
  constructor(bounds, cell = 0.5, tile = 64) {
    this.b = bounds; this.cell = cell; this.tile = tile; this.n = tile / cell;
    this.tx = Math.ceil((bounds.x1 - bounds.x0) / tile); this.ty = Math.ceil((bounds.y1 - bounds.y0) / tile);
    this.tiles = new Map();
  }
  get(x, y) {
    const fx = (x - this.b.x0) / this.tile, fy = (y - this.b.y0) / this.tile;
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const t = this.tiles.get(ty * this.tx + tx);
    if (!t) return 0;
    const cx = Math.floor((fx - tx) * this.n), cy = Math.floor((fy - ty) * this.n);
    return t[cy * this.n + cx];
  }
  set(cxg, cyg, id, onlyOver) {
    // global cell index -> tile
    const n = this.n;
    const tx = Math.floor(cxg / n), ty = Math.floor(cyg / n);
    if (tx < 0 || ty < 0 || tx >= this.tx || ty >= this.ty) return;
    const k = ty * this.tx + tx;
    let t = this.tiles.get(k);
    if (!t) { if (onlyOver && !onlyOver.includes(0)) return; t = new Uint8Array(n * n); this.tiles.set(k, t); }
    const o = (cyg - ty * n) * n + (cxg - tx * n);
    if (onlyOver && !onlyOver.includes(t[o])) return;
    t[o] = id;
  }
  fillQuad(q, id, onlyOver) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of q) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const c = this.cell, B = this.b;
    const cx0 = Math.floor((x0 - B.x0) / c), cy0 = Math.floor((y0 - B.y0) / c), cx1 = Math.floor((x1 - B.x0) / c), cy1 = Math.floor((y1 - B.y0) / c);
    let sign = 0;
    for (let k = 0; k < 4 && !sign; k++) { const a = q[k], b = q[(k + 1) % 4], d = q[(k + 2) % 4]; const cr = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]); if (cr !== 0) sign = Math.sign(cr); }
    for (let cy = cy0; cy <= cy1; cy++) {
      const py = B.y0 + (cy + 0.5) * c;
      for (let cx = cx0; cx <= cx1; cx++) {
        const px = B.x0 + (cx + 0.5) * c;
        let inside = true;
        for (let k = 0; k < 4; k++) { const a = q[k], b = q[(k + 1) % 4]; if (((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) * sign < -1e-9) { inside = false; break; } }
        if (inside) this.set(cx, cy, id, onlyOver);
      }
    }
  }
  fillRect(r, id, onlyOver) { this.fillQuad([[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]], id, onlyOver); }
  fillCircle(x, y, r, id, onlyOver) {
    const c = this.cell, B = this.b;
    for (let cy = Math.floor((y - r - B.y0) / c); cy <= Math.floor((y + r - B.y0) / c); cy++) for (let cx = Math.floor((x - r - B.x0) / c); cx <= Math.floor((x + r - B.x0) / c); cx++) {
      const px = B.x0 + (cx + 0.5) * c, py = B.y0 + (cy + 0.5) * c;
      if ((px - x) ** 2 + (py - y) ** 2 <= r * r) this.set(cx, cy, id, onlyOver);
    }
  }
  fillBand(rb, o0, o1, id, i0 = 0, i1 = rb.n - 1, onlyOver) {
    const N = rb.n;
    for (let i = i0; i < i1; i++) {
      const a = i % N, b = (i + 1) % N;
      const nax = -rb.ty[a], nay = rb.tx[a], nbx = -rb.ty[b], nby = rb.tx[b];
      this.fillQuad([[rb.x[a] + nax * o0, rb.y[a] + nay * o0], [rb.x[b] + nbx * o0, rb.y[b] + nby * o0], [rb.x[b] + nbx * o1, rb.y[b] + nby * o1], [rb.x[a] + nax * o1, rb.y[a] + nay * o1]], id, onlyOver);
    }
  }
}

// ---------------------------------------------------------------- road network
function defineRoads() {
  const R = [];
  const add = (id, type, pts, opts = {}) => { R.push({ id, type: ROAD_TYPES[type], typeName: type, pts, ...opts }); };
  const J = (road, x, y) => ({ onRoad: road, near: [x, y] });
  add('M9', 'motorway', [[-2720, -1185], [-2050, -1090], [-1320, -1015], [-620, -1000], [0, -1012], [620, -992], [1260, -1018], [1900, -1108], [2720, -1195]], { name: 'M-9 Motorway' });
  // city: boulevard north-south, avenue east-west through a roundabout, a grid of streets
  add('BLVD-N', 'boulevard', [J('M9', 1600, -1060), [1600, -1240], [1600, -1500], [1600, -1769]], { name: 'Jinnah Boulevard' });
  add('BLVD-S', 'boulevard', [[1600, -1831], [1600, -2100], [1600, -2330]], { name: 'Jinnah Boulevard' });
  add('AVE-W', 'boulevard', [[1040, -1800], [1300, -1800], [1569, -1800]], { name: 'Iqbal Avenue' });
  add('AVE-E', 'boulevard', [[1631, -1800], [1900, -1800], [2160, -1800]], { name: 'Iqbal Avenue' });
  const ring = [];
  for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; ring.push([1600 + Math.cos(a) * 31, -1800 + Math.sin(a) * 31]); }
  add('RING', 'ring', ring, { closed: true, name: 'Chowk' });
  for (const x of [1180, 1390, 1810, 2020]) add(`ST-NS${x}`, 'street', [[x, -1300], [x, -1560], [x, -2040], [x, -2300]], { name: 'Street' });
  for (const y of [-1385, -1590, -2010, -2220]) add(`ST-EW${y}`, 'street', [[1060, y], [1400, y], [1800, y], [2140, y]], { name: 'Street' });
  // the park's south gate down to the motorway
  add('ACCESS', 'highway', [[0, -334], [0, -420], [30, -580], [-26, -770], [0, -930], J('M9', 0, -1012)], { name: 'Park Road' });
  // mountain road from the park's north gate to the viewpoint and on to the GT road
  add('MURREE', 'mountain', [[-60, 334], [-60, 420], [-18, 560], [92, 690], [58, 832], [-92, 962], [-40, 1102], [142, 1212], [262, 1382], [108, 1522], [202, 1692], [392, 1822], [522, 2002], [420, 2162], [178, 2232], [-182, 2152], [-522, 2062], [-862, 1962], [-1152, 1822]], { name: 'Murree Road' });
  // lake road: motorway, east and north shores, joins the mountain road
  add('LAKE', 'highway', [J('M9', 2180, -1140), [2200, -700], [2170, -260], [2090, 140], [2010, 520], [1800, 885], [1440, 955], [1060, 852], [700, 650], [380, 640], J('MURREE', 92, 690)], { name: 'Lake Road' });
  // GT road on the west: motorway, village, up the valley to the mountain road
  add('GT', 'gt', [J('M9', -1500, -1040), [-1518, -760], [-1642, -480], [-1622, -150], [-1482, 250], [-1322, 640], [-1520, 880], [-1260, 1040], [-1500, 1240], [-1240, 1410], [-1440, 1590], [-1250, 1720], J('MURREE', -1152, 1822)], { name: 'GT Road' });
  // the park's west gate to the GT road
  add('PARKW', 'highway', [[-464, 60], [-560, 60], [-800, 22], [-1100, -78], [-1400, -158], J('GT', -1622, -150)], { name: 'Park Road West' });
  // village dirt tracks
  add('D1', 'dirt', [J('GT', -1642, -480), [-1800, -468], [-1990, -520], [-2160, -440], [-2280, -300]], { name: 'Village track' });
  add('D2', 'dirt', [J('GT', -1630, -300), [-1790, -265], [-1960, -150], [-2060, 30]], { name: 'Village track' });
  add('D3', 'dirt', [J('GT', -1560, -640), [-1380, -560], [-1220, -620], [-1060, -560]], { name: 'Village track' });
  return R;
}

// resolve [x, 'ROADID'] endpoints to the nearest point on an already built road
function nearestSample(rb, x, y) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < rb.n; i++) { const d = (rb.x[i] - x) ** 2 + (rb.y[i] - y) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
}

export function buildOpenWorld(opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const R = rng(4242);
  const park = buildLayout();
  const roads = defineRoads();
  const byId = new Map();
  // unflattened base for 'auto' flats is not needed: flats carry explicit heights
  const base = makeBase(W);
  const junctions = [];
  // ---------------------------------------------------------------- ribbons, profiles, junction pins
  for (const rd of roads) {
    const pins = [];
    const pts = rd.pts.map((p, k) => {
      if (Array.isArray(p)) return p;
      // attach to an already built road at its sample nearest the hint
      const other = byId.get(p.onRoad);
      const bi = nearestSample(other.rb, p.near[0], p.near[1]);
      rd.attach = rd.attach || [];
      rd.attach.push({ k, road: other, i: bi });
      return [other.rb.x[bi], other.rb.y[bi]];
    });
    rd.rb = ribbon(pts, !!rd.closed, rd.type === ROAD_TYPES.motorway ? 6 : 4);
    for (const a of rd.attach || []) {
      const i = a.k === 0 ? 0 : rd.rb.n - 1;
      pins.push({ i, h: a.road.h[a.i], flat: a.road.type.half + 8 });
      junctions.push({ x: a.road.rb.x[a.i], y: a.road.rb.y[a.i], r: Math.max(rd.type.half, a.road.type.half) + 2, a: rd.id, b: a.road.id, tx: a.road.rb.tx[a.i], ty: a.road.rb.ty[a.i] });
    }
    // park gates are at the park's floor height
    if (['ACCESS', 'MURREE', 'PARKW'].includes(rd.id)) pins.push({ i: 0, h: 0, flat: 12 });
    rd.h = profileRoad(rd.rb, base, rd.type, pins);
    byId.set(rd.id, rd);
  }
  // city grid crossings
  const xsNS = [1180, 1390, 1600, 1810, 2020], ysEW = [-1385, -1590, -1800, -2010, -2220];
  for (const x of xsNS) for (const y of ysEW) {
    if (x === 1600 && y === -1800) continue;
    const hw = (x === 1600 || y === -1800) ? ROAD_TYPES.boulevard.half : ROAD_TYPES.street.half;
    junctions.push({ x, y, r: hw + 1.5, city: true, cross: true, a: 'grid', b: 'grid' });
  }
  // service pads beside the roads (carved flat like a road)
  const M9 = byId.get('M9');
  const atM9 = (x) => { let bi = 0, bd = Infinity; for (let i = 0; i < M9.rb.n; i++) { const d = Math.abs(M9.rb.x[i] - x); if (d < bd) { bd = d; bi = i; } } return bi; };
  const pads = [];
  const addPad = (id, rect, h, kind) => {
    const cx = (rect.x0 + rect.x1) / 2;
    const half = (rect.y1 - rect.y0) / 2;
    const rd = { id, type: { ...ROAD_TYPES.pad, half }, typeName: 'pad', pts: [[rect.x0, (rect.y0 + rect.y1) / 2], [rect.x1, (rect.y0 + rect.y1) / 2]] };
    rd.rb = ribbon(rd.pts, false, 4);
    rd.h = new Float32Array(rd.rb.n).fill(h);
    pads.push({ id, rect, h, kind, rd, cx });
    return rd;
  };
  const iGas = atM9(-700), hGas = M9.h[iGas];
  addPad('GAS', { x0: -770, y0: M9.rb.y[iGas] - 13 - 44, x1: -630, y1: M9.rb.y[iGas] - 12.5 }, hGas, 'gas');
  const iToll = atM9(900), hToll = M9.h[iToll];
  addPad('TOLL', { x0: 840, y0: M9.rb.y[iToll] - 27, x1: 960, y1: M9.rb.y[iToll] + 27 }, hToll, 'toll');
  const GT = byId.get('GT');
  const iDhaba = nearestSample(GT.rb, -1530, -820);
  addPad('DHABA', { x0: GT.rb.x[iDhaba] - 75, y0: GT.rb.y[iDhaba] - 32, x1: GT.rb.x[iDhaba] - GT.type.half - 1, y1: GT.rb.y[iDhaba] + 32 }, GT.h[iDhaba], 'dhaba');
  const MR = byId.get('MURREE');
  const iView = nearestSample(MR.rb, 470, 2120);
  addPad('VIEW', { x0: MR.rb.x[iView] + MR.type.half - 2, y0: MR.rb.y[iView] - 22, x1: MR.rb.x[iView] + 60, y1: MR.rb.y[iView] + 22 }, MR.h[iView], 'view');
  // ---------------------------------------------------------------- heightfield
  const carve = [...roads, ...pads.map((p) => p.rd)];
  const HF = buildHeightfield(W, base, carve);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  // ---------------------------------------------------------------- surfaces
  const SM = new SurfaceMap(W.bounds);
  // copy the park raster (same 0.5 m cells, park origin at world origin)
  {
    const P = park;
    const offX = Math.round((P.bounds.x0 - W.bounds.x0) / 0.5), offY = Math.round((P.bounds.y0 - W.bounds.y0) / 0.5);
    for (let j = 0; j < P.H; j++) for (let i = 0; i < P.W; i++) { const v = P.grid[j * P.W + i]; if (v) SM.set(offX + i, offY + j, v); }
  }
  for (const rd of roads) {
    const t = rd.type;
    if (t.sidewalk) {
      SM.fillBand(rd.rb, t.half, t.half + t.sidewalk, S_SIDEWALK, 0, rd.rb.n - 1, [S_GRASS]);
      SM.fillBand(rd.rb, -t.half - t.sidewalk, -t.half, S_SIDEWALK, 0, rd.rb.n - 1, [S_GRASS]);
    }
  }
  for (const rd of roads) SM.fillBand(rd.rb, -rd.type.half, rd.type.half, rd.type.surface, 0, rd.closed ? rd.rb.n : rd.rb.n - 1, rd.type.surface === S_DIRT ? [S_GRASS, S_SIDEWALK] : null);
  // roundabout island (grass with a monument)
  SM.fillCircle(1600, -1800, 24.5, S_SIDEWALK);
  SM.fillCircle(1600, -1800, 23, S_GRASS);
  for (const p of pads) SM.fillRect(p.rect, p.kind === 'dhaba' ? S_DIRT : S_CONCRETE, [S_GRASS, S_SIDEWALK]);
  for (const j of junctions) if (j.cross) SM.fillCircle(j.x, j.y, j.r, S_ASPHALT);

  // ---------------------------------------------------------------- city: blocks of buildings
  const city = { buildings: [], tanks: [], lights: [], poles: [], signs: [] };
  const colliders = { walls: [], posts: [] };
  const addRectWall = (r, kind, h) => {
    const pts = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
    for (let k = 0; k < 4; k++) {
      const a = pts[k], b = pts[(k + 1) % 4];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      // open to the outside (rect corners are counter-clockwise, so the outside is on the right)
      colliders.walls.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], t: 0.3, nx: dy / L, ny: -dx / L, kind, h, d: Math.min(3, k % 2 ? r.x1 - r.x0 : r.y1 - r.y0) });
    }
  };
  {
    const xs = [1060, 1180, 1390, 1600, 1810, 2020, 2140];
    const ys = [-2300, -2220, -2010, -1800, -1590, -1385, -1300];
    const halfAt = (v, isX) => (isX ? (v === 1600 ? 8.5 + 3.2 : 4.8 + 2.6) : (v === -1800 ? 8.5 + 3.2 : 4.8 + 2.6));
    const shopNames = ['AL-MADINA TRADERS', 'KARACHI BIRYANI HOUSE', 'BISMILLAH AUTO PARTS', 'MOBILE ZONE', 'CHAI POINT', 'NEW STAR TAILORS', 'FAZAL MEDICAL STORE', 'LAHORE SWEETS & BAKERS', 'SHAHEEN ELECTRONICS', 'MASHALLAH CLOTH HOUSE', 'PUNJAB HARDWARE', 'GHOUSIA HOTEL', 'ROYAL OPTICS', 'CITY GENERAL STORE', 'HAMZA TYRE SHOP', 'NOOR JEWELLERS', 'KHAN BROTHERS', 'AL-REHMAN PHARMACY', 'PAK FAN HOUSE', 'TAJ PHOTO STUDIO'];
    let si = 0;
    for (let a = 0; a < xs.length - 1; a++) for (let b = 0; b < ys.length - 1; b++) {
      const bx0 = xs[a] + (a === 0 ? 0 : halfAt(xs[a], true)), bx1 = xs[a + 1] - (a === xs.length - 2 ? 0 : halfAt(xs[a + 1], true));
      const by0 = ys[b] + (b === 0 ? 0 : halfAt(ys[b], false)), by1 = ys[b + 1] - (b === ys.length - 2 ? 0 : halfAt(ys[b + 1], false));
      if (bx1 - bx0 < 20 || by1 - by0 < 20) continue;
      const nearMain = (xs[a] === 1600 || xs[a + 1] === 1600 || ys[b] === -1800 || ys[b + 1] === -1800);
      const plots = [];
      // frontage plots along the four edges; corners belong to the north and south rows
      const depthMax = Math.min(20, (by1 - by0) / 2 - 2), depthMaxX = Math.min(20, (bx1 - bx0) / 2 - 2);
      for (const edge of ['S', 'N']) {
        let x = bx0;
        while (x < bx1 - 6) {
          const w = Math.min(bx1 - x, 8 + R() * 12);
          const d = Math.min(depthMax, 12 + R() * 8);
          plots.push(edge === 'S' ? { x0: x, y0: by0, x1: x + w, y1: by0 + d, face: 'S' } : { x0: x, y0: by1 - d, x1: x + w, y1: by1, face: 'N' });
          x += w;
        }
      }
      for (const edge of ['W', 'E']) {
        let y = by0 + depthMax;
        while (y < by1 - depthMax - 6) {
          const w = Math.min(by1 - depthMax - y, 8 + R() * 12);
          const d = Math.min(depthMaxX, 12 + R() * 8);
          plots.push(edge === 'W' ? { x0: bx0, y0: y, x1: bx0 + d, y1: y + w, face: 'W' } : { x0: bx1 - d, y0: y, x1: bx1, y1: y + w, face: 'E' });
          y += w;
        }
      }
      for (const p of plots) {
        // keep clear of the roundabout
        const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
        if (Math.hypot(cx - 1600, cy + 1800) < 52) continue;
        if (p.x1 - p.x0 < 5 || p.y1 - p.y0 < 5) continue;
        const inset = 0.4;
        const r = { x0: p.x0 + inset, y0: p.y0 + inset, x1: p.x1 - inset, y1: p.y1 - inset };
        const floors = nearMain ? 3 + Math.floor(R() * 4) : 2 + Math.floor(R() * 3);
        const bld = { ...r, face: p.face, floors, h: HF.heightAt(cx, cy), variant: Math.floor(R() * 4), tint: Math.floor(R() * 6), shop: si % shopNames.length, signAt: R() };
        si++;
        city.buildings.push(bld);
        addRectWall(r, 'building', floors * 3.2);
        if (R() < 0.85) city.tanks.push({ x: r.x0 + 1.5 + R() * (r.x1 - r.x0 - 3), y: r.y0 + 1.5 + R() * (r.y1 - r.y0 - 3), h: bld.h + floors * 3.2 + 0.25 });
      }
    }
    // a mosque by the roundabout and a glass tower on the boulevard
    city.mosque = { x: 1690, y: -1700, r: 9, h: HF.heightAt(1690, -1700) };
    city.tower = { x0: 1622, y0: -1470, x1: 1660, y1: -1430, floors: 14, h: HF.heightAt(1640, -1450) };
    // street lights on the sidewalks, electric poles with wires along the streets
    for (const rd of roads.filter((r) => r.type.sidewalk)) {
      const off = rd.type.half + rd.type.sidewalk - 0.6;
      for (let i = 4; i < rd.rb.n; i += 8) {
        const side = (i / 8) % 2 ? 1 : -1;
        const x = rd.rb.x[i] - rd.rb.ty[i] * off * side, y = rd.rb.y[i] + rd.rb.tx[i] * off * side;
        if (junctions.some((j) => Math.hypot(j.x - x, j.y - y) < j.r + 4)) continue;
        city.lights.push({ x, y, h: HF.heightAt(x, y), dir: Math.atan2(-rd.rb.tx[i] * side, -rd.rb.ty[i] * side) });
      }
    }
    // remove buildings that overlap the mosque / tower plots
    city.buildings = city.buildings.filter((b) => !(b.x1 > city.tower.x0 - 2 && b.x0 < city.tower.x1 + 2 && b.y1 > city.tower.y0 - 2 && b.y0 < city.tower.y1 + 2) && Math.hypot((b.x0 + b.x1) / 2 - city.mosque.x, (b.y0 + b.y1) / 2 - city.mosque.y) > 18);
    colliders.walls = colliders.walls.filter((w) => !(Math.min(w.ax, w.bx) > city.tower.x0 - 3 && Math.max(w.ax, w.bx) < city.tower.x1 + 3 && Math.min(w.ay, w.by) > city.tower.y0 - 3 && Math.max(w.ay, w.by) < city.tower.y1 + 3) && Math.hypot((w.ax + w.bx) / 2 - city.mosque.x, (w.ay + w.by) / 2 - city.mosque.y) > 18);
    addRectWall(city.tower, 'building', 45);
    colliders.posts.push({ x: city.mosque.x, y: city.mosque.y, r: city.mosque.r, kind: 'building' });
    city.tanks = city.tanks.filter((t) => city.buildings.some((b) => t.x > b.x0 && t.x < b.x1 && t.y > b.y0 && t.y < b.y1));
    for (const l of city.lights) colliders.posts.push({ x: l.x, y: l.y, r: 0.14, kind: 'pole' });
    city.monument = { x: 1600, y: -1800, h: HF.heightAt(1600, -1800) };
    colliders.posts.push({ x: 1600, y: -1800, r: 6, kind: 'monument' });
  }

  // ---------------------------------------------------------------- village, fields, dhaba
  const village = { houses: [], walls: [], fields: [], mosque: null };
  {
    const vx = -1640, vy = -470;
    const roadClear = (x, y, d) => {
      for (const rd of roads) {
        if (!['GT', 'D1', 'D2', 'D3', 'PARKW'].includes(rd.id)) continue;
        for (let i = 0; i < rd.rb.n; i += 2) if ((rd.rb.x[i] - x) ** 2 + (rd.rb.y[i] - y) ** 2 < (d + rd.type.half) ** 2) return false;
      }
      return true;
    };
    for (let k = 0; k < 400 && village.houses.length < 46; k++) {
      const a = R() * Math.PI * 2, r = 30 + Math.sqrt(R()) * 210;
      const x = vx + Math.cos(a) * r, y = vy + Math.sin(a) * r;
      const w = 8 + R() * 7, d = 7 + R() * 6;
      if (!roadClear(x, y, Math.max(w, d) / 2 + 5)) continue;
      if (village.houses.some((h) => Math.abs(h.x - x) < (h.w + w) / 2 + 6 && Math.abs(h.y - y) < (h.d + d) / 2 + 6)) continue;
      const hh = { x, y, w, d, floors: R() < 0.25 ? 2 : 1, h: HF.heightAt(x, y), tone: Math.floor(R() * 4) };
      village.houses.push(hh);
      const r0 = { x0: x - w / 2, y0: y - d / 2, x1: x + w / 2, y1: y + d / 2 };
      addRectWall(r0, 'building', hh.floors * 3);
      // courtyard wall on one side
      if (R() < 0.55) {
        const cy = y + d / 2 + 6;
        const cw = { x0: x - w / 2, y0: y + d / 2, x1: x + w / 2, y1: cy };
        if (roadClear((cw.x0 + cw.x1) / 2, (cw.y0 + cw.y1) / 2, 6)) {
          village.walls.push({ ax: cw.x0, ay: cw.y1, bx: cw.x1, by: cw.y1 }, { ax: cw.x0, ay: cw.y0, bx: cw.x0, by: cw.y1 });
          colliders.walls.push({ ax: cw.x0, ay: cw.y1, bx: cw.x1, by: cw.y1, t: 0.15, nx: 0, ny: 0, kind: 'mudwall', h: 1.9 }, { ax: cw.x0, ay: cw.y0, bx: cw.x0, by: cw.y1, t: 0.15, nx: 0, ny: 0, kind: 'mudwall', h: 1.9 });
        }
      }
    }
    village.mosque = { x: vx + 40, y: vy + 70, r: 6, h: HF.heightAt(vx + 40, vy + 70) };
    if (!roadClear(village.mosque.x, village.mosque.y, 12)) village.mosque.x += 30;
    colliders.posts.push({ x: village.mosque.x, y: village.mosque.y, r: 7, kind: 'building' });
    // fields: wheat, mustard and fodder in long strips around the village and along the plain
    const kinds = ['wheat', 'mustard', 'green', 'wheat', 'ploughed'];
    for (let k = 0; k < 140; k++) {
      const cx = -2450 + R() * 2200, cy = -950 + R() * 1250;
      if (Math.hypot(cx - vx, cy - vy) < 230) continue;
      const w = 50 + R() * 90, d = 30 + R() * 50, ang = (R() < 0.5 ? 0 : Math.PI / 2) + (R() - 0.5) * 0.25;
      if (!roadClear(cx, cy, Math.max(w, d) / 2 + 4)) continue;
      if (cx > -520 && cy > -380) continue;
      village.fields.push({ x: cx, y: cy, w, d, ang, kind: kinds[k % kinds.length] });
    }
  }
  // dhaba (truck stop) and service buildings
  const props = { gas: null, toll: null, dhaba: null, view: null, gantries: [], guardrails: [], medians: [], boards: [], poles: [], wires: [], endBarriers: [] };
  for (const p of pads) {
    const r = p.rect;
    if (p.kind === 'gas') {
      props.gas = { rect: r, h: p.h, canopy: { x0: r.x0 + 30, y0: r.y0 + 10, x1: r.x0 + 80, y1: r.y1 - 6 }, shop: { x0: r.x1 - 40, y0: r.y0 + 4, x1: r.x1 - 10, y1: r.y0 + 18 } };
      addRectWall(props.gas.shop, 'building', 4.5);
      for (let k = 0; k < 4; k++) { const x = r.x0 + 38 + k * 11; colliders.walls.push(...rectWalls({ x0: x - 0.6, y0: (r.y0 + r.y1) / 2 - 1.4, x1: x + 0.6, y1: (r.y0 + r.y1) / 2 + 1.4 }, 'pump', 1.6)); }
    } else if (p.kind === 'toll') {
      // booths on islands across both carriageways, lanes 4 m wide
      // islands follow the motorway's heading at the plaza; booth lanes 3.4 m wide
      const islands = [];
      const tx = M9.rb.tx[iToll], ty = M9.rb.ty[iToll], nx = -ty, ny = tx;
      const cx = M9.rb.x[iToll], cy = M9.rb.y[iToll];
      for (const dir of [1, -1]) for (let k = 0; k < 5; k++) {
        const off = dir * (2.6 + k * 5.0);
        islands.push({ x: cx + nx * off, y: cy + ny * off, tx, ty, hl: 10, hw: 0.8, off });
      }
      for (const isl of islands) colliders.walls.push(...orientedWalls(isl, 'island', 1.1));
      props.toll = { rect: r, h: p.h, islands, x: cx, y: cy, tx, ty };
    } else if (p.kind === 'dhaba') {
      props.dhaba = { rect: r, h: p.h, hut: { x0: r.x0 + 8, y0: r.y0 + 6, x1: r.x0 + 26, y1: r.y0 + 18 } };
      addRectWall(props.dhaba.hut, 'building', 3.2);
    } else if (p.kind === 'view') {
      props.view = { rect: r, h: p.h };
      // railing on the valley side
      colliders.walls.push({ ax: r.x1, ay: r.y0, bx: r.x1, by: r.y1, t: 0.2, nx: -1, ny: 0, kind: 'railing', h: 1.1 });
    }
  }
  function orientedWalls(o, kind, h) {
    const nx = -o.ty, ny = o.tx;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a2, b2]) => [o.x + o.tx * o.hl * a2 + nx * o.hw * b2, o.y + o.ty * o.hl * a2 + ny * o.hw * b2]);
    const out = [];
    for (let k = 0; k < 4; k++) { const a1 = pts[k], b1 = pts[(k + 1) % 4]; const dx = b1[0] - a1[0], dy = b1[1] - a1[1], L = Math.hypot(dx, dy); out.push({ ax: a1[0], ay: a1[1], bx: b1[0], by: b1[1], t: 0.25, nx: dy / L, ny: -dx / L, kind, h, d: Math.min(3, (k % 2 ? o.hl : o.hw) * 2) }); }
    return out;
  }
  function rectWalls(r, kind, h) {
    const pts = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]], out = [];
    for (let k = 0; k < 4; k++) { const a = pts[k], b = pts[(k + 1) % 4]; const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); out.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], t: 0.25, nx: dy / L, ny: -dx / L, kind, h, d: Math.min(3, k % 2 ? r.x1 - r.x0 : r.y1 - r.y0) }); }
    return out;
  }

  // ---------------------------------------------------------------- motorway furniture: median barrier, guard rails, gantries
  {
    const rb = M9.rb, n = rb.n;
    const nearToll = (x) => Math.abs(x - 900) < 70;
    const nearJ = (x, y) => junctions.some((j) => (j.a === 'M9' || j.b === 'M9') && Math.hypot(j.x - x, j.y - y) < 40);
    let run = [];
    const flush = (arr, kind, side) => { if (arr.length > 1) props[kind].push({ pts: arr, side }); };
    for (const [kind, off, side] of [['medians', 0, 0], ['guardrails', 12.6, 1], ['guardrails', -12.6, -1]]) {
      run = [];
      for (let i = 0; i < n; i++) {
        const x = rb.x[i] - rb.ty[i] * off, y = rb.y[i] + rb.tx[i] * off;
        const skip = nearToll(rb.x[i]) || (side !== 0 && nearJ(rb.x[i], rb.y[i])) || (kind === 'medians' && false) || (side === -1 && rb.x[i] > -790 && rb.x[i] < -610) || Math.abs(x) > 2540;
        if (skip) { flush(run, kind, side); run = []; continue; }
        run.push([x, y, M9.h[i]]);
      }
      flush(run, kind, side);
    }
    // colliders for the barriers
    for (const m of props.medians) for (let k = 0; k < m.pts.length - 1; k++) colliders.walls.push({ ax: m.pts[k][0], ay: m.pts[k][1], bx: m.pts[k + 1][0], by: m.pts[k + 1][1], t: 0.32, nx: 0, ny: 0, kind: 'barrier', h: 0.85 });
    for (const g of props.guardrails) for (let k = 0; k < g.pts.length - 1; k++) {
      const a = g.pts[k], b = g.pts[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      // open toward the road: the left rail (side 1) faces right, the right rail faces left
      const s = g.side === 1 ? -1 : 1;
      colliders.walls.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], t: 0.25, nx: (-dy / L) * s, ny: (dx / L) * s, kind: 'guardrail', h: 0.75 });
    }
    // overhead sign gantries
    for (const x of [-1900, -900, 380, 1500, 2300]) {
      let bi = 0, bd = Infinity; for (let i = 0; i < n; i++) { const d = Math.abs(rb.x[i] - x); if (d < bd) { bd = d; bi = i; } }
      props.gantries.push({ x: rb.x[bi], y: rb.y[bi], tx: rb.tx[bi], ty: rb.ty[bi], h: M9.h[bi], text: x < 0 ? ['LAHORE', 'ISLAMABAD'] : ['KARACHI', 'CITY CENTRE'] });
      for (const s of [1, -1]) colliders.posts.push({ x: rb.x[bi] - rb.ty[bi] * 14.2 * s, y: rb.y[bi] + rb.tx[bi] * 14.2 * s, r: 0.35, kind: 'gantry' });
    }
    // road closed barriers where the motorway leaves the map
    for (const ex of [-2550, 2550]) {
      let bi = 0, bd = Infinity; for (let i = 0; i < n; i++) { const d = Math.abs(rb.x[i] - ex); if (d < bd) { bd = d; bi = i; } }
      props.endBarriers.push({ x: rb.x[bi], y: rb.y[bi], tx: rb.tx[bi], ty: rb.ty[bi], h: M9.h[bi] });
    }
  }
  // mountain road guard rails on the valley side
  {
    const rb = MR.rb, n = rb.n;
    for (const side of [1, -1]) {
      let run = [];
      const off = (MR.type.half + 0.7) * side;
      for (let i = 0; i < n; i++) {
        const x = rb.x[i] - rb.ty[i] * off, y = rb.y[i] + rb.tx[i] * off;
        const ox = rb.x[i] - rb.ty[i] * (MR.type.half + 9) * side, oy = rb.y[i] + rb.tx[i] * (MR.type.half + 9) * side;
        const drop = MR.h[i] - HF.heightAt(ox, oy);
        const need = drop > 2.2 && rb.y[i] > 420 && !(Math.hypot(rb.x[i] - (props.view?.rect.x0 ?? 1e9), rb.y[i] - ((props.view?.rect.y0 ?? 0) + 22)) < 40 && side === -1);
        if (!need) { if (run.length > 3) props.guardrails.push({ pts: run, side, mountain: true }); run = []; continue; }
        run.push([x, y, HF.heightAt(x, y)]);
      }
      if (run.length > 3) props.guardrails.push({ pts: run, side, mountain: true });
    }
    for (const g of props.guardrails.filter((q) => q.mountain)) for (let k = 0; k < g.pts.length - 1; k++) {
      const a = g.pts[k], b = g.pts[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      const s = g.side === 1 ? -1 : 1;
      colliders.walls.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], t: 0.25, nx: (-dy / L) * s, ny: (dx / L) * s, kind: 'guardrail', h: 0.75 });
    }
  }
  // electric poles and wires along the GT road and through the village and city
  {
    const along = (rd, off, step) => {
      const pts = [];
      for (let i = 3; i < rd.rb.n; i += step) {
        const x = rd.rb.x[i] - rd.rb.ty[i] * off, y = rd.rb.y[i] + rd.rb.tx[i] * off;
        if (junctions.some((j) => Math.hypot(j.x - x, j.y - y) < j.r + 5)) { if (pts.length > 1) props.wires.push(pts.slice()); pts.length = 0; continue; }
        pts.push([x, y, HF.heightAt(x, y)]);
        props.poles.push({ x, y, h: HF.heightAt(x, y) });
        colliders.posts.push({ x, y, r: 0.16, kind: 'pole' });
      }
      if (pts.length > 1) props.wires.push(pts);
    };
    along(byId.get('GT'), ROAD_TYPES.highway.half + 4.5, 11);
    along(byId.get('PARKW'), -(ROAD_TYPES.highway.half + 4.5), 11);
    for (const id of ['ST-NS1180', 'ST-NS1390', 'ST-NS1810', 'ST-NS2020']) along(byId.get(id), ROAD_TYPES.street.half + 2.1, 9);
  }

  // ---------------------------------------------------------------- vegetation
  const trees = [];
  {
    const onGrass = (x, y) => SM.get(x, y) === S_GRASS;
    const clear = (x, y, d) => { for (let a = 0; a < 6; a++) { const px = x + Math.cos(a * 1.047) * d, py = y + Math.sin(a * 1.047) * d; if (SM.get(px, py) !== S_GRASS) return false; } return onGrass(x, y); };
    const inPark = (x, y) => Math.abs(x) < 480 && Math.abs(y) < 350;
    const inCity = (x, y) => x > 1000 && x < 2200 && y > -2360 && y < -1240;
    const inField = (x, y) => village.fields.some((f) => { const c = Math.cos(-f.ang), s = Math.sin(-f.ang); const lx = (x - f.x) * c - (y - f.y) * s, ly = (x - f.x) * s + (y - f.y) * c; return Math.abs(lx) < f.w / 2 + 2 && Math.abs(ly) < f.d / 2 + 2; });
    const lakeD = (x, y) => Math.hypot((x - W.lake.x) / W.lake.rx, (y - W.lake.y) / W.lake.ry);
    const okSpot = (x, y, d) => !inPark(x, y) && !inCity(x, y) && clear(x, y, d) && HF.heightAt(x, y) > W.lake.level + 1.2 && Math.abs(x) < 2580 && Math.abs(y) < 2580;
    // mountain pine forest
    const pineTarget = opts.quality === 'low' ? 2600 : 6200;
    for (let k = 0; k < pineTarget * 6 && trees.length < pineTarget; k++) {
      const x = -2580 + R() * 5160, y = 380 + R() * 2200;
      const h = HF.heightAt(x, y);
      const dens = smoothstep(20, 120, h) * (0.35 + 0.65 * fbm(x / 260, y / 260, 2, 77));
      if (R() > dens) continue;
      if (!okSpot(x, y, 6)) continue;
      trees.push({ x, y, h, kind: 'pine', s: 0.75 + R() * 0.6 });
    }
    // broadleaf trees: rows along the roads (shisham and kikar), groves, the lake shore
    const rows = ['GT', 'PARKW', 'ACCESS', 'LAKE'];
    for (const id of rows) {
      const rd = byId.get(id);
      for (let i = 2; i < rd.rb.n; i += 6) for (const s of [1, -1]) {
        if (R() < 0.3) continue;
        const off = (rd.type.half + 9 + R() * 4) * s;
        const x = rd.rb.x[i] - rd.rb.ty[i] * off, y = rd.rb.y[i] + rd.rb.tx[i] * off;
        if (!okSpot(x, y, 3)) continue;
        trees.push({ x, y, h: HF.heightAt(x, y), kind: id === 'LAKE' && R() < 0.4 ? 'poplar' : 'round', s: 0.75 + R() * 0.5 });
      }
    }
    const bl = opts.quality === 'low' ? 900 : 2200;
    let placed = 0;
    for (let k = 0; k < bl * 8 && placed < bl; k++) {
      const x = -2580 + R() * 5160, y = -2580 + R() * 3200;
      const g = fbm(x / 420, y / 420, 2, 91);
      if (R() > (g - 0.42) * 3) continue;
      if (!okSpot(x, y, 5) || inField(x, y)) continue;
      const nearLake = lakeD(x, y) < 1.6;
      trees.push({ x, y, h: HF.heightAt(x, y), kind: nearLake && R() < 0.5 ? 'poplar' : R() < 0.12 ? 'palm' : 'round', s: 0.7 + R() * 0.6 });
      placed++;
    }
    // the park's own trees (inside the walls) and a belt around it
    for (const t of park.trees) trees.push({ x: t.x, y: t.y, h: 0, kind: t.kind === 'palm' ? 'palm' : t.kind, s: t.s, park: true });
    for (let k = 0; k < 1400; k++) {
      const a = R() * Math.PI * 2, rr = 1 + R() * 0.25;
      const x = Math.cos(a) * 500 * rr, y = Math.sin(a) * 375 * rr;
      if (!okSpot(x, y, 6)) continue;
      trees.push({ x, y, h: HF.heightAt(x, y), kind: R() < 0.5 ? 'poplar' : 'round', s: 0.8 + R() * 0.5 });
    }
    for (const t of trees) if (!t.park) colliders.posts.push({ x: t.x, y: t.y, r: t.kind === 'pine' ? 0.32 * t.s : 0.3 * t.s, kind: 'tree' });
  }

  // ---------------------------------------------------------------- world edge
  {
    const B = W.bounds, e = 50;
    const c = [[B.x0 + e, B.y0 + e], [B.x1 - e, B.y0 + e], [B.x1 - e, B.y1 - e], [B.x0 + e, B.y1 - e]];
    for (let k = 0; k < 4; k++) { const a = c[k], b = c[(k + 1) % 4]; const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); colliders.walls.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], t: 1, nx: -dy / L, ny: dx / L, kind: 'edge', h: 0 }); }
  }

  // ---------------------------------------------------------------- collision broadphase over the whole world
  const walls = [...park.walls, ...colliders.walls];
  const posts = [...park.posts, ...colliders.posts];
  const B = W.bounds, GC = 32;
  const gw = Math.ceil((B.x1 - B.x0) / GC), gh = Math.ceil((B.y1 - B.y0) / GC);
  const cells = Array.from({ length: gw * gh }, () => []);
  const addBox = (x0, y0, x1, y1, ref) => {
    const cx0 = Math.max(0, Math.floor((x0 - B.x0) / GC)), cy0 = Math.max(0, Math.floor((y0 - B.y0) / GC));
    const cx1 = Math.min(gw - 1, Math.floor((x1 - B.x0) / GC)), cy1 = Math.min(gh - 1, Math.floor((y1 - B.y0) / GC));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cells[cy * gw + cx].push(ref);
  };
  walls.forEach((w, i) => {
    if (w.kind === 'edge') {
      // long edge walls: register along their length only
      const L = Math.hypot(w.bx - w.ax, w.by - w.ay), n = Math.ceil(L / GC);
      for (let k = 0; k <= n; k++) { const t = k / n; const x = w.ax + (w.bx - w.ax) * t, y = w.ay + (w.by - w.ay) * t; addBox(x - 6, y - 6, x + 6, y + 6, i); }
      return;
    }
    const e = w.t + 3; addBox(Math.min(w.ax, w.bx) - e, Math.min(w.ay, w.by) - e, Math.max(w.ax, w.bx) + e, Math.max(w.ay, w.by) + e, i);
  });
  posts.forEach((p, i) => addBox(p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r, -1 - i));
  for (const c of cells) if (c.length > 1) { const u = [...new Set(c)]; c.length = 0; c.push(...u); }

  // ---------------------------------------------------------------- queries
  const lake = W.lake;
  const surfaceAt = (x, y) => {
    const id = SM.get(x, y);
    if (id) return WORLD_SURFACES[id];
    const h = HF.heightAt(x, y);
    const dl = Math.hypot((x - lake.x) / lake.rx, (y - lake.y) / lake.ry);
    if (h < lake.level - 0.25 && dl < 1.5) return WORLD_SURFACES[S_WATER];
    if (h < lake.level + 1.4 && dl < 1.7) return WORLD_SURFACES[S_SAND];
    if (y > 500) { const g = HF.gradAt(x, y, tmpS); if (g[0] * g[0] + g[1] * g[1] > 0.45) return WORLD_SURFACES[S_ROCK]; }
    return WORLD_SURFACES[S_GRASS];
  };
  const tmpG = [0, 0], tmpS = [0, 0];
  const heightAt = (x, y) => HF.heightAt(x, y);
  const gradAt = (x, y) => HF.gradAt(x, y, tmpG);
  // height the wheels sit on (raised sidewalks and kerbs)
  const groundAt = (x, y) => { const id = SM.get(x, y); return HF.heightAt(x, y) + (id === S_SIDEWALK ? 0.15 : id === S_KERB ? 0.05 : 0); };

  // spawn points: x, y, heading
  // Pakistan drives on the left: spawn in the left lane of the direction of travel
  const sp = (rd, i, back) => { const rb = rd.rb; const k = Math.min(rb.n - 2, Math.max(1, i)); const s = back ? -1 : 1; const off = rd.type.lanes ? rd.type.lanes[rd.type.lanes.length - 1] : 2; return { x: rb.x[k] - rb.ty[k] * off * s, y: rb.y[k] + rb.tx[k] * off * s, psi: Math.atan2(rb.ty[k] * s, rb.tx[k] * s) }; };
  const spawns = {
    pad: { ...park.spawns.pad, label: 'Drift pad' },
    circuit: { ...park.spawns.circuit, label: 'Race circuit' },
    city: { ...sp(byId.get('BLVD-N'), 20, false), label: 'City', psi: -Math.PI / 2 },
    motorway: { ...sp(M9, atM9(80), false), label: 'Motorway' },
    mountain: { ...sp(MR, 40, false), label: 'Murree Road' },
    village: { ...sp(GT, nearestSample(GT.rb, -1640, -600), false), label: 'Village' },
    lake: { ...sp(byId.get('LAKE'), nearestSample(byId.get('LAKE').rb, 2050, 400), false), label: 'Lake' },
  };
  spawns.city = { ...sp(byId.get('BLVD-N'), 62, false), label: 'City' };
  const t2 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    W, bounds: W.bounds, park, roads, byId, pads, junctions, HF, SM, lake, city, village, props, trees, spawns,
    walls, posts, cells, gw, gh, GC, cones: park.cones, surfaceAt, heightAt, gradAt, groundAt,
    nearestOnCircuit: park.nearestOnCircuit, circuit: park.circuit, sStart: park.sStart, iStart: park.iStart,
    timings: { terrain: t1 - t0, rest: t2 - t1 },
  };
}

// nearest road sample (for resets and the radar), searched coarsely
export function nearestRoad(world, x, y, maxD = 120) {
  let best = null, bd = maxD * maxD;
  for (const rd of world.roads) {
    const rb = rd.rb;
    for (let i = 0; i < rb.n; i += 2) {
      const d = (rb.x[i] - x) ** 2 + (rb.y[i] - y) ** 2;
      if (d < bd) { bd = d; best = { rd, i }; }
    }
  }
  return best;
}
export { CONE_R };
void vnoise; void S_GRAVEL; void Heightfield;
