// Turns a car + build config into stock vs build metrics, fitment, pros and cons, and a verdict.
import { ENGINE_BY_ID, engineLayoutLabel, aspirationLabel } from '../data/engines.js';
import { defaultConfig } from '../data/parts.js';
import { deriveVehicle, simulate, topSpeed, brakingDistance, lateralG, rideOffset, parseTyre } from './vehicle.js';
import { bodyGeometry, engineBay } from './shape.js';
import { GEARBOXES } from './powertrain.js';

const cacheStock = new Map();

export function refL100(e) {
  if (!e || e.fuel === 'electric') return null;
  const D = e.cc / 1000;
  let l = 3.0 + 2.55 * D;
  if (e.asp === 'T' || e.asp === 'TT') l *= e.era === 'old' ? 1.22 : 0.93;
  if (e.asp === 'SC') l *= 1.15;
  if (e.layout === 'R2') l *= 1.7;
  if (e.rpmP > 7500 && e.orient !== 'BIKE') l *= 1.1;
  if (e.fuel === 'diesel') l *= 0.72;
  if (e.fuel === 'hybrid') l *= 0.58;
  if (e.orient === 'BIKE') l *= 0.95;
  return l;
}

function fuelModFactor(cfg) {
  let f = 1;
  f *= { stock: 1, s1: 1.02, s2: 0.97, s3: 0.9 }[cfg.ecu || 'stock'];
  f *= { none: 1, turbo: 0.92, bigturbo: 0.82, sc: 0.88 }[cfg.fi || 'none'];
  if (cfg.exhaust === 'straight') f *= 0.98;
  if (cfg.intake === 'itb') f *= 0.95;
  f *= Math.pow(0.975, cfg.tyreWidth || 0);
  if (cfg.tyres === 'at') f *= 0.94;
  if (cfg.tyres === 'semislick' || cfg.tyres === 'drag') f *= 0.95;
  f *= { none: 1, rack: 0.97, box: 0.94, lightbar: 0.98, luggage: 0.9 }[cfg.roofAcc || 'none'];
  f *= { short: 0.95, balanced: 1, tall: 1.04 }[cfg.gearing || 'balanced'];
  if (cfg.spoiler === 'wing') f *= 0.98;
  if (cfg.bullbar) f *= 0.98;
  return f;
}

function soundDb(e, cfg) {
  if (e.fuel === 'electric') return 52;
  let db = 70 + 4 * Math.log2(Math.max(0.6, e.cc / 1000)) + (e.cyl >= 8 ? 4 : 0);
  if (e.asp === 'T' || e.asp === 'TT' || cfg.fi === 'turbo' || cfg.fi === 'bigturbo') db -= 2;
  if (e.fuel === 'diesel') db += 2;
  if (e.orient === 'BIKE') db += 6;
  if (e.layout === 'R2') db += 5;
  if (e.fuel === 'hybrid') db -= 4;
  db += { stock: 0, sport: 5, straight: 13 }[cfg.exhaust || 'stock'];
  if (cfg.intake === 'itb') db += 3; else if (cfg.intake === 'cai') db += 1;
  return Math.round(db);
}

