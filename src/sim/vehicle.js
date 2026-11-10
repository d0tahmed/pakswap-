// Vehicle model: mass, aero, traction, gearing and a fixed-step longitudinal simulation.
import { GEARBOXES, buildCurve, torqueAt, K_HP, NITROUS_HP } from './powertrain.js';

const G = 9.81;
const RHO = 1.2;

export function parseTyre(s) {
  const m = /(\d+)\/(\d+)R(\d+)/.exec(s);
  if (!m) return { w: 185, a: 65, d: 15 };
  return { w: +m[1], a: +m[2], d: +m[3] };
}

export function tyreDiameter(t) { return t.d * 25.4 + 2 * t.w * (t.a / 100); }

export const BODY_CD = { kei: 0.4, tallboy: 0.41, hatch: 0.34, hothatch: 0.33, sedan: 0.31, fastback: 0.29, suv: 0.36, bigsuv: 0.41, jeep: 0.5, pickup: 0.45, van: 0.43 };
const BODY_CG = { kei: 0.52, tallboy: 0.56, hatch: 0.52, hothatch: 0.49, sedan: 0.52, fastback: 0.5, suv: 0.6, bigsuv: 0.7, jeep: 0.66, pickup: 0.7, van: 0.68 };

export const TYRE_MU = { eco: 0.86, standard: 0.95, performance: 1.04, semislick: 1.18, drag: 1.3, at: 0.86 };
const TYRE_MU_LAT = { eco: 0.84, standard: 0.92, performance: 1.02, semislick: 1.16, drag: 0.95, at: 0.82 };
const TYRE_CRR = { eco: 0.0105, standard: 0.012, performance: 0.0135, semislick: 0.016, drag: 0.018, at: 0.017 };

export function engineFootprintKg(e) {
  return e.kg + (e.hyb ? e.hyb.kg : 0) + (e.ev ? e.ev.battKg : 0);
}

function nativeLayout(car) {
  // which way the engine bay is laid out
  if (car.mid) return 'mid';
  if (car.drive === 'FWD') return 'T';
  if (car.drive === 'AWD' && car.body !== 'bigsuv' && car.body !== 'jeep' && car.body !== 'pickup' && car.body !== 'fastback') return 'T';
  if (car.body === 'fastback' && car.drive === 'AWD') return 'EV';
  return 'L';
}

// Decide driven wheels and conversion work for an engine in a car.
export function resolveDrive(car, engine, cfg) {
  const bay = nativeLayout(car);
  const stockE = car.engine === engine.id;
  const notes = [];
  let drive = car.drive === '4WD' ? 'AWD' : car.drive;
  let conversion = null; // 'rwd' | 'awd' | 'fwd' | 'adapter'
  if (stockE) {
    drive = car.drive === '4WD' ? 'AWD' : car.drive;
  } else if (engine.orient === 'EV') {
    if (engine.ev && engine.ev.awd) { drive = 'AWD'; if (car.drive !== 'AWD' && car.drive !== '4WD') conversion = 'awd'; }
    else drive = car.drive === '4WD' || car.drive === 'AWD' ? (bay === 'T' ? 'FWD' : 'RWD') : car.drive;
  } else if (engine.orient === 'BIKE') {
    drive = 'RWD'; if (car.drive === 'FWD') conversion = 'rwd';
  } else if (engine.orient === 'L') {
    if (bay === 'T') { drive = 'RWD'; conversion = 'rwd'; }
    else drive = car.drive === '4WD' || car.drive === 'AWD' ? 'AWD' : 'RWD';
  } else if (engine.orient === 'T') {
    if (bay === 'T') drive = car.drive === 'AWD' ? 'AWD' : 'FWD';
    else if (bay === 'mid') drive = 'RWD';
    else { drive = car.drive === '4WD' || car.drive === 'AWD' ? 'AWD' : 'RWD'; conversion = 'adapter'; }
  } else { // TL
    if (bay === 'T') drive = car.drive === 'AWD' ? 'AWD' : 'FWD';
    else drive = car.drive === '4WD' || car.drive === 'AWD' ? 'AWD' : 'RWD';
  }
  const want = cfg.drive && cfg.drive !== 'auto' ? cfg.drive : null;
  if (want && want !== drive) {
    if (want === 'AWD') conversion = 'awd';
    else if (want === 'RWD') conversion = drive === 'FWD' || bay === 'T' ? 'rwd' : conversion;
    else if (want === 'FWD') conversion = engine.orient === 'L' || engine.orient === 'BIKE' || bay !== 'T' ? 'fwd' : conversion;
    drive = want;
  }
  return { drive, conversion, bay, notes };
}

