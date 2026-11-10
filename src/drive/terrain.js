// Heightfield terrain for the open world: procedural base (plains, northern mountains, lake bowl,
// boundary hills), flattened districts, and roads carved in with smooth grades and embankments.
// Pure data (no three.js) so the physics and the tests use exactly the same surface.

export const smoothstep = (a, b, x) => { if (a === b) return x < a ? 0 : 1; let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
// 2D gradient (Perlin) noise in [-1, 1], seeded permutation tables cached per seed
const PERM = new Map();
function permFor(seed) {
  let p = PERM.get(seed);
  if (p) return p;
  const a = new Uint8Array(512), r = [];
  let s = (seed * 2654435761) >>> 0;
  for (let i = 0; i < 256; i++) r.push(i);
  for (let i = 255; i > 0; i--) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const j = s % (i + 1); [r[i], r[j]] = [r[j], r[i]]; }
  for (let i = 0; i < 512; i++) a[i] = r[i & 255];
  p = a; PERM.set(seed, p);
  return p;
}
const GX = new Float32Array(16), GY = new Float32Array(16);
for (let i = 0; i < 16; i++) { GX[i] = Math.cos((i / 16) * Math.PI * 2); GY[i] = Math.sin((i / 16) * Math.PI * 2); }
export function perlin(x, y, seed) {
  const P = permFor(seed);
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const X = ix & 255, Y = iy & 255;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const g = (h, dx, dy) => GX[h & 15] * dx + GY[h & 15] * dy;
  const aa = P[P[X] + Y], ab = P[P[X] + Y + 1], ba = P[P[X + 1] + Y], bb = P[P[X + 1] + Y + 1];
  const x1 = g(aa, fx, fy) + (g(ba, fx - 1, fy) - g(aa, fx, fy)) * u;
  const x2 = g(ab, fx, fy - 1) + (g(bb, fx - 1, fy - 1) - g(ab, fx, fy - 1)) * u;
  return (x1 + (x2 - x1) * v) * 1.414;
}
// ridged multifractal: sharp crests, smooth valleys
export function ridgedMF(x, y, oct, seed) {
  let sum = 0, amp = 0.5, w = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    let n = 1 - Math.abs(perlin(x, y, seed + o));
    n *= n; n *= w;
    w = Math.min(1, Math.max(0, n * 1.8));
    sum += n * amp; norm += amp;
    x = x * 2.02 + 19.1; y = y * 2.02 - 8.3; amp *= 0.5;
  }
  return sum / norm;
}
export function pfbm(x, y, oct, seed) {
  let s = 0, a = 0.5, t = 0;
  for (let o = 0; o < oct; o++) { s += perlin(x, y, seed + o) * a; t += a; x = x * 2.03 + 11.7; y = y * 2.03 - 7.3; a *= 0.5; }
  return s / t;
}
export function fbm(x, y, oct, seed) {
  let s = 0, a = 0.5, t = 0;
  for (let o = 0; o < oct; o++) { s += vnoise(x, y, seed + o * 17) * a; t += a; x = x * 2.03 + 11.7; y = y * 2.03 - 7.3; a *= 0.5; }
  return s / t;
}
export function ridged(x, y, oct, seed) {
  let s = 0, a = 0.5, t = 0;
  for (let o = 0; o < oct; o++) { const n = 1 - Math.abs(vnoise(x, y, seed + o * 31) * 2 - 1); s += n * n * a; t += a; x = x * 2.1 + 3.1; y = y * 2.1 + 5.7; a *= 0.5; }
  return s / t;
}

export class Heightfield {
  constructor(bounds, res) {
    this.x0 = bounds.x0; this.y0 = bounds.y0; this.res = res;
    this.nx = Math.round((bounds.x1 - bounds.x0) / res) + 1;
    this.ny = Math.round((bounds.y1 - bounds.y0) / res) + 1;
    this.h = new Float32Array(this.nx * this.ny);
  }

  heightAt(x, y) {
    const fx = (x - this.x0) / this.res, fy = (y - this.y0) / this.res;
    let i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0) i = 0; if (j < 0) j = 0; if (i > this.nx - 2) i = this.nx - 2; if (j > this.ny - 2) j = this.ny - 2;
    let tx = fx - i, ty = fy - j;
    tx = tx < 0 ? 0 : tx > 1 ? 1 : tx; ty = ty < 0 ? 0 : ty > 1 ? 1 : ty;
    const o = j * this.nx + i, H = this.h;
    const a = H[o], b = H[o + 1], c = H[o + this.nx], d = H[o + this.nx + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }

