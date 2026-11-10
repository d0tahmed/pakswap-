// Torque curve synthesis and modification effects.
// Curves are built from published peak figures with piecewise cubic Hermite segments,
// then sampled into a lookup table (Nm at the crank, wide-open throttle).

export const K_HP = 7120.8; // torque[Nm] = hp * K_HP / rpm
export const TABLE_STEP = 25;

function hermite(x0, y0, m0, x1, y1, m1, x) {
  const h = x1 - x0;
  const t = (x - x0) / h;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1;
}

// Knot = { r, t, si, so } (rpm, torque, slope in, slope out)
function evalKnots(k, rpm) {
  if (rpm <= k[0].r) {
    const a = k[0];
    return Math.max(0, a.t + (rpm - a.r) * a.so * 0.6);
  }
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i], b = k[i + 1];
    if (rpm <= b.r) return hermite(a.r, a.t, a.so, b.r, b.t, b.si, rpm);
  }
  const z = k[k.length - 1];
  return Math.max(0, z.t + (rpm - z.r) * z.si);
}

function clampMonotone(y0, y1, h, m0, m1) {
  // Fritsch-Carlson limiter so no segment overshoots its end values.
  const d = (y1 - y0) / h;
  if (Math.abs(d) < 1e-9) return [0, 0];
  let a = m0 / d, b = m1 / d;
  if (a < 0) a = 0; if (b < 0) b = 0;
  const s = a * a + b * b;
  if (s > 9) { const tau = 3 / Math.sqrt(s); a *= tau; b *= tau; }
  return [a * d, b * d];
}

export function iceKnots(spec) {
  const { hp, nm, rpmP, rpmT, redline } = spec;
  const idle = spec.idle || 800;
  const turbo = spec.asp === 'T' || spec.asp === 'TT' || spec.turbo;
  const diesel = spec.fuel === 'diesel';
  const r0 = Math.max(400, Math.min(idle * 0.6, rpmT * 0.4));
  const a0 = turbo ? (diesel ? 0.42 : 0.5) : (diesel ? 0.6 : 0.62);
  const T0 = nm * a0;
  let TP = (hp * K_HP) / rpmP;
  let pe = spec.rpmT2 && spec.rpmT2 > rpmT ? spec.rpmT2 : rpmT;
  if (TP > nm * 0.995) {
    TP = nm * 0.995;
    pe = Math.min(pe, rpmT + (rpmP - rpmT) * 0.7);
  }
  if (pe >= rpmP) pe = rpmP - Math.max(150, (rpmP - rpmT) * 0.25);
  if (pe < rpmT) pe = rpmT;

  const knots = [];
  knots.push({ r: r0, t: T0, si: 0, so: 0 });
  knots.push({ r: rpmT, t: nm, si: 0, so: 0 });
  if (pe > rpmT + 1) knots.push({ r: pe, t: nm, si: 0, so: 0 });
  knots.push({ r: rpmP, t: TP, si: -TP / rpmP, so: -1.6 * TP / rpmP });
  const over = Math.max(0, (redline - rpmP) / rpmP);
  const PR = hp * Math.max(0.7, 1 - 1.4 * over * over);
  let TR = (PR * K_HP) / redline;
  if (TR > TP * 0.985) TR = TP * 0.985;
  if (redline > rpmP + 50) {
    knots.push({ r: redline, t: TR, si: -2.2 * TR / redline, so: -2.6 * TR / redline });
    knots.push({ r: redline + 600, t: TR * 0.78, si: -2.8 * TR / redline, so: -2.8 * TR / redline });
  } else {
    knots[knots.length - 1].so = -2.4 * TP / rpmP;
    knots.push({ r: rpmP + 600, t: TP * 0.8, si: -2.6 * TP / rpmP, so: -2.6 * TP / rpmP });
  }
  // rising segment slope and monotone limiting
  knots[0].so = ((nm - T0) / (rpmT - r0)) * 1.3;
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i], b = knots[i + 1];
    const [m0, m1] = clampMonotone(a.t, b.t, b.r - a.r, a.so, b.si);
    a.so = m0; b.si = m1;
  }
  return knots;
}