export function resolveGearbox(car, engine, cfg) {
  if (engine.fuel === 'electric') return 'EV1';
  if (engine.orient === 'BIKE') return 'SEQ6';
  if (cfg.gearbox && cfg.gearbox !== 'auto') {
    if (cfg.gearbox === 'CVT' && engine.fuel === 'hybrid') return 'eCVT';
    return cfg.gearbox;
  }
  if (car.engine === engine.id) return car.trans;
  return engine.gb || 'MT5';
}

// Physics-relevant vehicle description for a car + engine + config.
export function deriveVehicle(car, engine, cfg, engineById) {
  const stockE = engineById[car.engine];
  const tune = car.engine === engine.id ? car.tune : null;
  const curve = buildCurve(engine, tune, cfg);
  const [L, W, H, WB, GC] = car.dims;
  const t0 = parseTyre(car.tyre);
  const D0 = tyreDiameter(t0);
  const w = t0.w + [0, 10, 20, 40][cfg.tyreWidth || 0];
  const rim = cfg.rimSize || t0.d;
  let side = (D0 - rim * 25.4) / 2;
  const minSide = w * 0.25;
  if (side < minSide) side = minSide;
  let D = rim * 25.4 + 2 * side;
  if (cfg.tyres === 'at') D *= 1.035;
  const r = D / 2000;
  const aspect = Math.round((side / w) * 100);

  const dr = resolveDrive(car, engine, cfg);
  const gbId = resolveGearbox(car, engine, cfg);
  const gb = GEARBOXES[gbId] || GEARBOXES.MT5;

  // ---------------- mass ----------------
  const base = car.kerb + 75;
  const parts = [];
  const add = (label, kg, front) => { if (Math.abs(kg) > 0.01) parts.push({ label, kg, front }); };
  const engineFront = car.mid ? 0.55 : (engine.orient === 'L' && nativeLayout(car) === 'T') ? 0.85 : 0.95;
  if (engine.id !== car.engine) {
    const stockIce = stockE.fuel !== 'electric';
    const newIce = engine.fuel !== 'electric';
    add('Engine swap', engine.kg - stockE.kg, engineFront);
    if (engine.hyb || stockE.hyb) add('Hybrid system', (engine.hyb ? engine.hyb.kg : 0) - (stockE.hyb ? stockE.hyb.kg : 0), 0.3);
    if (engine.ev || stockE.ev) add('Battery pack', (engine.ev ? engine.ev.battKg : 0) - (stockE.ev ? stockE.ev.battKg : 0), 0.48);
    if (stockIce && !newIce) add('Fuel tank and exhaust removed', -32, 0.25);
    if (!stockIce && newIce) add('Fuel tank, exhaust, radiator', 38, 0.55);
    if (engine.fuel === 'diesel' && stockE.fuel !== 'diesel') add('Diesel fuel system', 8, 0.5);
  }
  if (dr.conversion === 'rwd') add('RWD conversion (diff, propshaft)', 48, 0.25);
  if (dr.conversion === 'awd') add('AWD conversion', 85, 0.5);
  if (dr.conversion === 'adapter') add('Adapter and custom mounts', 15, 0.8);
  if (dr.conversion === 'fwd') add('Transaxle adapter', 25, 0.9);
  const fiKg = { none: 0, turbo: 18, bigturbo: 26, sc: 21 }[cfg.fi || 'none'];
  if (engine.fuel !== 'electric') add('Forced induction kit', fiKg, 1.1);
  if (cfg.exhaust === 'sport') add('Sport exhaust', -4, 0.2);
  if (cfg.exhaust === 'straight') add('Straight pipe', -9, 0.2);
  if (cfg.nitrous && cfg.nitrous !== 'none' && engine.fuel !== 'electric') add('Nitrous bottle', 12, -0.15);
  if (cfg.fuelsys === 'cng' && engine.fuel === 'petrol') add('CNG cylinder', Math.max(40, Math.min(80, car.kerb * 0.06)), -0.2);
  if (cfg.fuelsys === 'lpg' && engine.fuel === 'petrol') add('LPG tank', 38, -0.15);
  add('Brakes', { stock: 0, pads: 0, bbk: 6, ceramic: -10 }[cfg.brakes || 'stock'], 0.55);
  add('Suspension', { stock: 0, springs: 0, coilovers: 2, air: 18, lift: 24 }[cfg.suspension || 'stock'], 0.5);
  const wr = { stock: 0, light: -15, seats: -42, strip: -Math.round(car.kerb * 0.085), carbon: -Math.round(car.kerb * 0.13) }[cfg.weight || 'stock'];
  add('Weight reduction', wr, 0.45);
  // wheels
  const rimKg = (d, steel) => Math.max(4.2, 0.42 * d - 0.6) + (steel ? 1.5 : 0);
  const tyreKg = (wd, dia) => 0.065 * wd * (dia / 1000) * (cfg.tyres === 'at' ? 1.25 : 1);
  const stockWheel = rimKg(t0.d, car.era === 'classic') + tyreKg(t0.w, D0);
  const newWheel = rimKg(rim, cfg.rimStyle === 'stock' && car.era === 'classic') + tyreKg(w, D) + (cfg.rimStyle === 'offroad' ? 1.5 : 0) + (cfg.rimStyle === 'dish' ? 0.8 : 0);
  add('Wheels and tyres', 4 * (newWheel - stockWheel), 0.5);
  const aero = (cfg.lip ? 3 : 0) + (cfg.skirts ? 5 : 0) + (cfg.diffuser ? 4 : 0) + (cfg.bullbar ? 22 : 0) + (cfg.towhook ? 0.5 : 0);
  add('Front aero and bars', (cfg.lip ? 3 : 0) + (cfg.bullbar ? 22 : 0), 1.2);
  add('Side skirts and diffuser', (cfg.skirts ? 5 : 0) + (cfg.diffuser ? 4 : 0), 0.4);
  add('Spoiler', { none: 0, lip: 1.5, ducktail: 3, roof: 2.5, wing: 7 }[cfg.spoiler || 'none'], -0.15);
  add('Hood', { stock: 0, vented: 0, scoop: 3, carbon: -8 }[cfg.hood || 'stock'], 1.0);
  add('Roof accessories', { none: 0, rack: 9, box: 20, lightbar: 6, luggage: 60 }[cfg.roofAcc || 'none'], 0.5);
  if (cfg.widebody) add('Widebody flares', 12, 0.5);
  if (cfg.snorkel) add('Snorkel', 4, 0.9);
  if (cfg.mudflaps) add('Mud flaps', 2, 0.5);
  if (cfg.cage) add('Roll cage', 32, 0.45);
  add('Cooling', { stock: 0, radiator: 3, full: 6 }[cfg.cooling || 'stock'], 1.1);
  void aero;

  const delta = parts.reduce((s, p) => s + p.kg, 0);
  const m = base + delta;

  // weight distribution
  let wf0;
  if (car.mid) wf0 = 0.47;
  else if (stockE.fuel === 'electric') wf0 = car.drive === 'FWD' ? 0.53 : 0.49;
  else if (car.drive === 'FWD' || (car.drive === 'AWD' && nativeLayout(car) === 'T')) wf0 = car.body === 'kei' || car.body === 'tallboy' ? 0.62 : 0.61;
  else if (car.body === 'bigsuv' || car.body === 'pickup' || car.body === 'jeep') wf0 = 0.56;
  else wf0 = 0.53;
  let mf = base * wf0;
  for (const p of parts) mf += p.kg * p.front;
  const wf = Math.min(0.75, Math.max(0.3, mf / m));

  // CG height
  let h = BODY_CG[car.body] * (H / 1500) * 0.92 + 0.04;
  h += (rideOffset(cfg) / 1000) * 0.9;
  if (engine.fuel === 'electric' && stockE.fuel !== 'electric') h -= 0.03;
  if (cfg.roofAcc === 'box' || cfg.roofAcc === 'luggage') h += 0.02;
  h = Math.max(0.35, h);

  // aero
  let Cd = BODY_CD[car.body] + (car.boxy || 0) * 0.06;
  Cd += { none: 0, lip: -0.005, ducktail: -0.003, roof: -0.004, wing: 0.035 }[cfg.spoiler || 'none'];
  if (cfg.lip) Cd -= 0.006;
  if (cfg.diffuser) Cd -= 0.004;
  if (cfg.widebody) Cd += 0.02;
  if (cfg.bullbar) Cd += 0.03;
  if (cfg.snorkel) Cd += 0.008;
  if (cfg.mudflaps) Cd += 0.004;
  Cd += { none: 0, rack: 0.03, box: 0.05, lightbar: 0.025, luggage: 0.11 }[cfg.roofAcc || 'none'];
  if (cfg.tyreWidth) Cd += 0.004 * cfg.tyreWidth;
  const ro = rideOffset(cfg);
  Cd += ro > 0 ? ro * 0.0004 : ro * 0.00012;
  let A = 0.85 * (W / 1000) * (H / 1000);
  if (cfg.roofAcc === 'box' || cfg.roofAcc === 'luggage') A += 0.12;
  if (car.body === 'pickup') A += 0.08;
  const CdA = Cd * A;

  const mu = TYRE_MU[cfg.tyres || 'standard'] * (1 + 0.0035 * (w - t0.w) / 10);
  const muLat = TYRE_MU_LAT[cfg.tyres || 'standard'] * (1 + 0.004 * (w - t0.w) / 10);
  const crr = TYRE_CRR[cfg.tyres || 'standard'] * (1 + 0.002 * (w - t0.w) / 10);

  const effDrive = { FWD: 1, RWD: 0.985, AWD: 0.95 }[dr.drive];
  const eff = gb.eff * effDrive;

  const veh = {
    car, engine, cfg, curve, gbId, gb, drive: dr.drive, conversion: dr.conversion, bay: dr.bay,
    m, kerbBuild: m - 75, wf, h, WB: WB / 1000, Cd, A, CdA, mu, muLat, crr, r, D, rim, tyreW: w, aspect, side,
    eff, parts, ride: ro,
    lsd: cfg.lsd || 'open',
  };

  // gearing
  const vt = dragLimitedSpeed(veh, curve.peakHp * 745.7 * eff);
  let vLimit = Infinity;
  if (engine.fuel === 'electric') {
    vLimit = (car.engine === engine.id ? car.vmax : null) || ({ 'ev-kit': 150, 'byd-150': 160, 'byd-390': 220, 'ev-plaid': 280 }[engine.id] || 180);
    vLimit /= 3.6;
  }
  veh.vLimit = vLimit;
  const gearMul = { short: 1.14, balanced: 1, tall: 0.87 }[cfg.gearing || 'balanced'];
  const vTarget = Math.min(vt, vLimit * 1.02);
  if (gb.kind === 'cvt') {
    const rpmAt = curve.rpmAtHp * 1.04;
    veh.fd = ((rpmAt * Math.PI) / 30 * r) / (vTarget * gb.range[1]) * gearMul;
  } else if (gb.kind === 'ev') {
    veh.fd = ((curve.maxRpm * 0.96 * Math.PI) / 30 * r) / Math.max(vLimit, 20) * gearMul;
  } else {
    // top gear is an overdrive: at redline it would run past the drag-limited top speed
    const top = gb.ratios[gb.ratios.length - 1];
    const od = gb.kind === 'seq' ? 1.04 : gb.ratios.length >= 8 ? 1.32 : gb.ratios.length >= 6 ? 1.22 : gb.ratios.length === 4 ? 1.1 : 1.16;
    veh.fd = ((curve.redline * Math.PI) / 30 * r) / (vTarget * od * top) * gearMul;
  }
  // engine inertia for free revving
  veh.inertia = engine.fuel === 'electric' ? 0.05 : engine.orient === 'BIKE' ? 0.035 : engine.layout === 'R2' ? 0.07 : 0.035 + engine.cc * 0.00004;
  return veh;
}

