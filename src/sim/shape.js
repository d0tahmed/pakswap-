// Body proportions shared by the 3D generator and the fitment analysis.
// Coordinates in metres: x forward (nose at +L/2), y up from the ground, z to the car's right.
import { parseTyre, tyreDiameter } from './vehicle.js';

export const TEMPLATES = {
  sedan: { fo: 0.5, cowl: 0.3, ws: 28, roof: 0.38, rear: 'notch', rw: 30, minDeck: 0.36, belt: 0.6, hoodRise: -0.05, hoodDrop: 0.12, tumble: 0.42, planF: 0.42, planR: 0.32, bumperUp: 0.08, deck: 0.0, pillars: 'sedan' },
  fastback: { fo: 0.5, cowl: 0.32, ws: 25, roof: 0.36, rear: 'notch', rw: 19, minDeck: 0.2, belt: 0.6, hoodRise: -0.06, hoodDrop: 0.13, tumble: 0.45, planF: 0.46, planR: 0.4, bumperUp: 0.08, deck: -0.01, pillars: 'sedan' },
  hatch: { fo: 0.56, cowl: 0.24, ws: 29, roof: 0.62, rear: 'hatch', rw: 58, belt: 0.6, hoodRise: -0.05, hoodDrop: 0.12, tumble: 0.4, planF: 0.4, planR: 0.3, bumperUp: 0.08, pillars: 'hatch' },
  hothatch: { fo: 0.56, cowl: 0.26, ws: 26, roof: 0.44, rear: 'hatch', rw: 24, belt: 0.6, hoodRise: -0.06, hoodDrop: 0.13, tumble: 0.45, planF: 0.42, planR: 0.34, bumperUp: 0.07, pillars: 'hatch' },
  kei: { fo: 0.58, cowl: 0.03, ws: 33, roof: 0.72, rear: 'hatch', rw: 74, belt: 0.55, hoodRise: -0.04, hoodDrop: 0.1, tumble: 0.3, planF: 0.3, planR: 0.24, bumperUp: 0.07, pillars: 'hatch' },
  tallboy: { fo: 0.58, cowl: -0.02, ws: 37, roof: 0.78, rear: 'hatch', rw: 80, belt: 0.5, hoodRise: -0.04, hoodDrop: 0.11, tumble: 0.24, planF: 0.3, planR: 0.22, bumperUp: 0.07, pillars: 'hatch' },
  suv: { fo: 0.5, cowl: 0.3, ws: 31, roof: 0.66, rear: 'hatch', rw: 56, belt: 0.58, hoodRise: -0.04, hoodDrop: 0.1, tumble: 0.33, planF: 0.38, planR: 0.3, bumperUp: 0.1, clad: true, pillars: 'suv' },
  bigsuv: { fo: 0.44, cowl: 0.45, ws: 33, roof: 0.74, rear: 'hatch', rw: 76, belt: 0.56, hoodRise: -0.03, hoodDrop: 0.06, tumble: 0.22, planF: 0.3, planR: 0.24, bumperUp: 0.12, clad: true, pillars: 'suv' },
  jeep: { fo: 0.42, cowl: 0.38, ws: 58, roof: 0.76, rear: 'box', rw: 86, belt: 0.55, hoodRise: -0.02, hoodDrop: 0.04, tumble: 0.1, planF: 0.16, planR: 0.14, bumperUp: 0.12, clad: true, pillars: 'jeep' },
  pickup: { fo: 0.4, cowl: 0.55, ws: 31, roof: 0.4, rear: 'bed', rw: 84, belt: 0.56, hoodRise: -0.03, hoodDrop: 0.06, tumble: 0.22, planF: 0.3, planR: 0.12, bumperUp: 0.12, clad: true, pillars: 'pickup' },
  van: { fo: 0.38, cowl: -0.5, ws: 62, roof: 0.92, rear: 'box', rw: 87, belt: 0.48, hoodRise: -0.02, hoodDrop: 0.22, tumble: 0.1, planF: 0.22, planR: 0.12, bumperUp: 0.06, pillars: 'van' },
};

// Monotone cubic interpolation (Fritsch-Carlson) through points sorted by x.
export function monotone(points) {
  const n = points.length;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] > x) hi = mid; else lo = mid; }
    const h = xs[hi] - xs[lo]; const t = (x - xs[lo]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * m[lo] + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * m[hi];
  };
}

