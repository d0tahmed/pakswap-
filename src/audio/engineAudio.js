// Audio graph and the free-revving engine model that drives it.
import { EngineDSP, soundProfile, startParams } from './dsp.js';
import { torqueAt } from '../sim/powertrain.js';

export class EngineAudio {
  constructor() {
    this.ctx = null; this.node = null; this.dsp = null; this.ready = false; this.volume = 0.75; this.space = 'garage';
    this.pending = [];
  }

  async init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not available in this browser');
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.12;
    const lowShelf = ctx.createBiquadFilter(); lowShelf.type = 'lowshelf'; lowShelf.frequency.value = 140; lowShelf.gain.value = 4;
    const gain = ctx.createGain(); gain.gain.value = this.volume;
    // The synthesiser is bone dry. A real engine is always heard in a space: the hard walls of a
    // workshop, or the open road. A short convolution reverb (run natively by the browser, so it
    // costs nothing on the script side) supplies that room.
    const dry = ctx.createGain(); dry.gain.value = 1;
    const wet = ctx.createGain(); wet.gain.value = SPACES[this.space] ?? SPACES.garage;
    let conv = null;
    try { conv = ctx.createConvolver(); conv.buffer = roomImpulse(ctx); } catch (e) { conv = null; }
    lowShelf.connect(dry); dry.connect(comp);
    if (conv) { lowShelf.connect(conv); conv.connect(wet); wet.connect(comp); }
    comp.connect(gain); gain.connect(ctx.destination);
    this.out = gain; this.inp = lowShelf; this.wet = wet;
    let ok = false;
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      try {
        const src = `const EngineDSP = ${EngineDSP.toString()};
class PakSwapEngine extends AudioWorkletProcessor {
  constructor() { super(); this.dsp = new EngineDSP(sampleRate); this.port.onmessage = (e) => this.dsp.message(e.data); }
  process(inputs, outputs) { const o = outputs[0]; if (!o || !o[0]) return true; this.dsp.process(o[0], o[1] || new Float32Array(o[0].length), o[0].length); return true; }
}
registerProcessor('pakswap-engine', PakSwapEngine);`;
        // A page opened from disk (the desktop app, or the single HTML file) has an opaque origin,
        // and worklets refuse blob: URLs there. A data: URL loads everywhere, so it goes first.
        // Without this the synthesiser silently fell back to the main thread.
        const sources = [
          () => 'data:application/javascript;charset=utf-8,' + encodeURIComponent(src),
          () => URL.createObjectURL(new Blob([src], { type: 'application/javascript' })),
        ];
        let loaded = false;
        for (const make of sources) {
          try { await ctx.audioWorklet.addModule(make()); loaded = true; break; } catch (e) { /* try the next form */ }
        }
        if (!loaded) throw new Error('worklet module refused');
        this.node = new AudioWorkletNode(ctx, 'pakswap-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        this.post = (m) => this.node.port.postMessage(m);
        this.worklet = true;
        ok = true;
      } catch (e) { ok = false; }
    }
    if (!ok) {
      const dsp = new EngineDSP(ctx.sampleRate);
      const sp = ctx.createScriptProcessor(1024, 0, 2);
      sp.onaudioprocess = (ev) => { const b = ev.outputBuffer; dsp.process(b.getChannelData(0), b.getChannelData(1), b.length); };
      this.node = sp; this.dsp = dsp;
      this.post = (m) => dsp.message(m);
    }
    this.node.connect(this.inp);
    this.ready = true;
    for (const m of this.pending) this.post(m);
    this.pending = [];
    if (ctx.state === 'suspended') await ctx.resume();
  }

  send(m) { if (this.ready) this.post(m); else this.pending.push(m); }
  setProfile(engine, cfg, car) { this.send({ type: 'profile', profile: soundProfile(engine, cfg, car) }); }
  setState(s) { if (this.ready) this.post({ type: 'state', state: s }); }
  trigger(name, value) { if (this.ready) this.post({ type: 'trigger', name, value }); }
  setVolume(v) { this.volume = v; if (this.out) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  // 'garage' (studio) or 'open' (driving outdoors)
  setSpace(name) { this.space = name; if (this.wet) this.wet.gain.setTargetAtTime(SPACES[name] ?? SPACES.garage, this.ctx.currentTime, 0.25); }
}

