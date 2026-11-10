// Drivable car dynamics. Planar rigid body (x, y, heading) with four wheels:
// per-wheel combined-slip tyres, load transfer, engine torque curve from the build, clutch,
// gearbox (auto, manual, CVT, EV), differentials, brakes with ABS, handbrake, drift assist.
// Frames: world 2D (x, y) with y = -three.z; car frame x forward, y left.
import { torqueAt } from '../sim/powertrain.js';
import { bodyGeometry } from '../sim/shape.js';

const G = 9.81;
const RHO = 1.2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { if (x <= a) return 0; if (x >= b) return 1; const t = (x - a) / (b - a); return t * t * (3 - 2 * t); };

// Normalised tyre curve: rises with slip, peaks at s = 1, slides at about 85 % of peak.
const TC = 1.35;
const TB = Math.tan(Math.PI / (2 * TC));
const tyreCurve = (s) => Math.sin(TC * Math.atan(TB * s));
const TYRE_STIFF = TC * TB;
const LONG_W = 0.6;

const TYRE = {
  eco: { kp: 0.11, ap: 8.5 }, standard: { kp: 0.1, ap: 7.5 }, performance: { kp: 0.09, ap: 6.5 },
  semislick: { kp: 0.08, ap: 5.5 }, drag: { kp: 0.12, ap: 8 }, at: { kp: 0.13, ap: 10 },
};
const LSD = { open: { pre: 0, bias: 0, c: 0 }, helical: { pre: 25, bias: 0.4, c: 260 }, clutch: { pre: 90, bias: 0.65, c: 420 } };
const SUSP = { stock: 0.93, springs: 0.97, coilovers: 1.0, air: 0.96, lift: 0.88 };
const ROLL = { stock: 1, springs: 0.8, coilovers: 0.62, air: 0.85, lift: 1.25 };
// Suspension set-ups: body roll per g of cornering (degrees), dive or squat per g (degrees),
// damping ratio and the share of roll stiffness carried by the front axle. Lowering springs on
// factory dampers are stiffer but under-damped; coilovers are stiff and well controlled.
const SETUP = {
  stock: { roll: 4.6, pitch: 2.0, zeta: 0.36, front: 0.58 },
  springs: { roll: 3.6, pitch: 1.6, zeta: 0.27, front: 0.58 },
  coilovers: { roll: 2.6, pitch: 1.1, zeta: 0.62, front: 0.56 },
  air: { roll: 3.9, pitch: 1.8, zeta: 0.4, front: 0.58 },
  lift: { roll: 5.8, pitch: 2.5, zeta: 0.3, front: 0.6 },
};
// Lift of the bare body shape (front, rear) as a coefficient on frontal area; positive = lift.
const BODY_LIFT = { kei: [0.1, 0.14], tallboy: [0.11, 0.15], hatch: [0.09, 0.14], hothatch: [0.07, 0.11], sedan: [0.09, 0.12], fastback: [0.07, 0.1], suv: [0.1, 0.13], bigsuv: [0.11, 0.14], jeep: [0.12, 0.14], pickup: [0.11, 0.16], van: [0.1, 0.12] };

export const WHEEL = { FL: 0, FR: 1, RL: 2, RR: 3 };