const rad = (d) => (d * Math.PI) / 180;

export function bodyGeometry(car, opts = {}) {
  const tpl = { ...TEMPLATES[car.body] };
  const [Lmm, Wmm, Hmm, WBmm, GCmm] = car.dims;
  const L = Lmm / 1000, W = Wmm / 1000, H = Hmm / 1000, WB = WBmm / 1000, GC = GCmm / 1000;
  const boxy = car.boxy || 0;
  const t = parseTyre(car.tyre);
  const R = tyreDiameter(t) / 2000;
  const Ra = R + (tpl.clad ? 0.05 : 0.035);
  if (car.longHood) { tpl.cowl += 0.12; tpl.fo -= 0.04; }
  if (car.cabForward) { tpl.cowl -= 0.06; tpl.ws -= 2; }
  tpl.planF *= 1 - boxy * 0.45; tpl.planR *= 1 - boxy * 0.45;
  tpl.tumble *= 1 - boxy * 0.35;
  if (boxy > 0.6) tpl.ws += (boxy - 0.6) * 18;
  // per-car silhouette overrides (classic shapes the shared templates cannot express)
  if (car.shape) Object.assign(tpl, car.shape);

  const FO = tpl.fo * (L - WB);
  const xNose = L / 2, xTail = -L / 2;
  const xF = xNose - FO, xR = xF - WB;
  const zBelt = GC + tpl.belt * (H - GC);
  const zCowl = zBelt + tpl.hoodRise;
  const zHoodFront = zCowl - tpl.hoodDrop;
  const xCowl = xF - tpl.cowl * (WB / 2.6);
  const wsRun = (H - zCowl) / Math.tan(rad(tpl.ws));
  const xRoofF = xCowl - wsRun;
  let xRoofR = xRoofF - tpl.roof * WB;
  let xDeck = null, zDeck = null, xCabBack = null, zRail = null, zHatch = null;
  if (tpl.rear === 'notch') {
    zDeck = zBelt + (tpl.deck || 0);
    let rwRun = (H - zDeck) / Math.tan(rad(tpl.rw));
    xDeck = xRoofR - rwRun;
    const minX = xTail + tpl.minDeck;
    if (xDeck < minX) {
      const deficit = minX - xDeck;
      xRoofR = Math.min(xRoofF - 0.5, xRoofR + deficit * 0.6);
      rwRun = Math.max(0.35, xRoofR - minX);
      xDeck = xRoofR - rwRun;
    }
  } else if (tpl.rear === 'hatch') {
    zHatch = zBelt + 0.05;
    const run = (H - zHatch) / Math.tan(rad(tpl.rw));
    xRoofR = xTail + 0.05 + run;
  } else if (tpl.rear === 'box') {
    xRoofR = xTail + 0.05 + 0.12 / Math.tan(rad(tpl.rw));
  } else if (tpl.rear === 'bed') {
    xCabBack = xRoofR - 0.1;
    zRail = zBelt + 0.03;
  }
  const noseTop = zHoodFront - (0.09 - boxy * 0.05);

  // ---------- top line ----------
  const top = [];
  top.push([xNose, noseTop]);
  top.push([xNose - 0.05, zHoodFront - 0.022]);
  top.push([xNose - 0.17, zHoodFront]);
  if (xCowl - (xNose - 0.17) < -0.2) top.push([(xCowl + xNose - 0.17) / 2, (zCowl + zHoodFront) / 2 + 0.012]);
  top.push([xCowl, zCowl]);
  top.push([xRoofF + 0.07, H - 0.022]);
  top.push([xRoofF - 0.12, H - 0.002]);
  if (tpl.rear === 'notch') {
    top.push([xRoofR + 0.1, H - 0.008]);
    top.push([xRoofR - 0.05, H - 0.035]);
    top.push([xDeck + 0.06, zDeck + 0.025]);
    top.push([xDeck - 0.05, zDeck + 0.004]);
    if (xDeck - 0.05 - (xTail + 0.1) > 0.04) top.push([xTail + 0.1, zDeck - 0.004]);
    top.push([xTail + 0.03, zDeck - 0.03]);
    top.push([xTail, zDeck - 0.085]);
  } else if (tpl.rear === 'hatch') {
    top.push([xRoofR + 0.08, H - 0.008]);
    top.push([xRoofR - 0.04, H - 0.03]);
    top.push([xTail + 0.035, zHatch + 0.006]);
    top.push([xTail, zHatch - 0.05]);
  } else if (tpl.rear === 'box') {
    top.push([xTail + 0.08, H - 0.006]);
    top.push([xTail + 0.015, H - 0.05]);
    top.push([xTail, H - 0.13]);
  } else {
    top.push([xRoofR + 0.06, H - 0.008]);
    top.push([xRoofR - 0.03, H - 0.035]);
    top.push([xCabBack + 0.01, H - 0.12]);
    top.push([xCabBack - 0.012, zRail + 0.06]);
    top.push([xCabBack - 0.05, zRail]);
    top.push([xTail + 0.05, zRail]);
    top.push([xTail, zRail - 0.06]);
  }
  top.sort((a, b) => a[0] - b[0]);
  // remove points too close in x
  const topClean = [];
  for (const p of top) { if (!topClean.length || p[0] - topClean[topClean.length - 1][0] > 0.006) topClean.push(p); }
  const zTopFn = monotone(topClean);

  // ---------- bottom line (without arches) ----------
  const bu = tpl.bumperUp;
  const bot = [
    [xTail, GC + bu * 1.25 + 0.06],
    [xTail + 0.12, GC + bu * 1.1],
    [xR - Ra - 0.04, GC + 0.012],
    [xR + Ra + 0.1, GC],
    [xF - Ra - 0.1, GC],
    [xF + Ra + 0.04, GC + 0.01],
    [xNose - 0.12, GC + bu],
    [xNose, GC + bu + 0.06],
  ].sort((a, b) => a[0] - b[0]);
  const zBotFn = monotone(bot);

  const archs = [xF, xR];
  const archFn = (x) => {
    let z = -1;
    for (const xa of archs) {
      const dx = Math.abs(x - xa);
      if (dx <= Ra) z = Math.max(z, R + Math.sqrt(Ra * Ra - dx * dx));
    }
    return z;
  };
  const wideBump = opts.widebody ? 0.045 : 0.012 - (car.boxy || 0) * 0.005;
  const halfWidth = (x) => {
    let hw = W / 2;
    const rF = tpl.planF, rR = tpl.planR;
    if (x > xNose - rF) { const dx = x - (xNose - rF); hw = W / 2 - rF + Math.sqrt(Math.max(0, rF * rF - dx * dx)); }
    if (x < xTail + rR) { const dx = xTail + rR - x; hw = W / 2 - rR + Math.sqrt(Math.max(0, rR * rR - dx * dx)); }
    for (const xa of archs) hw += wideBump * Math.exp(-(((x - xa) / (Ra * 1.15)) ** 2));
    return hw;
  };

  return {
    tpl, L, W, H, WB, GC, R, Ra, FO, xNose, xTail, xF, xR, zBelt, zCowl, zHoodFront, xCowl, xRoofF, xRoofR,
    xDeck, zDeck, xCabBack, zRail, zHatch, noseTop, zTop: zTopFn, zBot: zBotFn, arch: archFn, hw: halfWidth,
    tyre: t,
  };
}

// Engine bay box and engine placement used by fitment analysis and the X-ray view.
export function engineBay(car, geo) {
  const g = geo || bodyGeometry(car);
  const t = g.tyre;
  if (car.mid) {
    return { len: 0.78, wid: Math.min(0.9, g.W - 2 * (t.w / 1000 + 0.14)), ht: 0.46, cx: g.xF - 0.42, floor: g.GC + 0.06, mid: true };
  }
  const front = g.xNose - 0.24;
  const back = g.xCowl - 0.06;
  const len = Math.max(0.5, front - back);
  const wid = g.W - 2 * (t.w / 1000 + 0.1);
  const cx = (front + back) / 2;
  const hoodAt = g.zTop(cx);
  const ht = hoodAt - g.GC - 0.03;
  return { len, wid, ht, cx, front, back, floor: g.GC + 0.03, hood: hoodAt };
}