  // slope dh/dx, dh/dy (metres per metre)
  gradAt(x, y, out = [0, 0]) {
    const fx = (x - this.x0) / this.res, fy = (y - this.y0) / this.res;
    let i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0) i = 0; if (j < 0) j = 0; if (i > this.nx - 2) i = this.nx - 2; if (j > this.ny - 2) j = this.ny - 2;
    let tx = fx - i, ty = fy - j;
    tx = tx < 0 ? 0 : tx > 1 ? 1 : tx; ty = ty < 0 ? 0 : ty > 1 ? 1 : ty;
    const o = j * this.nx + i, H = this.h;
    const a = H[o], b = H[o + 1], c = H[o + this.nx], d = H[o + this.nx + 1];
    out[0] = ((b - a) + (a - b - c + d) * ty) / this.res;
    out[1] = ((c - a) + (a - b - c + d) * tx) / this.res;
    return out;
  }
}

// ---------------------------------------------------------------- the world's natural shape
// The noise-heavy shape is evaluated on an 8 m lattice and interpolated; districts are
// flattened analytically on top at full resolution.
export function makeBase(W) {
  const flats = W.flats;
  const natural = (x, y) => {
    // rolling plains
    let h = pfbm(x / 900, y / 900, 3, 1) * 15 + pfbm(x / 210, y / 210, 2, 2) * 3;
    // northern hills rising to mountains: warped ridged multifractal for crests and valleys
    const m = smoothstep(380, 2350, y);
    if (m > 0) {
      const wx = x + 160 * perlin(x / 700, y / 700, 21), wy = y + 160 * perlin(x / 700 + 5.2, y / 700 - 1.3, 22);
      const r = ridgedMF(wx / 1450, wy / 1450, 5, 3);
      const west = 0.62 + 0.38 * smoothstep(-1900, -300, x);
      h += m * (0.35 + 0.65 * m) * (90 + 360 * r) * (0.8 + 0.3 * pfbm(x / 1800, y / 1800, 2, 4)) * west + m * 14 * pfbm(x / 160, y / 160, 2, 5);
    }
    // foothills between the plain and the mountains
    h += smoothstep(-250, 700, y) * 20 * pfbm(x / 430, y / 430, 3, 33);
    // the southern plain is flatter (farmland)
    if (y < -300) h *= lerp(1, 0.35, smoothstep(-300, -1100, y));
    // lake bowl to the east of the park
    const L = W.lake;
    const dl = Math.hypot((x - L.x) / L.rx, (y - L.y) / L.ry);
    h += -L.depth * smoothstep(1.0, 0.25, dl) - 4 * smoothstep(1.35, 0.9, dl);
    // hills along the map edge keep the world closed in, with a pass where the motorway leaves
    const ex = Math.abs(x) - (W.bounds.x1 - 260), ey = Math.abs(y) - (W.bounds.y1 - 260);
    const e = Math.max(ey, ex * (W.pass ? smoothstep(W.pass.w * 0.5, W.pass.w, Math.abs(y - W.pass.y)) : 1));
    if (e > 0) h += smoothstep(0, 260, e) * (90 + 140 * ridgedMF(x / 420, y / 420, 3, 9));
    return h;
  };
  const C = 8, B = W.bounds;
  const nx = Math.round((B.x1 - B.x0) / C) + 3, ny = Math.round((B.y1 - B.y0) / C) + 3;
  const ox = B.x0 - C, oy = B.y0 - C;
  const G = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) G[j * nx + i] = natural(ox + i * C, oy + j * C);
  const nat = (x, y) => {
    const fx = (x - ox) / C, fy = (y - oy) / C;
    let i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0) i = 0; if (j < 0) j = 0; if (i > nx - 2) i = nx - 2; if (j > ny - 2) j = ny - 2;
    const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j));
    const o = j * nx + i, a = G[o], b = G[o + 1], c = G[o + nx], d = G[o + nx + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  return (x, y) => {
    let h = nat(x, y);
    // flattened districts
    for (const f of flats) {
      let d;
      if (f.r) d = Math.hypot(x - f.x, y - f.y) - f.r;
      else d = Math.max(f.x0 - x, x - f.x1, f.y0 - y, y - f.y1);
      if (d < f.blend) {
        const w = d <= 0 ? 1 : 1 - smoothstep(0, f.blend, d);
        h = lerp(h, f.h, w * (f.k ?? 1));
      }
    }
    return h;
  };
}