// Spool behaviour per aspiration, used both for the curve shape and the time simulation.
export function boostModel(engine, cfg) {
  const turboStock = engine.asp === 'T' || engine.asp === 'TT' || engine.turbo;
  const fi = cfg.fi || 'none';
  if (engine.fuel === 'electric') return { kind: 'none' };
  if (turboStock) {
    const rT = engine.rpmT;
    if (fi === 'turbo') return { kind: 'turbo', gainTop: 0.22, from: rT * 0.6, to: rT * 1.15, tau: 0.38, frac: 0.45, upgrade: 'hybrid' };
    if (fi === 'bigturbo') return { kind: 'turbo', gainTop: 0.55, from: rT * 0.9, to: rT * 1.65, tau: 0.75, frac: 0.55, low: 0.9, upgrade: 'big' };
    if (fi === 'sc') return { kind: 'twin', gainTop: 0.18, from: 900, to: 2500, tau: 0.3, frac: 0.42 };
    return { kind: 'turbo', gainTop: 0, from: rT * 0.55, to: rT * 0.98, tau: engine.asp === 'TT' ? 0.32 : 0.36, frac: engine.fuel === 'diesel' ? 0.5 : 0.42 };
  }
  if (fi === 'turbo') return { kind: 'turbo', gainTop: 0.45, from: 1900, to: 3700, tau: 0.45, frac: 0.31, kit: true };
  if (fi === 'bigturbo') return { kind: 'turbo', gainTop: 0.9, from: 3000, to: 5300, tau: 0.8, frac: 0.47, kit: true };
  if (fi === 'sc') return { kind: 'sc', gainTop: 0.38, from: 700, to: 2600, tau: 0.05, frac: 0.28, kit: true };
  return { kind: 'none' };
}

function smooth(a, b, x) {
  if (x <= a) return 0; if (x >= b) return 1;
  const t = (x - a) / (b - a); return t * t * (3 - 2 * t);
}

export function modMultiplier(engine, cfg) {
  const ev = engine.fuel === 'electric';
  const turbo = engine.asp === 'T' || engine.asp === 'TT' || engine.turbo || cfg.fi === 'turbo' || cfg.fi === 'bigturbo';
  const diesel = engine.fuel === 'diesel';
  let m = 1;
  if (!ev) {
    if (cfg.intake === 'cai') m *= turbo ? 1.03 : 1.02;
    if (cfg.intake === 'itb' && !turbo && engine.asp !== 'SC') m *= 1.06;
    if (cfg.exhaust === 'sport') m *= turbo ? 1.04 : 1.03;
    if (cfg.exhaust === 'straight') m *= turbo ? 1.08 : 1.06;
    const ecuNA = { stock: 0, s1: 0.05, s2: 0.09, s3: 0.16 };
    const ecuT = { stock: 0, s1: 0.18, s2: 0.3, s3: 0.45 };
    const ecuD = { stock: 0, s1: 0.2, s2: 0.32, s3: 0.42 };
    m *= 1 + (diesel && turbo ? ecuD : turbo || engine.asp === 'SC' ? ecuT : ecuNA)[cfg.ecu || 'stock'];
    if (cfg.fuelsys === 'cng' && !diesel && engine.fuel !== 'hybrid') m *= 0.88;
    if (cfg.fuelsys === 'lpg' && !diesel && engine.fuel !== 'hybrid') m *= 0.93;
  } else {
    m *= 1 + { stock: 0, s1: 0.08, s2: 0.14, s3: 0.22 }[cfg.ecu || 'stock'];
  }
  return m;
}

export const NITROUS_HP = { none: 0, n35: 35, n75: 75, n150: 150 };