export function rideOffset(cfg) {
  const s = cfg.suspension || 'stock';
  let o = { stock: 0, springs: -35, coilovers: -50, air: -40, lift: 50 }[s];
  if ((s === 'coilovers' || s === 'air' || s === 'lift') && typeof cfg.rideHeight === 'number' && cfg.rideHeight !== 0) o = cfg.rideHeight;
  return o;
}

function dragLimitedSpeed(veh, Pw) {
  let lo = 5, hi = 200;
  for (let i = 0; i < 60; i++) {
    const v = (lo + hi) / 2;
    const P = (0.5 * RHO * veh.CdA * v * v + veh.crr * veh.m * G) * v;
    if (P > Pw) hi = v; else lo = v;
  }
  return lo;
}

function smooth(a, b, x) { if (x <= a) return 0; if (x >= b) return 1; const t = (x - a) / (b - a); return t * t * (3 - 2 * t); }

export function ratioCount(veh) { return veh.gb.ratios ? veh.gb.ratios.length : 1; }

// Engine force at the wheels for a geared box at speed v in gear g (no traction limit).
function gearForce(veh, g, v, boost, nos) {
  const ratio = veh.gb.ratios[g] * veh.fd;
  const rpm = (v / veh.r) * ratio * 30 / Math.PI;
  if (rpm > veh.curve.redline + 50) return { F: 0, rpm };
  const T = torqueAt(veh.curve, Math.max(rpm, veh.curve.idle || 0), nos) * boost;
  return { F: (T * ratio * veh.eff) / veh.r, rpm };
}