function metricsFor(car, engine, cfg, veh, stockMass) {
  const run = simulate(veh, { record: true, recEvery: 0.05, tMax: 70 });
  const vmax = topSpeed(veh) * 3.6;
  const stockE = ENGINE_BY_ID[car.engine];
  let kmplC = null, kmplH = null, range = null, kmPerKwh = null;
  if (engine.fuel === 'electric') {
    const kwh = engine.ev.kwh;
    if (stockE.fuel === 'electric' && car.engine === engine.id && car.range) {
      kmPerKwh = car.range / kwh * Math.pow((car.kerb + 75) / veh.m, 0.5);
    } else {
      kmPerKwh = 7.4 * Math.pow(1250 / veh.m, 0.55);
    }
    kmPerKwh *= fuelModFactor({ ...cfg, ecu: 'stock', fi: 'none' });
    range = kwh * kmPerKwh;
  } else {
    const refS = refL100(stockE);
    const refN = refL100(engine);
    const wfac = Math.pow((car.kerb + 75) / veh.m, 0.5);
    const mf = fuelModFactor(cfg);
    if (refS && car.fuel[0] > 0) {
      kmplC = car.fuel[0] * (refS / refN) * wfac * mf;
      kmplH = car.fuel[1] * (refS / refN) * wfac * mf;
    } else {
      const base = 100 / refN * Math.pow(1200 / veh.m, 0.5);
      kmplC = base * 0.85 * mf; kmplH = base * 1.05 * mf;
    }
  }
  let slipTime = 0;
  const tEnd = run.marks.t100 || run.t[run.t.length - 1] || 0;
  for (let i = 0; i < run.t.length && run.t[i] <= tEnd; i++) slipTime += run.slip[i] * 0.05;
  const gc = car.dims[4] + rideOffset(cfg) - (cfg.lip ? 25 : 0) - (cfg.skirts ? 8 : 0) - (cfg.diffuser ? 10 : 0) + (cfg.tyres === 'at' ? 12 : 0);
  return {
    hp: veh.curve.peakHp, nm: veh.curve.peakNm, hpNos: veh.curve.peakHpNos, rpmHp: veh.curve.rpmAtHp, rpmNm: veh.curve.rpmAtNm,
    redline: veh.curve.redline, weight: veh.m - 75, wf: veh.wf, pw: (veh.curve.peakHpNos / ((veh.m - 75) / 1000)),
    t60: run.marks.t60, t100: run.marks.t100, t150: run.marks.t150, t200: run.marks.t200, tQ: run.marks.tQ, vQ: run.marks.vQ, tK: run.marks.tK,
    vmax, brake: brakingDistance(veh, stockMass), latG: lateralG(veh), kmplC, kmplH, range, kmPerKwh, gc,
    db: soundDb(engine, cfg), slipTime, drive: veh.drive, gearbox: veh.gb.label, gbId: veh.gbId, run,
    fuel: engine.fuel === 'electric' ? 'Electric' : engine.fuel === 'diesel' ? 'Diesel' : engine.fuel === 'hybrid' ? 'Hybrid petrol' : cfg.fuelsys === 'cng' ? 'CNG (petrol backup)' : cfg.fuelsys === 'lpg' ? 'LPG (petrol backup)' : 'Petrol',
  };
}

export function stockFor(car) {
  if (cacheStock.has(car.id)) return cacheStock.get(car.id);
  const cfg = defaultConfig(car);
  const engine = ENGINE_BY_ID[car.engine];
  const veh = deriveVehicle(car, engine, cfg, ENGINE_BY_ID);
  const m = metricsFor(car, engine, cfg, veh, veh.m);
  const out = { cfg, engine, veh, m, scores: scoresFor(car, engine, cfg, veh, m, null, true) };
  cacheStock.set(car.id, out);
  return out;
}