const SPACES = { garage: 0.2, open: 0.06 };

// Impulse response of a medium hard-walled room: a handful of early reflections, then a diffuse
// tail that gets darker as it decays.
function roomImpulse(ctx) {
  const sr = ctx.sampleRate, len = Math.floor(sr * 1.15);
  const buf = ctx.createBuffer(2, len, sr);
  let seed = 20240917;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // diffuse tail starts after the first reflections; the low-pass closes over time
      const env = t < 0.012 ? 0 : Math.exp(-(t - 0.012) / 0.17);
      const k = 0.5 * Math.exp(-t / 0.35) + 0.06;
      lp += (rnd() - lp) * k;
      d[i] = lp * env * 0.6;
    }
    // early reflections off the floor, walls and ceiling (slightly different left and right)
    const taps = ch === 0 ? [[0.0071, 0.5], [0.0133, -0.36], [0.0212, 0.3], [0.0317, -0.22], [0.0441, 0.16]] : [[0.0083, 0.46], [0.0149, 0.34], [0.0237, -0.28], [0.0349, 0.2], [0.0473, -0.15]];
    for (const [tt, g] of taps) { const i = Math.floor(tt * sr); if (i < len) d[i] += g; }
  }
  return buf;
}

function smooth(a, b, x) { if (x <= a) return 0; if (x >= b) return 1; const t = (x - a) / (b - a); return t * t * (3 - 2 * t); }
const NONE = Object.freeze([]); // returned when there are no events, so idle frames allocate nothing

// Free-revving engine (neutral gear): throttle in, rpm/boost/cut events out.
// Phases: off -> glow (diesels) -> crank (starter turning the engine) -> flare (caught, revs
// jump) -> run (idle controller with cold fast-idle and hunting) -> coast (switched off).
export class RevSim {
  constructor() {
    this.rpm = 0; this.on = false; this.throttle = 0; this.thr = 0; this.boost = 0; this.cutT = 0;
    this.phase = 'off'; this.t = 0; this.runT = 99; this.kick = 0; this.coughIdx = 0;
    this.popWindow = 0; this.popTimer = 0; this.events = [];
    this.st = { kind: 'starter', crankRpm: 230, depth: 0.3, dur: 0.75, coughs: [], flare: 1.6, rise: 0.25, fastIdle: 0.15, fastTau: 2.5, hunt: 0, huntHz: 0.7, glow: 0 };
  }

  get running() { return this.on && this.phase === 'run'; }

  setEngine(engine, curve, cfg, car) {
    this.engine = engine; this.curve = curve; this.cfg = cfg;
    this.ev = engine.fuel === 'electric';
    this.redline = curve.redline;
    this.idle = this.ev ? 0 : curve.idle || 800;
    this.inertia = this.ev ? 0.05 : engine.orient === 'BIKE' ? 0.03 : engine.layout === 'R2' ? 0.06 : 0.03 + engine.cc * 0.000035;
    this.peakT = curve.peakNm || 100;
    this.boostM = curve.boost || { kind: 'none' };
    this.pops = !this.ev && engine.fuel !== 'diesel' && (cfg.exhaust === 'straight' || cfg.ecu === 's2' || cfg.ecu === 's3' || cfg.nitrous !== 'none' && cfg.nitrous != null);
    this.st = startParams(engine, cfg, car);
    if (this.on && this.phase === 'run' && this.rpm < this.idle) this.rpm = this.idle;
    if (this.ev && this.on) { this.phase = 'run'; }
  }

  start() {
    if (this.on) return;
    this.on = true; this.t = 0; this.coughIdx = 0; this.kick = 0; this.thr = 0; this.boost = 0;
    if (this.ev) { this.phase = 'run'; this.rpm = 0; this.runT = 99; this.events.push({ type: 'ready' }); return; }
    // every start is a little different, but keeps the car's own signature
    this.durNow = this.st.dur * (0.9 + Math.random() * 0.22);
    if (this.st.glow > 0) { this.phase = 'glow'; this.events.push({ type: 'click', v: 0.35 }); }
    else { this.phase = 'crank'; this.events.push({ type: 'click', v: 1 }); }
  }