function launchRpm(veh) {
  const c = veh.curve;
  if (c.ev) return 0;
  if (veh.engine.fuel === 'diesel') return Math.min(c.redline * 0.6, 2200);
  if (veh.engine.orient === 'BIKE') return 6500;
  return Math.min(c.redline * 0.72, Math.max(c.rpmAtNm + 300, 3000));
}

// Fixed-step acceleration run from standstill at full throttle.
export function simulate(veh, opts = {}) {
  const dt = opts.dt || 0.004;
  const tMax = opts.tMax || 70;
  const rec = opts.record !== false;
  const recEvery = opts.recEvery || 0.02;
  const c = veh.curve;
  const gb = veh.gb;
  const bm = c.boost;
  const nosOn = c.nosHp > 0;
  const m = veh.m;
  const Wb = veh.WB;
  const lsdK = veh.drive === 'AWD' ? 0.98 : { open: 0.9, helical: 0.95, clutch: 0.985 }[veh.lsd];
  let t = 0, v = 0, x = 0, a = 0, gear = 0, shiftT = 0, nextGear = 0;
  let boost = bm.kind === 'turbo' || bm.kind === 'twin' ? 0.15 : 1;
  const lr = launchRpm(veh);
  const out = { t: [], v: [], x: [], rpm: [], gear: [], slip: [], shift: [], boost: [] };
  const marks = {};
  let lastRec = -1;
  let rpm = lr;
  let vmaxSeen = 0;
  let stall = 0;
  const geared = gb.kind !== 'cvt' && gb.kind !== 'ev';
  const nG = geared ? gb.ratios.length : 1;
  while (t < tMax) {
    let Fe = 0; let slip = false; let shifting = shiftT > 0;
    // boost dynamics
    if (bm.kind === 'turbo' || bm.kind === 'twin') {
      const target = shifting && gb.shiftT === 0 ? 0.2 : 1;
      boost += ((target - boost) / (shifting ? 0.25 : bm.tau)) * dt;
    }
    const boostMul = bm.kind === 'turbo' || bm.kind === 'twin' ? 1 - bm.frac * (1 - boost) * smooth(bm.from * 0.6, bm.to, rpm) : 1;
    if (gb.kind === 'ev') {
      const ratio = veh.fd;
      rpm = (v / veh.r) * ratio * 30 / Math.PI;
      const T = torqueAt(c, rpm);
      Fe = (T * ratio * veh.eff) / veh.r;
      if (v >= veh.vLimit) Fe = Math.min(Fe, 0.5 * RHO * veh.CdA * v * v + veh.crr * m * G);
    } else if (gb.kind === 'cvt') {
      const [rMax, rMin] = gb.range;
      const wheelRpm = (v / veh.r) * 30 / Math.PI;
      const target = c.rpmAtHp * 0.98;
      const stallRpm = Math.min(target, Math.max(2600, c.rpmAtNm * 0.8));
      let er = wheelRpm * rMax * veh.fd;
      let mult = 1;
      if (er < stallRpm) { mult = gb.converter ? 1 + 0.9 * (1 - er / stallRpm) : 1; er = stallRpm; }
      if (er > target) er = Math.max(target, Math.min(wheelRpm * rMin * veh.fd, c.redline));
      if (wheelRpm * rMin * veh.fd > target) er = Math.min(wheelRpm * rMin * veh.fd, c.redline);
      rpm = er;
      const ratio = Math.max(rMin, Math.min(rMax, er / Math.max(wheelRpm * veh.fd, 1))) * veh.fd;
      const T = torqueAt(c, rpm, nosOn) * boostMul;
      Fe = (T * Math.min(ratio, rMax * veh.fd) * mult * veh.eff) / veh.r;
      if (veh.engine.hyb && v < 8) Fe += ((veh.engine.hyb.mnm * 2.2) / veh.r) * (1 - v / 8) * 0.6;
      if (rpm >= c.redline && Fe > 0) Fe *= 0.2;
    } else {
      const ratio = gb.ratios[gear] * veh.fd;
      const wheelRpm = (v / veh.r) * ratio * 30 / Math.PI;
      let mult = 1;
      if (shifting) {
        // revs fall towards the next gear
        const target = (v / veh.r) * gb.ratios[nextGear] * veh.fd * 30 / Math.PI;
        rpm += (target - rpm) * Math.min(1, dt / Math.max(0.03, shiftT));
        const T = torqueAt(c, Math.max(rpm, 900), nosOn) * boostMul * gb.shiftT;
        Fe = (T * gb.ratios[nextGear] * veh.fd * veh.eff) / veh.r;
        shiftT -= dt;
        if (shiftT <= 0) { gear = nextGear; shiftT = 0; }
      } else {
        if (gear === 0 && wheelRpm < lr && !c.ev) {
          rpm = gb.converter ? Math.max(wheelRpm, Math.min(lr, 2400)) : lr;
          if (gb.converter) mult = 1 + 0.85 * Math.max(0, 1 - wheelRpm / rpm);
        } else rpm = Math.max(wheelRpm, c.idle || 0);
        if (rpm >= c.redline) {
          if (gear < nG - 1) { nextGear = gear + 1; shiftT = gb.shift; }
          Fe = 0; // limiter
        } else {
          const T = torqueAt(c, rpm, nosOn) * boostMul * mult;
          Fe = (T * ratio * veh.eff) / veh.r;
          // early shift when the next gear pulls harder
          if (gear < nG - 1 && rpm > c.rpmAtHp * 0.92) {
            const nx = gearForce(veh, gear + 1, v, boostMul, nosOn);
            if (nx.F >= Fe * 0.995) { nextGear = gear + 1; shiftT = gb.shift; }
          }
        }
      }
    }
    // traction
    const Nf = m * G * veh.wf - (m * a * veh.h) / Wb;
    const Nr = m * G * (1 - veh.wf) + (m * a * veh.h) / Wb;
    const Nd = veh.drive === 'FWD' ? Nf : veh.drive === 'RWD' ? Nr : m * G;
    const Ftr = veh.mu * Math.max(0, Nd) * lsdK;
    let F = Fe;
    if (F > Ftr) { F = Ftr * 0.96; slip = true; }
    const Fres = 0.5 * RHO * veh.CdA * v * v + veh.crr * m * G * (v > 0.1 ? 1 : 0);
    let inert;
    if (slip) inert = 1.04;
    else if (gb.kind === 'ev') inert = 1.06;
    else {
      const ratioNow = geared ? gb.ratios[gear] * veh.fd : Math.min(gb.range[0], Math.max(gb.range[1], rpm / Math.max(1, (v / veh.r) * 30 / Math.PI * veh.fd))) * veh.fd;
      inert = Math.min(1.4, 1.035 + 0.0022 * ratioNow * ratioNow);
    }
    a = (F - Fres) / (m * inert);
    if (v <= 0 && a < 0) a = 0;
    v += a * dt; x += v * dt; t += dt;
    if (v > vmaxSeen + 0.01) { vmaxSeen = v; stall = 0; } else stall += dt;
    const kmh = v * 3.6;
    if (!marks.t60 && kmh >= 60) marks.t60 = t;
    if (!marks.t100 && kmh >= 100) marks.t100 = t;
    if (!marks.t150 && kmh >= 150) marks.t150 = t;
    if (!marks.t200 && kmh >= 200) marks.t200 = t;
    if (!marks.tQ && x >= 402.336) { marks.tQ = t; marks.vQ = kmh; }
    if (!marks.tK && x >= 1000) { marks.tK = t; marks.vK = kmh; }
    if (rec && t - lastRec >= recEvery) {
      lastRec = t;
      out.t.push(t); out.v.push(v); out.x.push(x); out.rpm.push(rpm); out.gear.push(geared ? (shiftT > 0 ? nextGear : gear) + 1 : 1);
      out.slip.push(slip ? 1 : 0); out.shift.push(shiftT > 0 ? 1 : 0); out.boost.push(boost);
    }
    if (opts.stopAtK && marks.tK && marks.t100) break;
    if (stall > 6 && t > 15) break;
  }
  return { ...out, marks, vmax: vmaxSeen };
}