// Build a lookup table for wide-open-throttle torque including modifications.
export function buildCurve(engine, tune, cfg) {
  const spec = { ...engine, ...(tune || {}) };
  const ev = engine.fuel === 'electric';
  const hybrid = engine.fuel === 'hybrid';
  let redline = spec.redline;
  if (!ev && cfg.ecu === 's3' && !(engine.fuel === 'diesel')) redline += 400;
  const maxRpm = ev ? engine.ev.maxRpm : redline + 600;
  const n = Math.ceil(maxRpm / TABLE_STEP) + 2;
  const base = new Float32Array(n);
  const tab = new Float32Array(n);
  const nos = new Float32Array(n);
  const mult = modMultiplier(engine, cfg);
  const bm = boostModel(engine, cfg);
  let knots = null;
  if (!ev) knots = iceKnots({ ...spec, redline: spec.redline });
  const evMaxRpm = ev ? engine.ev.maxRpm : 0;
  const nosHp = ev ? 0 : NITROUS_HP[cfg.nitrous || 'none'];

  for (let i = 0; i < n; i++) {
    const rpm = i * TABLE_STEP;
    let T;
    if (ev) {
      const r = Math.max(rpm, 1);
      T = Math.min(spec.nm, (spec.hp * K_HP) / r);
      if (rpm > evMaxRpm * 0.86) T *= Math.max(0, 1 - 0.45 * (rpm - evMaxRpm * 0.86) / (evMaxRpm * 0.14));
      if (rpm > evMaxRpm) T = 0;
    } else {
      // stretch the top of the curve when the limiter is raised
      let rr = rpm;
      if (redline !== spec.redline && rpm > spec.rpmP) rr = spec.rpmP + (rpm - spec.rpmP) * ((spec.redline - spec.rpmP) / (redline - spec.rpmP));
      T = Math.max(0, evalKnots(knots, rr));
      // never exceed the rated output anywhere on the curve
      if (rr > 300) T = Math.min(T, (spec.hp * K_HP) / rr);
      if (hybrid && engine.hyb) {
        const h = engine.hyb;
        const r = Math.max(rpm, 300);
        const Tm = Math.min(h.mnm, (h.mhp * K_HP) / r);
        T = Math.min(T + Tm, (h.sys * K_HP) / r);
      }
    }
    base[i] = T;
    let f = mult;
    if (bm.kind !== 'none' && bm.gainTop) {
      const s = smooth(bm.from, bm.to, rpm);
      f *= 1 + bm.gainTop * s;
      if (bm.low && rpm < bm.from) f *= bm.low;
    }
    tab[i] = T * f;
    if (nosHp > 0 && rpm > 2500) {
      const ramp = smooth(2500, 3300, rpm);
      nos[i] = ((nosHp * K_HP) / rpm) * ramp;
    }
  }
  const curve = { table: tab, base, nos, step: TABLE_STEP, maxRpm, redline: ev ? evMaxRpm : redline, idle: ev ? 0 : spec.idle, ev, hybrid, boost: bm, nosHp };
  const pk = peaks(curve, false);
  curve.peakHp = pk.hp; curve.peakNm = pk.nm; curve.rpmAtHp = pk.rpmHp; curve.rpmAtNm = pk.rpmNm;
  const pkn = nosHp ? peaks(curve, true) : pk;
  curve.peakHpNos = pkn.hp; curve.peakNmNos = pkn.nm;
  const pb = peaksOf(base, curve);
  curve.baseHp = pb.hp; curve.baseNm = pb.nm;
  return curve;
}

function peaksOf(arr, c) {
  let hp = 0, nm = 0, rpmHp = 0, rpmNm = 0;
  const lim = c.ev ? c.maxRpm : c.redline;
  for (let i = 1; i < arr.length; i++) {
    const rpm = i * c.step; if (rpm > lim) break;
    const T = arr[i]; const P = (T * rpm) / K_HP;
    if (P > hp) { hp = P; rpmHp = rpm; }
    if (T > nm) { nm = T; rpmNm = rpm; }
  }
  return { hp, nm, rpmHp, rpmNm };
}