// Road profile: terrain under the centre line, smoothed, pinned at junctions and grade-limited.
export function profileRoad(rb, base, type, pins) {
  const n = rb.n, ds = rb.ds;
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = base(rb.x[i], rb.y[i]);
  const pinned = new Map();
  for (const p of pins) {
    pinned.set(p.i, p.h);
    // a short level stretch where a road meets another one
    const f = Math.round((p.flat || 0) / ds);
    for (let k = 1; k <= f; k++) { if (p.i - k >= 0 && p.i === n - 1) pinned.set(p.i - k, p.h); if (p.i + k < n && p.i === 0) pinned.set(p.i + k, p.h); }
  }
  const k = Math.max(1, Math.round(type.smooth / (2 * ds)));
  const tmp = new Float32Array(n);
  for (let it = 0; it < 6; it++) {
    // moving average via prefix sums
    let acc = 0;
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { acc += h[i]; pre[i + 1] = acc; }
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - k), b = Math.min(n - 1, i + k); tmp[i] = (pre[b + 1] - pre[a]) / (b - a + 1); }
    h.set(tmp);
    for (const [i, v] of pinned) {
      // spread the pin correction smoothly over the smoothing window
      const dv = v - h[i];
      const span = k * 3;
      for (let j = Math.max(0, i - span); j <= Math.min(n - 1, i + span); j++) h[j] += dv * (0.5 + 0.5 * Math.cos((Math.PI * (j - i)) / (span + 1)));
    }
  }
  // grade limit, both directions, keeping pins
  const g = type.maxGrade * ds;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < n; i++) if (!pinned.has(i)) h[i] = Math.min(h[i - 1] + g, Math.max(h[i - 1] - g, h[i]));
    for (let i = n - 2; i >= 0; i--) if (!pinned.has(i)) h[i] = Math.min(h[i + 1] + g, Math.max(h[i + 1] - g, h[i]));
  }
  for (const [i, v] of pinned) h[i] = v;
  return h;
}

// Fill the heightfield from the base shape, then carve every road into it.
export function buildHeightfield(W, base, roads) {
  const HF = new Heightfield(W.bounds, W.res);
  const { nx, ny, res, x0, y0 } = HF;
  const H = HF.h;
  for (let j = 0; j < ny; j++) { const y = y0 + j * res; for (let i = 0; i < nx; i++) H[j * nx + i] = base(x0 + i * res, y); }
  const baseH = H.slice();
  const wBest = new Float32Array(nx * ny);
  const hBest = new Float32Array(nx * ny);
  const dBest = new Float32Array(nx * ny).fill(1e9);
  for (const rd of roads) {
    const rb = rd.rb, half = rd.type.half + (rd.type.verge ?? 1.2);
    const N = rb.n, last = N - 1;
    for (let s = 0; s < last; s++) {
      const ax = rb.x[s], ay = rb.y[s], bx = rb.x[s + 1], by = rb.y[s + 1];
      const ha = rd.h[s], hb = rd.h[s + 1];
      const reach = half + 40;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / res)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + reach - x0) / res));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - y0) / res)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by) + reach - y0) / res));
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      for (let j = j0; j <= j1; j++) {
        const py = y0 + j * res;
        for (let i = i0; i <= i1; i++) {
          const px = x0 + i * res;
          let t = ((px - ax) * dx + (py - ay) * dy) / L2;
          // capsule distance: joints on the outside of bends are covered by both neighbours
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + dx * t, qy = ay + dy * t;
          const d = Math.hypot(px - qx, py - qy);
          if (d > reach) continue;
          const o = j * nx + i;
          const hr = ha + (hb - ha) * t;
          const bank = Math.min(40, Math.max(6, Math.abs(baseH[o] - hr) * 2.2 + 4));
          const w = d <= half ? 1 : 1 - smoothstep(0, bank, d - half);
          if (w <= 0) continue;
          // stronger influence wins; on road surfaces the nearest centre line wins
          if (w > wBest[o] + 1e-4 || (w >= 0.999 && wBest[o] >= 0.999 && d < dBest[o])) { wBest[o] = w; hBest[o] = hr; dBest[o] = d; }
        }
      }
    }
  }
  for (let o = 0; o < H.length; o++) if (wBest[o] > 0) H[o] = baseH[o] + (hBest[o] - baseH[o]) * wBest[o];
  HF.base = baseH;
  return HF;
}