// Steady-state top speed: highest speed where tractive force still meets resistance.
export function topSpeed(veh) {
  const c = veh.curve;
  const gb = veh.gb;
  let best = 0;
  const res = (v) => 0.5 * RHO * veh.CdA * v * v + veh.crr * veh.m * G;
  if (gb.kind === 'ev') {
    for (let v = 5; v < 150; v += 0.25) {
      const rpm = (v / veh.r) * veh.fd * 30 / Math.PI;
      if (rpm > c.maxRpm) break;
      const F = (torqueAt(c, rpm) * veh.fd * veh.eff) / veh.r;
      if (F >= res(v)) best = v;
    }
    return Math.min(best, veh.vLimit);
  }
  if (gb.kind === 'cvt') {
    const [, rMin] = gb.range;
    for (let v = 5; v < 150; v += 0.25) {
      const wheelRpm = (v / veh.r) * 30 / Math.PI;
      let rpm = Math.max(c.rpmAtHp, wheelRpm * rMin * veh.fd);
      if (rpm > c.redline) break;
      const ratio = rpm / (wheelRpm * veh.fd) * veh.fd;
      const F = (torqueAt(c, rpm) * Math.max(ratio, rMin * veh.fd) * veh.eff) / veh.r;
      if (F >= res(v)) best = v;
    }
    return best;
  }
  for (let g = 0; g < gb.ratios.length; g++) {
    for (let v = 3; v < 150; v += 0.25) {
      const { F, rpm } = gearForce(veh, g, v, 1, false);
      if (rpm > c.redline) break;
      if (F >= res(v) && v > best) best = v;
    }
  }
  return best;
}

