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
    this.muY = veh.muLat * (SUSP[cfg.suspension || 'stock'] || 0.93) * (cfg.widebody ? 1.02 : 1) * (cfg.spoiler === 'wing' ? 1.02 : 1);
    this.rollK = ROLL[cfg.suspension || 'stock'] || 1;
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
    // ---------------- loads with load transfer (filtered accelerations)
    const ax = this.axF, ay = this.ayF;
    const WB = this.WB, h = this.h, t = this.track;
    const FzF = (m * G * this.b) / WB - (m * ax * h) / WB;
    const FzR = (m * G * this.a) / WB + (m * ax * h) / WB;
    const dWf = (0.6 * m * ay * h) / t, dWr = (0.4 * m * ay * h) / t;
    // slope: gravity pulls along the hill and the tyres carry a little less weight
    let gSx = 0, gSy = 0, cosSl = 1;
    if (world && world.gradAt) {
      const gr = world.gradAt(this.x, this.y);
      cosSl = 1 / Math.sqrt(1 + gr[0] * gr[0] + gr[1] * gr[1]);
      const c0 = Math.cos(this.psi), s0 = Math.sin(this.psi);
      gSx = -m * G * (gr[0] * c0 + gr[1] * s0) * cosSl;
      gSy = -m * G * (-gr[0] * s0 + gr[1] * c0) * cosSl;
    }
    this.slopeF = gSx;
    const loads = [FzF / 2 - dWf, FzF / 2 + dWf, FzR / 2 - dWr, FzR / 2 + dWr].map((x) => Math.max(0, x * cosSl));
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
    const nDriven = this.driven.reduce((s, x) => s + x, 0);
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
        const wheelSlip = this.wheels.some((w) => this.driven[w.i] && w.kappa > 0.35);
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
    const tq = [0, 0, 0, 0];
    const lsd = this.lsd;
    const split = (iL, iR, T) => {
      const wl = this.wheels[iL].w, wr = this.wheels[iR].w;
      const dw = wl - wr;
      const Ieff = this.Iw + coupledI;
      let Tc = 0;
      if (lsd.c > 0) {
        const lim = Math.min(lsd.pre + lsd.bias * Math.abs(T), (Math.abs(dw) * Ieff) / dt * 0.9);
        Tc = clamp(lsd.c * dw, -lim, lim);
      }
      tq[iL] += T / 2 - Tc / 2; tq[iR] += T / 2 + Tc / 2;
    };
    if (this.drive === 'FWD') split(0, 1, driveT);
    else if (this.drive === 'RWD') split(2, 3, driveT);
    else {
      // centre coupling moves torque towards the slower axle
      const wf = (this.wheels[0].w + this.wheels[1].w) / 2, wr = (this.wheels[2].w + this.wheels[3].w) / 2;
      const dw = wf - wr;
      const lim = Math.min(60 + 0.5 * Math.abs(driveT), (Math.abs(dw) * (this.Iw * 2)) / dt * 0.9);
      const Tc = clamp(300 * dw, -lim, lim);
      split(0, 1, driveT * this.frontSplit - Tc);
      split(2, 3, driveT * (1 - this.frontSplit) + Tc);
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

  // ---------------------------------------------------------------- collisions with the world
  corners() {
    const cp = Math.cos(this.psi), sp = Math.sin(this.psi);
    const cx = this.x - this.xCg * cp, cy = this.y - this.xCg * sp;
    const hl = this.L / 2, hw = this.W / 2;
    const out = [];
    for (const [lx, ly] of [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw], [hl, 0], [-hl, 0], [0, hw], [0, -hw]]) out.push([cx + lx * cp - ly * sp, cy + lx * sp + ly * cp]);
    return { cx, cy, cp, sp, hl, hw, pts: out };
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
    for (const h of hits) {
      const dv = this.impulse(h.px, h.py, h.nx, h.ny, h.depth, h.restitution ?? 0.22, h.friction ?? 0.35, h.vx || 0, h.vy || 0);
      if (dv > 0.6) this.events.push({ type: 'impact', dv, x: h.px, y: h.py, nx: h.nx, ny: h.ny, dyn: h.dyn });
    }
    void dt;
  }
}