// ---------------- fitment ----------------
export function fitment(car, engine, cfg, veh) {
  const stockE = ENGINE_BY_ID[car.engine];
  const geo = bodyGeometry(car);
  const bay0 = engineBay(car, geo);
  const need = (e) => {
    const [Le, We, He] = e.dim.map((v) => v / 1000);
    if (e.orient === 'EV') return { len: 0.45, wid: 0.5, ht: 0.42, installed: 'EV' };
    let inst;
    if (e.orient === 'BIKE') inst = 'L';
    else if (e.orient === 'T') inst = 'T';
    else if (e.orient === 'L') inst = 'L';
    else inst = (car.drive === 'FWD' || (car.drive === 'AWD' && veh.bay === 'T')) ? 'T' : 'L';
    if (inst === 'T') return { len: We + 0.05, wid: Le + 0.33, ht: He, installed: 'T' };
    return { len: Le + (e.orient === 'BIKE' ? 0.02 : 0.12), wid: We, ht: He, installed: 'L' };
  };
  const ns = need(stockE);
  // the factory engine always fits its own bay
  const bay = {
    ...bay0,
    len: Math.max(bay0.len, ns.len * 1.06),
    wid: Math.max(bay0.wid, ns.wid * 1.06),
    ht: Math.max(bay0.ht, ns.ht * 1.04),
  };
  const ne = need(engine);
  const over = {
    len: Math.max(0, ne.len / bay.len - 1),
    wid: Math.max(0, ne.wid / bay.wid - 1),
    ht: Math.max(0, ne.ht / bay.ht - 1),
  };
  const isStock = engine.id === car.engine;
  let d = 0;
  const items = [];
  if (!isStock) {
    d += 12;
    if (engine.maker === stockE.maker && engine.fuel === stockE.fuel) { d -= 5; items.push({ t: `Same-brand ${engine.maker} swap: mounts and sensors are familiar to mechanics`, k: 'good' }); }
    else items.push({ t: 'Custom engine mounts and a new wiring harness', k: 'warn' });
  }
  const conv = veh.conversion;
  if (conv === 'rwd') { d += 30; items.push({ t: 'Convert to rear-wheel drive: transmission tunnel, propshaft, rear axle and diff', k: 'bad' }); }
  if (conv === 'awd') { d += 40; items.push({ t: 'AWD conversion: transfer case, front and rear diffs, custom shafts', k: 'bad' }); }
  if (conv === 'adapter') { d += 18; items.push({ t: 'Transverse engine in a RWD layout needs an adapter bellhousing and custom mounts', k: 'warn' }); }
  if (conv === 'fwd') { d += 35; items.push({ t: 'Front-drive transaxle adapter for a longitudinal engine', k: 'bad' }); }
  if (over.len > 0.02) { d += Math.min(30, over.len * 70); items.push({ t: `Engine is ${Math.round(over.len * 100)}% too long for the bay: firewall and radiator support must be cut`, k: over.len > 0.25 ? 'bad' : 'warn' }); }
  if (over.wid > 0.02) { d += Math.min(25, over.wid * 60); items.push({ t: `Engine is ${Math.round(over.wid * 100)}% too wide: strut towers or chassis rails need modification`, k: over.wid > 0.2 ? 'bad' : 'warn' }); }
  if (over.ht > 0.03) { d += Math.min(14, over.ht * 45); items.push({ t: 'Engine sits higher than the hood line: hood scoop or cut-out added', k: 'warn' }); }
  if (!isStock) {
    const wr = engine.kg / stockE.kg;
    if (wr > 3) { d += 15; items.push({ t: `Engine weighs ${engine.kg} kg vs ${stockE.kg} kg stock: subframe and springs must be upgraded`, k: 'bad' }); }
    else if (wr > 1.8) { d += 7; items.push({ t: `Heavier engine (${engine.kg} kg vs ${stockE.kg} kg): stiffer front springs needed`, k: 'warn' }); }
    if (engine.era === 'modern' && car.era === 'classic' && engine.fuel !== 'electric') { d += 7; items.push({ t: 'Modern drive-by-wire engine in an old car: standalone ECU needed', k: 'warn' }); }
    if (engine.era === 'old' && car.era !== 'classic') { d += 5; items.push({ t: 'Old engine in a modern car: dashboard, ABS and airbag systems lose engine data', k: 'warn' }); }
    if (engine.fuel === 'diesel' && stockE.fuel !== 'diesel') { d += 8; items.push({ t: 'Diesel conversion: new fuel lines, tank cleaning, glow-plug wiring', k: 'warn' }); }
    if (engine.fuel === 'electric' && stockE.fuel !== 'electric') { d += 25; items.push({ t: 'High-voltage conversion: battery boxes, cooling, charging port and certified wiring', k: 'bad' }); }
    if (engine.fuel !== 'electric' && stockE.fuel === 'electric') { d += 30; items.push({ t: 'EV to petrol: fuel tank, exhaust tunnel, radiator and 12 V systems from scratch', k: 'bad' }); }
    if (engine.fuel === 'hybrid') { d += 18; items.push({ t: 'Hybrid swap: inverter, battery and control software must come as one set', k: 'warn' }); }
    if (engine.orient === 'BIKE') { d += 12; items.push({ t: 'Bike gearbox has no reverse: a reverse box or electric reverse is needed', k: 'bad' }); }
    if (engine.layout === 'R2') { d += 6; items.push({ t: 'Rotary needs a big radiator and careful oil management', k: 'warn' }); }
  }
  if (engine.fuel !== 'electric') {
    const fiD = { none: 0, turbo: 8, bigturbo: 13, sc: 9 }[cfg.fi || 'none'];
    if (fiD) { d += fiD; items.push({ t: cfg.fi === 'sc' ? 'Supercharger bracket, belt drive and fuel upgrade' : 'Turbo manifold, intercooler piping, oil feed and bigger injectors', k: 'warn' }); }
  }
  d = Math.max(0, Math.min(100, d));
  let label;
  if (isStock) label = d === 0 ? (modded(car, cfg) ? 'Bolt-on' : 'Factory') : d <= 18 ? 'Bolt-on kit' : 'Custom work';
  else label = d <= 18 ? 'Bolt-in' : d <= 40 ? 'Custom work' : d <= 65 ? 'Major fabrication' : 'Insane build';
  return { difficulty: d, label, items, bay, need: ne, stockNeed: ns, over, needsScoop: over.ht > 0.03, installed: ne.installed, geo };
}