  stop() {
    if (!this.on) return;
    this.on = false; this.throttle = 0;
    if (this.ev) { this.phase = 'off'; this.events.push({ type: 'poweroff' }); return; }
    if (this.phase === 'run' || this.phase === 'flare') { this.phase = 'coast'; this.t = 0; }
    else { this.phase = 'off'; }
  }

  idleTarget() {
    const st = this.st;
    const fast = 1 + (st.fastIdle || 0) * Math.exp(-this.runT / (st.fastTau || 2.5));
    const hunt = 1 + (st.hunt || 0) * 0.035 * Math.sin(2 * Math.PI * (st.huntHz || 0.7) * this.runT) * (0.6 + 0.4 * Math.exp(-this.runT / 6));
    return this.idle * fast * hunt;
  }

  step(dt) {
    const st = this.st;
    if (this.phase === 'off') {
      this.rpm = Math.max(0, this.rpm - this.rpm * 3.2 * dt - 300 * dt);
      this.thr += (0 - this.thr) * Math.min(1, dt * 10);
      this.boost *= Math.exp(-dt * 3);
      return { rpm: this.rpm, load: 0, boost: this.boost, cut: 0, on: 0, starter: 0, crank: 0 };
    }
    if (this.phase === 'glow') {
      this.t += dt;
      if (this.t >= st.glow) { this.phase = 'crank'; this.t = 0; this.events.push({ type: 'click', v: 1 }); }
      return { rpm: 0, load: 0, boost: 0, cut: 0, on: 0, starter: 0, crank: 0 };
    }
    if (this.phase === 'crank') {
      this.t += dt;
      // the needle twitches with every compression stroke
      const fComp = (st.crankRpm / 60) * ((this.engine.cyl || 4) / (this.engine.layout === 'R2' ? 1 : 2));
      const spin = Math.min(1, this.t / 0.12);
      this.kick *= Math.exp(-dt / 0.15);
      this.rpm = st.crankRpm * spin * (1 + 0.35 * this.kick) * (1 - st.depth * 0.45 * (0.5 + 0.5 * Math.sin(2 * Math.PI * fComp * this.t)));
      while (this.coughIdx < st.coughs.length && this.t >= st.coughs[this.coughIdx] * (this.durNow / st.dur)) {
        this.events.push({ type: 'cough' }); this.kick = 1; this.coughIdx++;
      }
      if (this.t >= this.durNow) {
        this.phase = 'flare'; this.t = 0; this.crankEnd = this.rpm;
        this.events.push({ type: 'catch' });
      }
      return { rpm: st.crankRpm * spin, load: 0, boost: 0, cut: 0, on: 0, starter: 1, crank: 1 };
    }
    if (this.phase === 'flare') {
      this.t += dt;
      const k = Math.min(1, this.t / st.rise);
      const e = 1 - Math.pow(1 - k, 3);
      const peak = this.idle * st.flare;
      this.rpm = this.crankEnd + (peak - this.crankEnd) * e;
      if (k >= 1) { this.phase = 'run'; this.runT = 0; this.rpm = peak; }
      return { rpm: this.rpm, load: 0.42 + 0.3 * (1 - k), boost: 0, cut: 0, on: 1, starter: this.t < 0.09 ? 1 : 0, crank: 0 };
    }
    if (this.phase === 'coast') {
      // fuel cut: the engine spins down through its own compression, then rocks to a stop
      this.t += dt;
      this.rpm = Math.max(0, this.rpm - (this.rpm * 2.6 + 260) * dt);
      if (this.rpm < 70) { this.phase = 'off'; this.rpm = 0; this.events.push({ type: 'shudder', v: this.engine.fuel === 'diesel' ? 1.2 : 0.85 }); }
      return { rpm: this.rpm, load: 0, boost: 0, cut: 0, on: 0, starter: 0, crank: this.rpm > 0 ? 1 : 0 };
    }
    // ---------------- run
    this.runT += dt;
    const prevThr = this.thr;
    this.thr += (this.throttle - this.thr) * Math.min(1, dt * (this.throttle > this.thr ? 14 : 9));
    const rpm = Math.max(1, this.rpm);
    let cut = 0;
    if (this.cutT > 0) { this.cutT -= dt; cut = 1; }
    if (!this.ev && rpm >= this.redline && this.cutT <= 0) { this.cutT = 0.07; cut = 1; if (this.pops && Math.random() < 0.6) this.events.push({ type: 'pop', v: 0.8 }); }
    // torque balance (neutral, so only engine inertia)
    let T = 0;
    let flareLoad = 0;
    if (this.ev) {
      const lim = this.redline * 0.55;
      T = cut ? 0 : torqueAt(this.curve, rpm) * this.thr * 0.35 * (rpm > lim ? 0 : 1);
      const drag = 4 + rpm * 0.0035;
      const w = (rpm * Math.PI) / 30;
      const wNew = Math.max(0, w + ((T - drag) / this.inertia) * dt * 0.6);
      this.rpm = (wNew * 30) / Math.PI;
    } else {
      const idleNow = this.idleTarget();
      flareLoad = 0.3 * Math.exp(-this.runT / 0.35);
      const bm = this.boostM;
      if (bm.kind === 'turbo' || bm.kind === 'twin') {
        const target = smooth(bm.from * 0.7, bm.to, rpm) * this.thr;
        this.boost += (target - this.boost) * Math.min(1, dt / (target > this.boost ? bm.tau * 1.2 : 0.18));
      } else if (bm.kind === 'sc') this.boost = smooth(500, 3000, rpm) * this.thr; else this.boost = 0;
      const boostFrac = bm.kind === 'turbo' || bm.kind === 'twin' ? 1 - bm.frac * (1 - Math.min(1, this.boost / Math.max(0.05, this.thr || 0.05))) * smooth(bm.from * 0.6, bm.to, rpm) : 1;
      const Rl = this.redline, pT = this.peakT;
      const fricOf = (r, th) => pT * (0.05 + 0.1 * (r / Rl)) + (1 - th) * pT * (0.36 * (r / Rl) + 0.04);
      const Tw = torqueAt(this.curve, rpm) * boostFrac * this.thr * 0.95;
      const Tidle = Math.max(0, fricOf(idleNow, 0) + (idleNow - rpm) * pT * 0.004);
      T = cut ? 0 : Math.max(Tw, Tidle);
      const fric = fricOf(rpm, this.thr);
      const Ieff = this.inertia * (this.engine.fuel === 'diesel' ? 3.2 : 1.6);
      const w = (rpm * Math.PI) / 30;
      const wNew = Math.max(0, w + ((T - fric) / Ieff) * dt);
      this.rpm = Math.max(idleNow * 0.88, (wNew * 30) / Math.PI);
      // lift-off events (once per lift)
      if (this.throttle > 0.3) this.lifted = false;
      if (!this.lifted && prevThr > 0.55 && this.throttle < 0.1) {
        this.lifted = true;
        if (this.boost > 0.35) this.events.push({ type: 'bov', v: this.boost });
        if (this.pops && rpm > 3000) { this.popWindow = 0.7 + Math.random() * 0.6; this.popTimer = 0.05; }
      }
      if (this.popWindow > 0) {
        this.popWindow -= dt; this.popTimer -= dt;
        if (this.popTimer <= 0 && this.throttle < 0.1 && this.rpm > 2200) { this.events.push({ type: 'pop', v: 0.6 + Math.random() * 0.6 }); this.popTimer = 0.06 + Math.random() * 0.16; }
      }
    }
    return { rpm: this.rpm, load: Math.max(this.thr, 0.08 + flareLoad), boost: Math.max(0, this.boost), cut, on: 1, starter: 0, crank: 0 };
  }

  drain() { if (!this.events.length) return NONE; const e = this.events; this.events = []; return e; }
}