function peaks(c, withNos) {
  if (!withNos) return peaksOf(c.table, c);
  const a = new Float32Array(c.table.length);
  for (let i = 0; i < a.length; i++) a[i] = c.table[i] + c.nos[i];
  return peaksOf(a, c);
}

export function torqueAt(curve, rpm, nos = false) {
  const x = rpm / curve.step;
  const i = Math.floor(x);
  if (i < 0) return curve.table[0];
  if (i >= curve.table.length - 1) return 0;
  const f = x - i;
  let T = curve.table[i] * (1 - f) + curve.table[i + 1] * f;
  if (nos) T += curve.nos[i] * (1 - f) + curve.nos[i + 1] * f;
  return T;
}

export function hpAt(curve, rpm, nos = false) { return (torqueAt(curve, rpm, nos) * rpm) / K_HP; }

// ---------------- Gearboxes ----------------
export const GEARBOXES = {
  MT4: { kind: 'manual', ratios: [3.58, 2.03, 1.36, 1.0], shift: 0.42, shiftT: 0, eff: 0.93, label: '4-speed manual' },
  MT5: { kind: 'manual', ratios: [3.45, 1.95, 1.33, 1.03, 0.81], shift: 0.4, shiftT: 0, eff: 0.93, label: '5-speed manual' },
  MT6: { kind: 'manual', ratios: [3.36, 2.1, 1.49, 1.16, 0.94, 0.79], shift: 0.36, shiftT: 0, eff: 0.93, label: '6-speed manual' },
  AGS5: { kind: 'manual', ratios: [3.45, 1.95, 1.33, 1.03, 0.81], shift: 0.95, shiftT: 0, eff: 0.92, label: '5-speed AGS' },
  AT4: { kind: 'auto', ratios: [2.88, 1.57, 1.0, 0.7], shift: 0.34, shiftT: 0.45, eff: 0.86, converter: true, label: '4-speed automatic' },
  AT5: { kind: 'auto', ratios: [3.54, 2.06, 1.4, 1.0, 0.71], shift: 0.32, shiftT: 0.45, eff: 0.87, converter: true, label: '5-speed automatic' },
  AT6: { kind: 'auto', ratios: [4.15, 2.37, 1.56, 1.16, 0.86, 0.69], shift: 0.28, shiftT: 0.5, eff: 0.88, converter: true, label: '6-speed automatic' },
  AT8: { kind: 'auto', ratios: [4.71, 3.14, 2.11, 1.67, 1.29, 1.0, 0.84, 0.67], shift: 0.22, shiftT: 0.55, eff: 0.89, converter: true, label: '8-speed automatic' },
  AT10: { kind: 'auto', ratios: [4.92, 3.15, 2.27, 1.86, 1.41, 1.13, 1.0, 0.85, 0.69, 0.64], shift: 0.2, shiftT: 0.55, eff: 0.89, converter: true, label: '10-speed automatic' },
  DCT6: { kind: 'dct', ratios: [3.64, 2.26, 1.52, 1.1, 0.89, 0.74], shift: 0.09, shiftT: 0.85, eff: 0.92, label: '6-speed dual clutch' },
  DCT7: { kind: 'dct', ratios: [3.83, 2.41, 1.58, 1.11, 0.85, 0.73, 0.62], shift: 0.09, shiftT: 0.85, eff: 0.92, label: '7-speed dual clutch' },
  SEQ6: { kind: 'seq', ratios: [2.62, 1.94, 1.55, 1.32, 1.18, 1.08], shift: 0.07, shiftT: 0, eff: 0.94, label: '6-speed sequential' },
  CVT: { kind: 'cvt', range: [2.63, 0.42], eff: 0.85, converter: true, label: 'CVT' },
  eCVT: { kind: 'cvt', range: [2.8, 0.45], eff: 0.88, label: 'Hybrid e-CVT' },
  EV1: { kind: 'ev', ratios: [1], eff: 0.92, label: 'Single-speed reduction' },
};