const PERF_KEYS = ['exhaust', 'intake', 'ecu', 'fi', 'nitrous', 'fuelsys', 'gearbox', 'gearing', 'drive', 'lsd', 'clutch', 'cooling', 'brakes', 'suspension', 'rideHeight', 'weight', 'tyres', 'tyreWidth', 'rimSize', 'lip', 'skirts', 'diffuser', 'spoiler', 'hood', 'widebody', 'roofAcc', 'bullbar', 'snorkel', 'mudflaps', 'cage'];
function modded(car, cfg) {
  const d = defaultConfig(car);
  return PERF_KEYS.some((k) => cfg[k] !== d[k]);
}

// ---------------- scores ----------------
function scoresFor(car, engine, cfg, veh, m, fit, isStockBuild) {
  const stockE = ENGINE_BY_ID[car.engine];
  // reliability
  let rel = 40 + 12 * engine.rel;
  if (!isStockBuild && engine.id !== car.engine) rel -= 6;
  if (fit) rel -= fit.difficulty * 0.14;
  const torqueRatio = m.nm / Math.max(1, ENGINE_BY_ID[car.engine].nm);
  if (torqueRatio > 1.6) rel -= Math.min(22, 10 * (torqueRatio - 1.6)) * (cfg.clutch === 'hd' ? 0.45 : 1);
  rel -= { stock: 0, s1: 2, s2: 6, s3: 14 }[cfg.ecu || 'stock'];
  if (engine.fuel !== 'electric') {
    const turboStock = engine.asp === 'T' || engine.asp === 'TT';
    rel -= { none: 0, turbo: turboStock ? 4 : 10, bigturbo: turboStock ? 10 : 18, sc: 8 }[cfg.fi || 'none'];
    rel -= { none: 0, n35: 4, n75: 9, n150: 16 }[cfg.nitrous || 'none'];
    if (cfg.fuelsys === 'cng') rel -= 4;
  }
  rel += { stock: 0, radiator: 3, full: 6 }[cfg.cooling || 'stock'];
  rel += (engine.parts - 3) * 3;
  rel = Math.max(5, Math.min(100, rel));
  // comfort
  const baseC = { sedan: 72, fastback: 72, hatch: 66, hothatch: 56, kei: 58, tallboy: 60, suv: 74, bigsuv: 72, jeep: 50, pickup: 56, van: 50 }[car.body];
  let com = baseC;
  com += { stock: 0, springs: -8, coilovers: -14, air: 5, lift: -4 }[cfg.suspension || 'stock'];
  com += Math.max(-14, Math.min(6, (veh.side - 95) * 0.12));
  com += { stock: 0, sport: -3, straight: -11 }[cfg.exhaust || 'stock'];
  com += { eco: 2, standard: 0, performance: -2, semislick: -7, drag: -5, at: -4 }[cfg.tyres || 'standard'];
  if (cfg.cage) com -= 10;
  com += { stock: 0, light: 0, seats: -6, strip: -14, carbon: -16 }[cfg.weight || 'stock'];
  if (engine.fuel === 'diesel' && stockE.fuel !== 'diesel') com -= 4;
  if (engine.fuel === 'electric') com += 6;
  if (engine.orient === 'BIKE') com -= 6;
  com = Math.max(5, Math.min(100, com));
  // pakistani roads practicality
  const gc = m.gc;
  let gcScore = gc >= 200 ? 100 : gc >= 160 ? 80 + (gc - 160) / 2 : gc >= 140 ? 60 + (gc - 140) : gc >= 120 ? 40 + (gc - 120) : gc >= 100 ? 20 + (gc - 100) : Math.max(0, gc - 80);
  const economy = engine.fuel === 'electric' ? 70 : Math.max(0, Math.min(100, (m.kmplC || 8) * 5));
  let prac = gcScore * 0.4 + com * 0.25 + economy * 0.15 + engine.parts * 4;
  if (cfg.fuelsys === 'cng') prac += 3;
  prac = Math.max(5, Math.min(100, prac));
  // fun
  const fun = Math.max(5, Math.min(100, (m.pw / 3.2) * 0.55 + (m.latG - 0.6) * 90 + (veh.drive === 'RWD' ? 8 : veh.drive === 'AWD' ? 5 : 0) + (cfg.exhaust === 'straight' ? 6 : 0) + (engine.orient === 'BIKE' ? 8 : 0)));
  return { reliability: Math.round(rel), comfort: Math.round(com), practicality: Math.round(prac), fun: Math.round(fun) };
}