export function brakingDistance(veh, stockMass) {
  const b = { stock: 0.95, pads: 1.0, bbk: 1.06, ceramic: 1.1 }[veh.cfg.brakes || 'stock'];
  let eff = b;
  if (veh.car.era === 'classic' && ['suzuki-fx', 'suzuki-mehran', 'suzuki-khyber', 'suzuki-margalla', 'suzuki-bolan', 'suzuki-potohar', 'daihatsu-cuore', 'suzuki-cultus-old'].includes(veh.car.id)) eff *= 0.9;
  if ((veh.cfg.brakes || 'stock') === 'stock' && veh.m > stockMass) eff *= Math.pow(stockMass / veh.m, 0.45);
  if (veh.cfg.brakes === 'pads' && veh.m > stockMass * 1.1) eff *= Math.pow((stockMass * 1.1) / veh.m, 0.3);
  const mu = veh.mu * (veh.cfg.tyres === 'drag' ? 0.82 : 1);
  const v = 100 / 3.6;
  return (v * v) / (2 * G * mu * eff) + 1.2;
}

export function lateralG(veh) {
  const s = { stock: 0.86, springs: 0.9, coilovers: 0.95, air: 0.89, lift: 0.8 }[veh.cfg.suspension || 'stock'];
  let g = veh.muLat * s;
  g *= 1 - Math.max(0, veh.h - 0.5) * 0.35;
  const imb = Math.abs(veh.wf - 0.52);
  g *= 1 - Math.max(0, imb - 0.06) * 0.35;
  if (veh.cfg.spoiler === 'wing') g += 0.02;
  if (veh.cfg.widebody) g += 0.02;
  if (veh.cfg.cage) g += 0.01;
  if (veh.lsd !== 'open') g += 0.01;
  return Math.max(0.55, Math.min(1.35, g));
}

export function powerAtWheelsNow(veh) { return veh.curve.peakHp * veh.eff; }
export { K_HP, NITROUS_HP };