export class CarPhysics {
  constructor(veh, opts = {}) {
    this.veh = veh;
    const car = veh.car, cfg = veh.cfg || {};
    this.car = car;
    this.cfg = cfg;
    const geo = bodyGeometry(car, { widebody: !!cfg.widebody });
    this.m = veh.m;
    this.WB = veh.WB;
    this.a = this.WB * (1 - veh.wf); // CG to front axle
    this.b = this.WB * veh.wf; // CG to rear axle
    const L = car.dims[0] / 1000, W = car.dims[1] / 1000;
    this.L = L; this.W = W + (cfg.widebody ? 0.06 : 0);
    this.track = clamp(W - veh.tyreW / 1000 - 0.06, 1.05, 1.9);
    this.h = veh.h;
    this.Iz = (this.m * (L * L + W * W)) / 12 * 1.15;
    this.R = veh.r;
    // body centre relative to the CG (the model origin is the middle of the car)
    this.xCg = geo.xF - this.a;
    this.xF = geo.xF; this.xR = geo.xR;
    const ty = TYRE[cfg.tyres || 'standard'] || TYRE.standard;
    this.kp = ty.kp;
    this.tanAp = Math.tan((ty.ap * Math.PI) / 180);
    this.muX = veh.mu;
    this.muY = veh.muLat * (SUSP[cfg.suspension || 'stock'] || 0.93) * (cfg.widebody ? 1.02 : 1);
    this.rollK = ROLL[cfg.suspension || 'stock'] || 1;
    // ---- sprung mass on its springs: roll and pitch as damped second-order systems. Load moves
    // between the tyres through the springs and dampers (plus a part straight through the
    // suspension links), so how quickly and how far the weight shifts depends on the set-up.
    const su = SETUP[cfg.suspension || 'stock'] || SETUP.stock;
    const tall = clamp(this.h / 0.52, 0.85, 1.5); // tall vehicles lean more on the same springs
    this.hrc = clamp(this.h * 0.24, 0.08, 0.2); // roll-centre height
    this.hr = this.h - this.hrc;
    this.Kroll = (this.m * G * this.hr) / ((su.roll * tall * Math.PI) / 180);
    this.Ix = this.m * Math.pow(0.34 * W, 2) + this.m * 0.06;
    this.Croll = 2 * su.zeta * Math.sqrt(this.Kroll * this.Ix);
    this.Kpitch = (this.m * G * this.h) / ((su.pitch * tall * Math.PI) / 180);
    this.Iy = this.m * Math.pow(0.27 * L, 2);
    this.Cpitch = 2 * (su.zeta + 0.08) * Math.sqrt(this.Kpitch * this.Iy);
    this.rollFront = su.front + (veh.drive === 'RWD' ? -0.03 : 0);
    // ---- aerodynamic lift and downforce (N per (m/s)^2), front and rear axle; positive presses
    // the car down. A bare body lifts a little at speed; lips, diffusers and wings fight that.
    const bl = BODY_LIFT[car.body] || BODY_LIFT.sedan;
    const ride = (veh.ride || 0) / 1000;
    let clF = -bl[0], clR = -bl[1];
    if (cfg.lip) clF += 0.06;
    if (cfg.skirts) { clF += 0.01; clR += 0.01; }
    if (cfg.diffuser) clR += 0.06;
    clR += { none: 0, lip: 0.03, ducktail: 0.07, roof: 0.04, wing: 0.22 }[cfg.spoiler || 'none'] || 0;
    if (cfg.spoiler === 'wing') clF -= 0.02; // a big rear wing levers the nose up slightly
    if (cfg.roofAcc === 'box' || cfg.roofAcc === 'luggage' || cfg.roofAcc === 'rack') { clF -= 0.015; clR -= 0.02; }
    clF -= ride * 0.5; clR -= ride * 0.4; // lower = less air under the car
    this.aeroF = 0.5 * RHO * veh.A * clF;
    this.aeroR = 0.5 * RHO * veh.A * clR;
    this.drive = veh.drive;
    this.driven = this.drive === 'FWD' ? [1, 1, 0, 0] : this.drive === 'RWD' ? [0, 0, 1, 1] : [1, 1, 1, 1];
    this.frontSplit = this.drive === 'AWD' ? (['bigsuv', 'jeep', 'pickup'].includes(car.body) ? 0.5 : 0.38) : 0;
    this.lsd = LSD[veh.lsd || 'open'] || LSD.open;
    this.Iw = clamp(0.75 + (this.R - 0.29) * 3.2, 0.55, 2.2);
    this.Ie = veh.inertia || 0.12;
    const bf = { stock: 1, pads: 1.08, bbk: 1.2, ceramic: 1.28 }[cfg.brakes || 'stock'];
    this.brakeT = this.muX * this.m * G * this.R * 1.25 * bf; // total brake torque all wheels
    this.abs = car.era !== 'classic';
    this.hbT = this.m * G * this.R * 0.9; // per rear wheel, enough to lock it
    this.lock = ((['kei', 'tallboy'].includes(car.body) ? 39 : ['bigsuv', 'pickup', 'van'].includes(car.body) ? 33 : 36) * Math.PI) / 180;
    this.crr = veh.crr;
    this.CdA = veh.CdA;
    // engine and gearbox
    const c = veh.curve;
    this.curve = c;
    this.ev = !!c.ev;
    this.redline = c.redline;
    this.idle = this.ev ? 0 : c.idle || 800;
    this.peakNm = c.peakNm || 100;
    this.gb = veh.gb;
    this.fd = veh.fd;
    this.eff = veh.eff;
    this.kind = veh.gb.kind; // manual auto dct seq cvt ev
    this.ratios = veh.gb.ratios ? veh.gb.ratios.slice() : [1];
    this.rRev = this.kind === 'cvt' ? 2.6 : Math.max(2.6, (this.ratios[0] || 3) * 0.95);
    this.shiftTime = veh.gb.shift || 0.3;
    this.shiftTorque = veh.gb.shiftT || 0;
    this.converter = !!veh.gb.converter;
    this.launchRpm = this.ev ? 0 : veh.engine.fuel === 'diesel' ? Math.min(this.redline * 0.55, 2200) : veh.engine.orient === 'BIKE' ? 6500 : Math.min(this.redline * 0.62, Math.max(c.rpmAtNm + 200, 2800));
    this.stallRpm = this.converter ? Math.min(2600, this.launchRpm) : this.launchRpm;
    this.bm = c.boost || { kind: 'none' };
    this.nosCap = c.nosHp > 0 ? 9 : 0;
    this.vLimit = veh.vLimit || Infinity;
    this.hybrid = veh.engine.hyb || null;
    // assists
    this.assist = opts.assist ?? 0.55;
    this.driftMax = ((opts.driftMax ?? 48) * Math.PI) / 180;
    this.manual = !!opts.manual;
    this.tcs = !!opts.tcs;
    this.esc = !!opts.esc;
    this.absOn = opts.abs ?? true;
    this.engineOn = opts.engineOn ?? true;
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitrous: false };
    this.events = [];
    // scratch storage reused by every step: the 240 Hz loop must not create garbage
    this.loads = [0, 0, 0, 0];
    this.tq = [0, 0, 0, 0];
    this.grad = [0, 0];
    this.box = { cx: 0, cy: 0, cp: 1, sp: 0, hl: L / 2, hw: this.W / 2, pts: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]] };
    this.reset(0, 0, 0);
  }

  reset(x, y, psi) {
    this.x = x; this.y = y; this.psi = psi;
    this.u = 0; this.v = 0; this.r = 0;
    this.wheels = [0, 1, 2, 3].map((i) => ({
      i, w: 0, kappa: 0, alpha: 0, load: 0, fx: 0, fy: 0, slip: 0, spin: 0, front: i < 2, left: i % 2 === 0, surf: 1, kind: 'asphalt',
      px: i < 2 ? this.a : -this.b, py: i % 2 === 0 ? this.track / 2 : -this.track / 2, wx: x, wy: y,
    }));
    this.gear = this.ratios.length ? 1 : 1;
    this.shiftT = 0; this.cutT = 0;
    this.rpm = this.idle; this.engW = (this.idle * Math.PI) / 30;
    this.clutchLocked = false;
    this.boost = 0; this.nos = this.nosCap; this.nosOn = false;
    this.axF = 0; this.ayF = 0;
    this.steerNow = 0; this.revHold = 0; this.hbTimer = 0; this.drifting = 0; this.shiftCool = 0;
    this.tcsF = 1; this.tcsActive = false; this.absActive = false; this.thrEff = 0; this.brkEff = 0;
    this.scrapeV = 0; this.contacts = []; this.maxSlip = 0;
    this.roll = 0; this.rollV = 0; this.pitch = 0; this.pitchV = 0;
    this.time = 0;
    this.cvtRatio = this.kind === 'cvt' ? this.gb.range[0] : 1;
  }

  get speed() { return Math.hypot(this.u, this.v); }
  get kmh() { return Math.abs(this.u) * 3.6; }
  get beta() { return Math.abs(this.u) < 0.5 ? 0 : Math.atan2(this.v, Math.abs(this.u)); }
  get gearLabel() { return this.gear < 0 ? 'R' : this.gear === 0 ? 'N' : this.kind === 'cvt' || this.kind === 'ev' ? 'D' : String(this.gear); }
  // model origin (middle of the body) in world coordinates
  origin() { const c = Math.cos(this.psi), s = Math.sin(this.psi); return [this.x - this.xCg * c, this.y - this.xCg * s]; }
  get nGears() { return this.kind === 'cvt' || this.kind === 'ev' ? 1 : this.ratios.length; }

  gearRatio(g = this.gear) {
    if (g < 0) return -this.rRev * this.fd;
    if (g === 0) return 0;
    if (this.kind === 'cvt') return this.cvtRatio * this.fd;
    if (this.kind === 'ev') return this.fd;
    return this.ratios[clamp(g, 1, this.ratios.length) - 1] * this.fd;
  }

  shiftUp() {
    if (this.shiftT > 0 || this.kind === 'cvt' || this.kind === 'ev') { if (this.gear < 0 && Math.abs(this.u) < 2) this.gear = 1; return; }
    if (this.gear < 0) { if (Math.abs(this.u) < 2) { this.gear = 0; } return; }
    if (this.gear < this.ratios.length) { this.startShift(this.gear + 1); }
  }

  shiftDown() {
    if (this.shiftT > 0) return;
    if (this.kind === 'cvt' || this.kind === 'ev') { if (Math.abs(this.u) < 2) this.gear = -1; return; }
    if (this.gear > 1) {
      const target = this.gear - 1;
      // refuse a downshift that would over-rev the engine
      const rpmT = (Math.abs(this.drivenOmega()) * Math.abs(this.gearRatio(target)) * 30) / Math.PI;
      if (rpmT < this.redline * 1.04) this.startShift(target);
      else this.events.push({ type: 'denied' });
    } else if (this.gear === 1) { if (Math.abs(this.u) < 2) this.gear = 0; }
    else if (this.gear === 0) { if (Math.abs(this.u) < 2) this.gear = -1; }
  }

  startShift(g) {
    const up = g > this.gear;
    this.gear = g;
    this.shiftT = this.shiftTime;
    this.events.push({ type: 'shift', up, boost: this.boost });
  }

  drivenOmega() {
    let s = 0, n = 0;
    for (const w of this.wheels) if (this.driven[w.i]) { s += w.w; n++; }
    return n ? s / n : 0;
  }

  // ---------------------------------------------------------------- engine torque (N m at the crank)
  engineTorque(rpm, thr) {
    const c = this.curve;
    if (this.ev) {
      const T = torqueAt(c, Math.max(rpm, 1));
      return thr > 0.01 ? T * thr : -this.peakNm * 0.08 * smooth(300, 1500, rpm); // light regen
    }
    const bm = this.bm;
    let bfrac = 1;
    if (bm.kind === 'turbo' || bm.kind === 'twin') bfrac = 1 - bm.frac * (1 - Math.min(1, this.boost / Math.max(0.05, thr || 0.05))) * smooth(bm.from * 0.6, bm.to, rpm);
    const full = torqueAt(c, Math.max(rpm, this.idle * 0.8), this.nosOn) * bfrac;
    const fric = this.peakNm * (0.07 + 0.13 * (rpm / this.redline));
    if (this.cutT > 0) return -fric;
    return thr * full - (1 - thr) * fric;
  }

  // ---------------------------------------------------------------- main step
  step(dt, world) {
    this.time += dt;
    const inp = this.input;
    const m = this.m;
    // car-frame velocity
    let u = this.u, v = this.v, r = this.r;
    const spd = Math.hypot(u, v);
    // ---------------- driver inputs: reverse logic for arcade control
    let thr = clamp(inp.throttle, 0, 1), brk = clamp(inp.brake, 0, 1);
    if (this.gear >= 0 && u < 0.6 && brk > 0.5 && thr < 0.1) {
      this.revHold += dt;
      if (this.revHold > 0.22 && u < 0.3) { this.gear = -1; this.revHold = 0; }
    } else if (this.gear < 0 && u > -0.6 && thr > 0.5 && brk < 0.1) {
      this.revHold += dt;
      if (this.revHold > 0.15) { this.gear = 1; this.revHold = 0; }
    } else this.revHold = 0;
    if (this.gear < 0) { const t = thr; thr = brk; brk = t; }
    if (this.gear === 0 && !this.manual && thr > 0.2) this.gear = 1;
    // traction control: trims the throttle while the driven wheels spin up
    if (this.tcs && u > 1) {
      let kMax = 0;
      for (const w of this.wheels) if (this.driven[w.i]) kMax = Math.max(kMax, w.kappa * (this.gear < 0 ? -1 : 1));
      const want = clamp(1 - (kMax - 0.1) * 6, 0.12, 1);
      this.tcsF += (want - this.tcsF) * Math.min(1, dt * (want < this.tcsF ? 30 : 5));
    } else this.tcsF += (1 - this.tcsF) * Math.min(1, dt * 5);
    this.tcsActive = this.tcsF < 0.93 && thr > 0.2;
    thr *= this.tcsF;
    if (this.esc && u > 4) thr *= 1 - 0.85 * smooth(0.08, 0.2, Math.abs(Math.atan2(v, u)));
    if (!this.engineOn) thr = 0;
    this.thrEff = thr; this.brkEff = brk;
    // ---------------- steering with speed sensitivity and drift assist
    const vRef = Math.max(Math.abs(u), 0.1);
    const lockNow = this.lock / (1 + Math.pow(vRef / 10, 1.3) * 0.8);
    let target = clamp(inp.steer, -1, 1) * lockNow;
    if (this.assist > 0 && u > 3) {
      const beta = Math.atan2(v, u);
      target += this.assist * beta * smooth(0.03, 0.12, Math.abs(beta));
    }
    target = clamp(target, -this.lock, this.lock);
    const rate = 2.8 * dt; // rad per step limit
    this.steerNow += clamp(target - this.steerNow, -rate, rate);
    const delta = this.steerNow;
    // ---------------- loads: the body rolls and pitches on its springs, and the springs and
    // dampers pass the weight on to the tyres
    const ax = this.axF, ay = this.ayF;
    const WB = this.WB, h = this.h, t = this.track;
    this.rollV += ((m * this.hr * ay - this.Kroll * this.roll - this.Croll * this.rollV) / this.Ix) * dt;
    this.roll += this.rollV * dt;
    this.pitchV += ((m * h * ax - this.Kpitch * this.pitch - this.Cpitch * this.pitchV) / this.Iy) * dt;
    this.pitch += this.pitchV * dt;
    const wfS = this.b / WB; // static front weight share
    const Mroll = this.Kroll * this.roll + this.Croll * this.rollV, Mgeo = m * ay * this.hrc;
    const Mpitch = this.Kpitch * this.pitch + this.Cpitch * this.pitchV;
    const v2 = u * u;
    const FzF = m * G * wfS - Mpitch / WB + this.aeroF * v2;
    const FzR = m * G * (1 - wfS) + Mpitch / WB + this.aeroR * v2;
    const dWf = (this.rollFront * Mroll + wfS * Mgeo) / t, dWr = ((1 - this.rollFront) * Mroll + (1 - wfS) * Mgeo) / t;
    // slope: gravity pulls along the hill and the tyres carry a little less weight
    let gSx = 0, gSy = 0, cosSl = 1;
    if (world && world.gradAt) {
      const gr = world.gradAt(this.x, this.y, this.grad);
      cosSl = 1 / Math.sqrt(1 + gr[0] * gr[0] + gr[1] * gr[1]);
      const c0 = Math.cos(this.psi), s0 = Math.sin(this.psi);
      gSx = -m * G * (gr[0] * c0 + gr[1] * s0) * cosSl;
      gSy = -m * G * (-gr[0] * s0 + gr[1] * c0) * cosSl;
    }
    this.slopeF = gSx;
    const loads = this.loads;
    loads[0] = Math.max(0, (FzF / 2 - dWf) * cosSl); loads[1] = Math.max(0, (FzF / 2 + dWf) * cosSl);
    loads[2] = Math.max(0, (FzR / 2 - dWr) * cosSl); loads[3] = Math.max(0, (FzR / 2 + dWr) * cosSl);
    // ---------------- drivetrain
    let ratio = this.gearRatio();
    if (this.shiftT > 0) this.shiftT -= dt;
    const shifting = this.shiftT > 0;
    // turbo spool
    const bm = this.bm;
    if (bm.kind === 'turbo' || bm.kind === 'twin') {
      const tgt = smooth(bm.from * 0.7, bm.to, this.rpm) * thr;
      this.boost += (tgt - this.boost) * Math.min(1, dt / (tgt > this.boost ? bm.tau * 1.2 : 0.18));
    } else if (bm.kind === 'sc') this.boost = smooth(500, 3000, this.rpm) * thr; else this.boost = 0;
    // nitrous
    this.nosOn = !!(inp.nitrous && this.nos > 0 && thr > 0.5 && this.gear !== 0 && !this.ev);
    if (this.nosOn) this.nos = Math.max(0, this.nos - dt); else if (this.nosCap) this.nos = Math.min(this.nosCap, this.nos + dt * 0.08);
    if (this.cutT > 0) this.cutT -= dt;
    const wAx = this.drivenOmega();
    let driveT = 0; // total torque delivered to the driven wheels
    let coupledI = 0; // engine inertia reflected to each driven wheel when the clutch is locked
    const nDriven = this.driven[0] + this.driven[1] + this.driven[2] + this.driven[3];
    if (!this.engineOn) {
      driveT = 0; this.clutchLocked = false; this.boost *= Math.exp(-dt * 3);
    } else if (this.ev) {
      if (this.gear === 0) { driveT = 0; this.rpm = 0; }
      else {
        this.rpm = (Math.abs(wAx * ratio) * 30) / Math.PI;
        let T = this.engineTorque(this.rpm, thr);
        if (Math.abs(u) > this.vLimit && T > 0) T = 0;
        driveT = T * ratio * this.eff;
        this.clutchLocked = true;
      }
    } else {
      if (this.kind === 'cvt' && this.gear > 0) {
        // the CVT holds the engine where the throttle asks for
        const wheelRpm = (Math.abs(wAx) * this.fd * 30) / Math.PI;
        const want = this.idle + thr * ((this.curve.rpmAtHp || this.redline * 0.8) * 0.97 - this.idle);
        const [rMax, rMin] = this.gb.range;
        this.cvtRatio = clamp(want / Math.max(1, wheelRpm), rMin, rMax);
        ratio = this.gearRatio();
      }
      const wheelRpm = (Math.abs(wAx * ratio) * 30) / Math.PI;
      if (this.gear === 0 || (shifting && this.shiftTorque === 0)) {
        // neutral or clutch in: engine revs freely
        const T = this.engineTorque(this.rpm, this.gear === 0 ? thr : thr * 0.2);
        this.engW = Math.max((this.idle * 0.9 * Math.PI) / 30, this.engW + ((T + (this.rpm < this.idle ? this.peakNm * 0.25 : 0)) / (this.Ie * 1.6)) * dt);
        if (shifting && this.gear !== 0) { const tw = (wheelRpm * Math.PI) / 30; this.engW += (tw - this.engW) * Math.min(1, dt / Math.max(0.02, this.shiftT)); }
        this.rpm = (this.engW * 30) / Math.PI;
        this.clutchLocked = false;
      } else {
        const slipTarget = this.idle * 1.08 + thr * ((this.converter ? this.stallRpm : this.launchRpm) - this.idle);
        if (wheelRpm < slipTarget && thr > 0.02) {
          // clutch slipping (or torque converter): engine held at the launch speed
          const er = Math.max(slipTarget, wheelRpm);
          this.rpm += (er - this.rpm) * Math.min(1, dt * 12);
          const mult = this.converter ? 1 + 0.9 * Math.max(0, 1 - wheelRpm / er) : 1;
          let T = Math.max(0, this.engineTorque(this.rpm, thr)) * mult;
          if (this.hybrid && Math.abs(u) < 8) T += this.hybrid.mnm * 0.5 * (1 - Math.abs(u) / 8) * thr;
          driveT = T * ratio * this.eff;
          this.clutchLocked = false;
        } else if (wheelRpm < this.idle * 1.05) {
          // rolling slowly off throttle: clutch out (manual) or creep (automatic)
          this.rpm += (this.idle - this.rpm) * Math.min(1, dt * 6);
          driveT = this.converter ? this.peakNm * 0.12 * ratio * this.eff * (1 - wheelRpm / (this.idle * 1.05)) : 0;
          this.clutchLocked = false;
        } else {
          this.rpm = wheelRpm;
          if (this.rpm >= this.redline && this.cutT <= 0) { this.cutT = 0.055; this.events.push({ type: 'limiter' }); }
          let T = this.engineTorque(this.rpm, thr);
          if (shifting) T *= this.shiftTorque;
          driveT = T * ratio * this.eff;
          coupledI = (this.Ie * ratio * ratio) / nDriven;
          this.clutchLocked = true;
        }
      }
      // automatic shifting
      if (!this.manual && this.kind !== 'cvt' && this.gear > 0 && !shifting) {
        const n = this.ratios.length;
        const up = this.redline * (0.6 + 0.35 * thr);
        let wheelSlip = false; for (let i = 0; i < 4; i++) if (this.driven[i] && this.wheels[i].kappa > 0.35) { wheelSlip = true; break; }
        if (this.shiftCool > 0) this.shiftCool -= dt;
        if (this.gear < n && this.rpm > up && !(wheelSlip && Math.abs(u) < 6)) { this.startShift(this.gear + 1); this.shiftCool = 1.4; }
        else if (this.gear > 1 && this.shiftCool <= 0 && !wheelSlip) {
          const down = this.idle * 1.45 + thr * this.redline * 0.36;
          const rpmLower = (Math.abs(wAx) * Math.abs(this.gearRatio(this.gear - 1)) * 30) / Math.PI;
          if (this.rpm < down && rpmLower < this.redline * 0.88) this.startShift(this.gear - 1);
        }
      }
    }
    // drift assist: past the angle limit, ease the power like a driver feathering the throttle
    const betaNow = Math.abs(u) > 2 ? Math.atan2(v, Math.abs(u)) : 0;
    const bMax = this.driftMax;
    if (this.assist > 0 && driveT * Math.sign(ratio || 1) > 0) driveT *= 1 - this.assist * 0.6 * smooth(bMax, bMax * 1.4, Math.abs(betaNow));
    // differentials: split driveT to the driven wheels
    const tq = this.tq;
    tq[0] = 0; tq[1] = 0; tq[2] = 0; tq[3] = 0;
    if (this.drive === 'FWD') this.splitAxle(0, 1, driveT, coupledI, dt);
    else if (this.drive === 'RWD') this.splitAxle(2, 3, driveT, coupledI, dt);
    else {
      // centre coupling moves torque towards the slower axle
      const wf = (this.wheels[0].w + this.wheels[1].w) / 2, wr = (this.wheels[2].w + this.wheels[3].w) / 2;
      const dw = wf - wr;
      const lim = Math.min(60 + 0.5 * Math.abs(driveT), (Math.abs(dw) * (this.Iw * 2)) / dt * 0.9);
      const Tc = clamp(300 * dw, -lim, lim);
      this.splitAxle(0, 1, driveT * this.frontSplit - Tc, coupledI, dt);
      this.splitAxle(2, 3, driveT * (1 - this.frontSplit) + Tc, coupledI, dt);
    }
    // ---------------- tyres
    let Fx = 0, Fy = 0, Mz = 0;
    const cd = Math.cos(delta), sd = Math.sin(delta);
    const ps = Math.cos(this.psi), pn = Math.sin(this.psi);
    let maxSlip = 0, absNow = false;
    for (const wh of this.wheels) {
      const i = wh.i;
      const front = i < 2;
      // Ackermann: the inside front wheel turns a little more
      const ack = front ? delta * (1 + (wh.left ? 1 : -1) * Math.sign(delta) * 0.08) : 0;
      const c = front ? Math.cos(ack) : 1, s = front ? Math.sin(ack) : 0;
      const vwx = u - r * wh.py, vwy = v + r * wh.px;
      const vl = vwx * c + vwy * s;
      const vt = -vwx * s + vwy * c;
      // where the tyre touches the ground (for surfaces and skid marks)
      wh.wx = this.x + wh.px * ps - wh.py * pn;
      wh.wy = this.y + wh.px * pn + wh.py * ps;
      const sf = world ? world.surfaceAt(wh.wx, wh.wy) : { mu: 1, roll: 1, kind: 'asphalt' };
      wh.surf = sf.mu; wh.kind = sf.kind;
      const Fz = loads[i];
      wh.load = Fz;
      const Fz0 = (m * G) / 4;
      const ls = clamp(1 - 0.14 * (Fz / Fz0 - 1), 0.7, 1.2);
      // rear tyres a touch more forgiving (static toe-in), so grip driving stays stable
      const mux = this.muX * sf.mu * ls, muy = this.muY * sf.mu * ls * (front ? 1 : 1.04);
      const vref = Math.max(Math.abs(vl), 1);
      let kappa = (wh.w * this.R - vl) / vref;
      const tanA = vt / Math.max(Math.abs(vl), 3);
      // brakes and handbrake
      let Tb = brk * this.brakeT * (front ? 0.33 : 0.17);
      // rear brake proportioning (per wheel on cars with ABS/EBD, per axle on old cars)
      if (!front) Tb *= this.abs ? clamp(Fz / ((m * G * this.a) / WB / 2), 0.2, 1) : clamp((loads[2] + loads[3]) / ((m * G * this.a) / WB), 0.35, 1);
      if (this.abs && this.absOn && brk > 0.05 && kappa < -0.13 && Math.abs(vl) > 2) { Tb *= 0.35; absNow = true; }
      if (!front && inp.handbrake > 0.05) Tb += inp.handbrake * this.hbT;
      // combined slip force
      const sx = kappa / this.kp, sy = tanA / (this.tanAp * (front ? 1 : 1.1));
      const sN = Math.hypot(sx, sy);
      let fx = 0, fy = 0;
      if (sN > 1e-6) {
        // friction ellipse split that keeps some side grip while the tyre spins, so slides can be held
        const f = tyreCurve(sN);
        const dS = Math.hypot(sx * LONG_W, sy);
        fx = (mux * Fz * f * sx * LONG_W) / dS;
        fy = (-muy * Fz * f * sy) / dS;
      }
      // never let the tyre reverse its own lateral sliding inside one step (stable at walking pace)
      const mWheel = Fz / G;
      const fyMax = (mWheel * Math.abs(vt)) / dt;
      if (Math.abs(fy) > fyMax) fy = Math.sign(fy) * fyMax;
      // wheel spin: implicit in the tyre's longitudinal stiffness
      const I = this.Iw + (this.driven[i] ? coupledI : 0);
      const kx = ((mux * Fz * TYRE_STIFF) / this.kp) * (this.R / vref) * clamp(1 - sN * 0.5, 0.08, 1);
      let w = wh.w + (dt * (tq[i] - fx * this.R)) / (I + dt * kx * this.R);
      const dwB = (Tb * dt) / I;
      if (Math.abs(w) <= dwB) w = 0; else w -= Math.sign(w) * dwB;
      wh.w = w;
      // recompute longitudinal force with the updated wheel speed for consistency
      kappa = (w * this.R - vl) / vref;
      const sx2 = kappa / this.kp, sN2 = Math.hypot(sx2, sy);
      if (sN2 > 1e-6) {
        const f2 = tyreCurve(sN2);
        const dS2 = Math.hypot(sx2 * LONG_W, sy);
        fx = (mux * Fz * f2 * sx2 * LONG_W) / dS2;
        const fy2 = (-muy * Fz * f2 * sy) / dS2;
        fy = Math.abs(fy2) > fyMax ? Math.sign(fy2) * fyMax : fy2;
      } else { fx = 0; }
      wh.kappa = kappa; wh.alpha = Math.atan(tanA); wh.fx = fx; wh.fy = fy; wh.vl = vl; wh.vt = vt; wh.slide = Math.hypot(w * this.R - vl, vt);
      wh.slip = Math.min(1.5, Math.max(Math.abs(kappa) / (this.kp * 2.2), Math.abs(sy) / 2.2) * smooth(0.5, 3, Math.hypot(vl, vt) + Math.abs(w * this.R - vl)));
      wh.spin += w * dt;
      maxSlip = Math.max(maxSlip, wh.slip);
      // rolling resistance of the surface
      const rr = this.crr * sf.roll * Fz * Math.tanh(vl * 2);
      // back to the car frame
      const fxc = (fx - rr) * c - fy * s;
      const fyc = (fx - rr) * s + fy * c;
      Fx += fxc; Fy += fyc;
      Mz += wh.px * fyc - wh.py * fxc;
    }
    this.maxSlip = maxSlip;
    this.absActive = absNow;
    // drift assist: a yaw servo that holds the slide at the angle the driver asks for.
    // Neutral steering holds half the maximum angle, steering into the slide adds angle,
    // counter-steering straightens the car out.
    this.drifting = 0;
    if (inp.handbrake > 0.3) this.hbTimer = 1.6; else if (this.hbTimer > 0) this.hbTimer -= dt;
    const intent = thr > 0.45 || this.hbTimer > 0;
    if (this.assist > 0 && u > 2 && spd > 4 && intent) {
      const beta = Math.atan2(v, u);
      const act = smooth(0.2, 0.33, Math.abs(beta));
      if (act > 0) {
        const d = Math.sign(beta);
        const bDes = d * this.driftMax * clamp(0.5 - 0.5 * d * inp.steer, 0, 1) * (thr > 0.3 ? 1 : 0.55);
        const aPerp = (Fx / m) * -Math.sin(beta) + (Fy / m) * Math.cos(beta);
        const rReq = aPerp / spd + 2.4 * (beta - bDes);
        Mz += act * this.assist * this.Iz * 6.5 * (rReq - r);
        this.drifting = act;
      }
    }
    // stability control: steer the yaw rate toward what the front wheels ask for
    this.escActive = false;
    if (this.esc && u > 4 && this.gear >= 0) {
      const rRef = (u * Math.tan(delta)) / this.WB;
      const rLim = (this.muY * G * 0.95) / u;
      const rT = clamp(rRef, -rLim, rLim);
      const beta = Math.atan2(v, u);
      const err = rT - r;
      const act = smooth(0.06, 0.16, Math.abs(err)) * (0.4 + 0.6 * smooth(0.03, 0.1, Math.abs(beta)));
      if (act > 0.01) {
        Mz += act * this.Iz * 5 * err;
        this.escActive = act > 0.3;
      }
    }
    // aero drag and the pull of the hill
    const drag = 0.5 * RHO * this.CdA * spd;
    Fx -= drag * u; Fy -= drag * v;
    Fx += gSx; Fy += gSy;
    // ---------------- integrate the body
    const axc = Fx / m, ayc = Fy / m;
    u += (axc + r * v) * dt;
    v += (ayc - r * u) * dt;
    r += (Mz / this.Iz) * dt;
    // tiny damping keeps a parked car perfectly still
    if (spd < 0.05 && thr < 0.01 && Math.abs(r) < 0.02 && Math.abs(driveT) < this.m * 0.15 * this.R && (brk > 0.1 || inp.handbrake > 0.1 || Math.hypot(gSx, gSy) < this.m * 0.6)) { u *= 0.9; v *= 0.9; r *= 0.9; }
    this.u = u; this.v = v; this.r = r;
    this.psi += r * dt;
    const cp = Math.cos(this.psi), sp = Math.sin(this.psi);
    this.x += (u * cp - v * sp) * dt;
    this.y += (u * sp + v * cp) * dt;
    // felt accelerations, filtered like suspension would
    const k = Math.min(1, dt / 0.06);
    this.axF += (axc - this.axF) * k;
    this.ayF += (ayc - this.ayF) * k;
    this.scrapeV = 0; this.contacts.length = 0;
    if (world) this.collide(world, dt);
  }

  // Differential: split axle torque between two wheels; a limited-slip unit moves torque from
  // the faster wheel to the slower one.
  splitAxle(iL, iR, T, coupledI, dt) {
    const lsd = this.lsd, tq = this.tq;
    let Tc = 0;
    if (lsd.c > 0) {
      const dw = this.wheels[iL].w - this.wheels[iR].w;
      const lim = Math.min(lsd.pre + lsd.bias * Math.abs(T), (Math.abs(dw) * (this.Iw + coupledI)) / dt * 0.9);
      Tc = clamp(lsd.c * dw, -lim, lim);
    }
    tq[iL] += T / 2 - Tc / 2; tq[iR] += T / 2 + Tc / 2;
  }

  // ---------------------------------------------------------------- collisions with the world
  // The body outline as eight sample points (corners and edge mid-points). The same object is
  // refilled on every call.
  corners() {
    const cp = Math.cos(this.psi), sp = Math.sin(this.psi);
    const cx = this.x - this.xCg * cp, cy = this.y - this.xCg * sp;
    const hl = this.L / 2, hw = this.W / 2;
    const b = this.box, P = b.pts;
    b.cx = cx; b.cy = cy; b.cp = cp; b.sp = sp; b.hl = hl; b.hw = hw;
    const set = (i, lx, ly) => { P[i][0] = cx + lx * cp - ly * sp; P[i][1] = cy + lx * sp + ly * cp; };
    set(0, hl, hw); set(1, hl, -hw); set(2, -hl, -hw); set(3, -hl, hw); set(4, hl, 0); set(5, -hl, 0); set(6, 0, hw); set(7, 0, -hw);
    return b;
  }

  // Apply an impulse at world point (px, py) along normal n.
  impulse(px, py, nx, ny, depth, restitution = 0.25, fric = 0.35, ovx = 0, ovy = 0) {
    const cp = Math.cos(this.psi), sp = Math.sin(this.psi);
    this.x += nx * depth; this.y += ny * depth;
    const vx = this.u * cp - this.v * sp, vy = this.u * sp + this.v * cp;
    const rx = px - this.x, ry = py - this.y;
    // velocity of the contact point relative to the obstacle (which may be another car)
    const pvx = vx - this.r * ry - ovx, pvy = vy + this.r * rx - ovy;
    const vn = pvx * nx + pvy * ny;
    // scraping along the obstacle (for sparks and sound)
    this.scrapeV = Math.max(this.scrapeV, Math.abs(-pvx * ny + pvy * nx));
    if (this.contacts.length < 8) this.contacts.push(px, py);
    if (vn >= 0) return 0;
    // hard hits are plastic (crumple zones and tyre walls soak up the energy) and the body
    // spins up less than a rigid box would, as the impact is spread over time and structure
    const e = restitution * clamp(4 / -vn, 0.12, 1);
    const ang = 0.5;
    const rn = rx * ny - ry * nx;
    const j = (-(1 + e) * vn) / (1 / this.m + (ang * rn * rn) / this.Iz);
    let nvx = vx + (j * nx) / this.m, nvy = vy + (j * ny) / this.m;
    let nr = this.r + (ang * rn * j) / this.Iz;
    // friction along the wall
    const tx = -ny, ty = nx;
    const vt = pvx * tx + pvy * ty;
    const rt = rx * ty - ry * tx;
    let jt = -vt / (1 / this.m + (ang * rt * rt) / this.Iz);
    jt = clamp(jt, -fric * j, fric * j);
    nvx += (jt * tx) / this.m; nvy += (jt * ty) / this.m; nr += (ang * rt * jt) / this.Iz;
    this.u = nvx * cp + nvy * sp; this.v = -nvx * sp + nvy * cp; this.r = nr;
    return j / this.m;
  }

  collide(world, dt) {
    const box = this.corners();
    const hits = world.collide(box, this);
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const dv = this.impulse(h.px, h.py, h.nx, h.ny, h.depth, h.restitution ?? 0.22, h.friction ?? 0.35, h.vx || 0, h.vy || 0);
      if (dv > 0.6) this.events.push({ type: 'impact', dv, x: h.px, y: h.py, nx: h.nx, ny: h.ny, dyn: h.dyn });
    }
    void dt;
  }
}