// ---------------- main entry ----------------
export function analyse(car, cfg) {
  const stock = stockFor(car);
  const engine = ENGINE_BY_ID[cfg.engineId] || ENGINE_BY_ID[car.engine];
  const veh = deriveVehicle(car, engine, cfg, ENGINE_BY_ID);
  const m = metricsFor(car, engine, cfg, veh, stock.veh.m);
  const fit = fitment(car, engine, cfg, veh);
  const scores = scoresFor(car, engine, cfg, veh, m, fit, false);
  const pc = prosCons(car, engine, cfg, veh, m, stock, fit, scores);
  const verdict = verdictFor(car, engine, cfg, veh, m, stock, fit, scores);
  return { car, engine, cfg, veh, m, stock, fit, scores, ...pc, verdict };
}

const fmt = (x, d = 0) => (x == null || !isFinite(x) ? '-' : x.toFixed(d));

function prosCons(car, engine, cfg, veh, m, stock, fit, scores) {
  const s = stock.m;
  const pros = [], cons = [], info = [];
  const P = (w, t) => pros.push({ w, t });
  const Cn = (w, t) => cons.push({ w, t });
  const stockE = ENGINE_BY_ID[car.engine];
  const isSwap = engine.id !== car.engine;
  const dHp = m.hpNos / s.hp - 1;
  if (dHp > 0.03) P(50 + dHp * 20, `${dHp >= 1 ? (m.hpNos / s.hp).toFixed(1) + 'x' : '+' + Math.round(dHp * 100) + '%'} power: ${fmt(s.hp)} hp to ${fmt(m.hpNos)} hp`);
  if (dHp < -0.03) Cn(40 - dHp * 20, `${Math.round(-dHp * 100)}% less power than stock (${fmt(m.hpNos)} hp)`);
  if (m.t100 && s.t100) {
    const dt = s.t100 - m.t100;
    if (dt > 0.3) P(45 + dt * 3, `0 to 100 km/h in ${fmt(m.t100, 1)} s instead of ${fmt(s.t100, 1)} s`);
    if (dt < -0.4) Cn(40 - dt * 3, `Slower off the line: 0 to 100 km/h now ${fmt(m.t100, 1)} s (was ${fmt(s.t100, 1)} s)`);
  } else if (!m.t100) Cn(80, 'Cannot reach 100 km/h in a reasonable time');
  if (m.vmax - s.vmax > 8) P(30 + (m.vmax - s.vmax) / 4, `Top speed rises to about ${fmt(m.vmax)} km/h`);
  if (s.vmax - m.vmax > 8) Cn(25 + (s.vmax - m.vmax) / 4, `Top speed drops to about ${fmt(m.vmax)} km/h`);
  const dW = m.weight - s.weight;
  if (dW < -15) P(30 + -dW / 6, `${Math.round(-dW)} kg lighter: sharper handling and shorter braking`);
  if (dW > 40) Cn(25 + dW / 8, `${Math.round(dW)} kg heavier than stock (${fmt(m.weight)} kg)`);
  const dwf = m.wf - s.wf;
  if (dwf > 0.025) Cn(30 + dwf * 300, `Nose-heavy: front axle now carries ${Math.round(m.wf * 100)}% of the weight, more understeer`);
  if (dwf < -0.03 && veh.drive !== 'FWD') P(25, `Better balance: ${Math.round(m.wf * 100)}/${Math.round((1 - m.wf) * 100)} front to rear`);
  // traction
  if ((m.slipTime > 2.2 && m.pw > 140) || m.slipTime > 4.5) {
    const heavy = m.slipTime > 3.2;
    Cn(48 + m.slipTime * 4, `Traction limited: ${veh.drive} spins its tyres for ${fmt(m.slipTime, 1)} s on launch${heavy ? '. Try drag radials, an LSD or AWD' : ''}`);
  }
  if (veh.drive === 'AWD' && m.hpNos > 250) P(40, 'All-wheel drive launches hard with little wheelspin');
  if (veh.drive === 'RWD' && stock.veh.drive === 'FWD') P(30, 'Rear-wheel drive: no torque steer, drift capable');
  if (engine.fuel === 'electric' && stockE.fuel !== 'electric') {
    P(55, `Instant electric torque and roughly ${fmt(m.range)} km of range per charge`);
    P(35, 'No petrol bills: charging at home costs a fraction per km');
    Cn(40, 'Few fast chargers outside the big cities and motorways');
  }
  // economy
  if (m.kmplC && s.kmplC) {
    const r = m.kmplC / s.kmplC;
    if (r > 1.08) P(30 + (r - 1) * 40, `Better fuel average: about ${fmt(m.kmplC, 1)} km/l in the city (stock ${fmt(s.kmplC, 1)})`);
    if (r < 0.85) Cn(30 + (1 - r) * 60, `Fuel average falls to about ${fmt(m.kmplC, 1)} km/l in the city (stock ${fmt(s.kmplC, 1)})`);
  }
  if (cfg.fuelsys === 'cng' && engine.fuel === 'petrol') { P(30, 'CNG cuts running cost per km a lot'); Cn(35, 'CNG loses about 12% power, eats boot space, and gas supply is unreliable'); }
  if (cfg.fuelsys === 'lpg' && engine.fuel === 'petrol') { P(22, 'LPG is cheaper per km than petrol'); Cn(20, 'LPG tank takes boot space and fills are not everywhere'); }
  // parts and reliability
  if (isSwap) {
    if (engine.parts >= 4) P(28 + engine.parts, `${engine.name} parts are easy to find in Pakistan`);
    if (engine.parts <= 2) Cn(32 + (3 - engine.parts) * 8, `${engine.name} parts are rare here: imports, long waits and high bills`);
    if (engine.rel >= 5) P(26, `${engine.name} has a bulletproof reputation`);
    if (engine.rel <= 2) Cn(30, `${engine.name} needs frequent, expert maintenance`);
  }
  if (scores.reliability < 50) Cn(40 + (50 - scores.reliability) / 2, `Reliability risk is high (${scores.reliability}/100): expect breakdowns if driven hard`);
  // fitment
  for (const it of fit.items) {
    if (it.k === 'bad') Cn(45, it.t);
    else if (it.k === 'warn') info.push(it.t);
    else P(18, it.t);
  }
  // drivetrain stress
  const tq = m.nm / Math.max(1, stockE.nm);
  if (tq > 1.7 && !(veh.conversion === 'rwd' || veh.conversion === 'awd') && cfg.clutch !== 'hd' && engine.fuel !== 'electric') Cn(42 + tq * 2, `Stock axles and CV joints were built for about ${stockE.nm} Nm, not ${fmt(m.nm)} Nm: upgrade them`);
  // brakes
  if ((cfg.brakes || 'stock') === 'stock' && m.hpNos > s.hp * 1.6 && m.pw > 110) Cn(44, 'Stock brakes are now undersized for this power: fit a big brake kit');
  if (m.brake < s.brake - 1.5) P(26 + (s.brake - m.brake) * 2, `Stops from 100 km/h in about ${fmt(m.brake, 1)} m (stock ${fmt(s.brake, 1)} m)`);
  if (m.brake > s.brake + 3) Cn(28 + (m.brake - s.brake), `Longer braking: about ${fmt(m.brake, 1)} m from 100 km/h`);
  // handling
  if (m.latG - s.latG > 0.04) P(24 + (m.latG - s.latG) * 100, `More cornering grip: ${fmt(m.latG, 2)} g vs ${fmt(s.latG, 2)} g`);
  // ground clearance
  if (m.gc < 115) Cn(60, `Ground clearance about ${fmt(m.gc)} mm: will hit almost every speed breaker and pothole`);
  else if (m.gc < 135) Cn(42, `Ground clearance about ${fmt(m.gc)} mm: careful on speed breakers and bad roads`);
  if (m.gc - s.gc > 20) P(26, `More ground clearance (${fmt(m.gc)} mm) for broken roads and northern areas`);
  if (cfg.suspension === 'air') P(24, 'Air suspension can be raised for speed breakers and lowered for show');
  // wheels
  if (veh.side < 70) Cn(30, `Very low-profile tyres (${veh.aspect} series): potholes can bend rims`);
  if (cfg.rimSize > (parseTyre(car.tyre).d + 2)) P(14, `${cfg.rimSize}-inch wheels fill the arches`);
  if (cfg.tyres === 'semislick') { P(26, 'Semi-slicks give big dry grip'); Cn(26, 'Semi-slicks are dangerous in rain and wear fast'); }
  if (cfg.tyres === 'drag') { P(24, 'Drag radials hook hard off the line'); Cn(22, 'Drag radials feel vague in corners'); }
  if (cfg.tyres === 'at') { P(22, 'All-terrain tyres handle gravel, mud and mountain tracks'); Cn(14, 'All-terrain tyres are noisier on the motorway'); }
  // sound and legality
  if (cfg.exhaust === 'straight') { P(18, 'Raw, loud exhaust note with pops on the overrun'); Cn(30, 'Straight pipe is very loud: likely to attract traffic police and angry neighbours'); }
  if (cfg.exhaust === 'sport') P(14, 'Deeper exhaust note without droning');
  if (cfg.tint >= 50) Cn(24, 'Dark window tint can be challaned without a permit');
  if (cfg.underglow) Cn(8, 'Underglow is for shows, not for public roads');
  if (cfg.nitrous && cfg.nitrous !== 'none' && engine.fuel !== 'electric') { P(28, `Nitrous adds about ${cfg.nitrous.slice(1)} hp on demand`); Cn(26, 'Nitrous is a short burst: bottle refills are hard to find here'); }
  if (cfg.fi === 'turbo' && !(engine.asp === 'T' || engine.asp === 'TT')) P(26, 'Turbo kit adds big mid-range torque and a turbo whistle');
  if (cfg.fi === 'bigturbo') Cn(30, 'Big turbo means noticeable lag below the boost threshold');
  if (cfg.fi === 'sc') P(24, 'Supercharger gives instant boost and a whine');
  if (cfg.ecu === 's3') Cn(24, 'Stage 3 tune shortens engine life and needs premium fuel');
  if (['n75', 'n150'].includes(cfg.nitrous) || cfg.fi === 'bigturbo' || (isSwap && engine.kg > stockE.kg * 1.8)) {
    if ((cfg.cooling || 'stock') === 'stock') Cn(28, 'Summer heat risk: in 45 degree weather this setup needs a bigger radiator');
  }
  if (cfg.cage) { P(18, 'Roll cage stiffens the shell and protects in a crash'); Cn(16, 'Roll cage makes getting in and out a struggle'); }
  if (cfg.weight === 'strip' || cfg.weight === 'carbon') Cn(18, 'Stripped interior: loud, hot and no AC comfort');
  if (cfg.roofAcc === 'luggage') { P(10, 'Ready for the shaadi trip with all the luggage on the roof'); Cn(12, 'Roof luggage adds drag and raises the centre of gravity'); }
  if (cfg.widebody) P(16, 'Widebody flares fit wider tyres and look aggressive');
  if (cfg.spoiler === 'wing') P(12, 'GT wing adds a little high-speed stability');
  if (isSwap) info.push('Engine number change must be recorded with the Excise and Taxation office');
  if (isSwap || cfg.fi !== 'none' || cfg.ecu !== 'stock') info.push('Insurance and resale value may drop for heavily modified cars');
  pros.sort((a, b) => b.w - a.w); cons.sort((a, b) => b.w - a.w);
  return { pros: pros.slice(0, 8).map((p) => p.t), cons: cons.slice(0, 8).map((p) => p.t), info };
}

function verdictFor(car, engine, cfg, veh, m, stock, fit, scores) {
  const s = stock.m;
  const isSwap = engine.id !== car.engine;
  const tweaks = JSON.stringify({ ...cfg, paint: 0, finish: 0, roof: 0, livery: 0, liveryColor: 0, tint: 0, plate: 0, rimColor: 0, caliper: 0, headlight: 0, underglow: 0, rimStyle: 0, tips: 0 })
    !== JSON.stringify({ ...stock.cfg, paint: 0, finish: 0, roof: 0, livery: 0, liveryColor: 0, tint: 0, plate: 0, rimColor: 0, caliper: 0, headlight: 0, underglow: 0, rimStyle: 0, tips: 0 });
  if (!tweaks) return { title: 'Factory spec', sub: 'Exactly as it left the showroom' };
  const t = m.t100 || 99;
  const small = car.kerb < 950;
  if (t < 3.2) return { title: 'Hypercar hunter', sub: `0 to 100 km/h in ${t.toFixed(1)} s` };
  if (engine.fuel === 'electric' && car.engine !== engine.id) return { title: 'Silent assassin', sub: 'Electric swap with instant torque' };
  if (small && m.hpNos > 180) return { title: car.model === 'Mehran' ? 'Mehran of doom' : 'Pocket rocket', sub: `${Math.round(m.pw)} hp per tonne in a ${car.model}` };
  if (t < 4.5) return { title: 'Supercar slayer', sub: `0 to 100 km/h in ${t.toFixed(1)} s` };
  if (veh.drive === 'FWD' && m.hpNos > 280) return { title: 'Wheelspin machine', sub: 'Too much power for the front tyres' };
  if (m.hpNos > s.hp * 2.5) return { title: 'Sleeper', sub: `${Math.round(m.hpNos / s.hp * 10) / 10}x the factory power` };
  if (fit.difficulty > 65) return { title: 'Garage legend', sub: 'An insane build only a brave mistri would attempt' };
  if ((cfg.suspension === 'lift' || cfg.tyres === 'at') && (car.body === 'jeep' || car.body === 'pickup' || car.body === 'bigsuv' || car.body === 'suv')) return { title: 'Northern areas beast', sub: 'Built for Naran, Skardu and beyond' };
  if (m.gc < 120 && (cfg.rimSize || 0) >= 17) return { title: 'Stance build', sub: 'Low, wide and photogenic' };
  if (m.latG > s.latG + 0.08 && (cfg.weight === 'strip' || cfg.weight === 'carbon' || cfg.cage)) return { title: 'Track weapon', sub: 'Light, stiff and grippy' };
  if (m.kmplC && s.kmplC && m.kmplC > s.kmplC * 1.1 && m.hp >= s.hp * 0.95) return { title: 'Smart daily', sub: 'More km per litre, same fun' };
  if (cfg.fuelsys === 'cng') return { title: 'Budget saver', sub: 'Cheap running costs, less punch' };
  if (m.hpNos > s.hp * 2) return { title: 'Sleeper', sub: `${Math.round(m.hpNos / s.hp * 10) / 10}x the factory power` };
  if (m.hpNos > s.hp * 1.25) return { title: 'Street build', sub: 'Noticeably quicker than stock' };
  if (isSwap) return { title: 'Swap project', sub: fit.label };
  return { title: 'Personalised', sub: 'Your style on a factory base' };
}

export function engineSpecLines(engine) {
  return [
    ['Layout', engineLayoutLabel(engine)],
    ['Aspiration', aspirationLabel(engine)],
    ['Displacement', engine.cc ? `${engine.cc} cc` : 'Electric'],
    ['Power', engine.fuel === 'hybrid' ? `${engine.hyb.sys} hp system` : `${engine.hp} hp${engine.rpmP ? ' @ ' + engine.rpmP : ''}`],
    ['Torque', `${engine.nm} Nm${engine.rpmT ? ' @ ' + engine.rpmT + (engine.rpmT2 ? '-' + engine.rpmT2 : '') : ''}`],
    ['Redline', engine.fuel === 'electric' ? `${engine.ev.maxRpm} rpm motor` : `${engine.redline} rpm`],
    ['Weight', `${engine.kg} kg${engine.ev ? ' + ' + engine.ev.battKg + ' kg battery' : engine.hyb ? ' + ' + engine.hyb.kg + ' kg hybrid' : ''}`],
    ['Found in', engine.from],
  ];
}

export function gearboxLabel(id) { return (GEARBOXES[id] || {}).label || id; }
