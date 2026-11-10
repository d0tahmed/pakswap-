// Engine sound synthesiser. Self-contained so the same class runs inside an AudioWorklet
// (via toString) or on the main thread through a ScriptProcessor fallback.
// Model: per-cylinder combustion pulses routed to one or two exhaust banks, each through a
// pipe comb resonance and a muffler low-pass, plus intake, turbo, supercharger, EV whine,
// pops, tyre and wind layers. Starting is modelled mechanically: the starter motor turns the
// crank, every compression stroke slows it (the "gar gar gar" of a cranking engine), exhaust
// strokes puff through the pipes, then the engine catches, flares and settles to idle.

export class EngineDSP {
  constructor(sr) {
    this.sr = sr;
    this.seed = 12345;
    this.profile = null;
    this.target = { rpm: 0, load: 0, boost: 0, cut: 0, slip: 0, speed: 0, on: 0, starter: 0, crank: 0, master: 0.8, surf: 0, rough: 0, scrape: 0, horn: 0, scrub: 0 };
    this.rpm = 0; this.load = 0; this.boost = 0; this.slip = 0; this.speed = 0; this.on = 0; this.starter = 0; this.crank = 0; this.master = 0.8;
    this.surf = 0; this.rough = 0; this.scrape = 0; this.horn = 0; this.scrub = 0;
    this.sqEnv = 0.8; this.sqWob = 0; this.kerbPh = 0; this.hornPh1 = 0; this.hornPh2 = 0; this.hits = []; this.gritA = 0;
    this.phase = 0;
    this.voices = [];
    for (let i = 0; i < 24; i++) this.voices.push({ t: 0, len: 1, amp: 0, delay: 0, bank: 0, active: false, noisy: 0 });
    this.bank = [this.mkBank(1), this.mkBank(0.93)];
    this.pops = [];
    this.bov = 0; this.bovPhase = 0;
    this.clat = 0; this.tick = 0;
    this.tPhase = 0; this.scPhase = 0; this.ev1 = 0; this.ev2 = 0; this.ev3 = 0;
    this.stPhase = 0; this.stBuzz = 0; this.stLow = 0; this.stHeld = false; this.overrun = 0; this.kick = 0;
    this.thump = 0; this.thumpPhase = 0;
    this.clickT = 9; this.clickAmp = 0;
    this.shudT = 9; this.shudAmp = 0;
    this.chimes = [];
    this.catchT = 99; this.lopePh = 0;
    this.f = {
      intake: this.mkBiquad(), turboNoise: this.mkBiquad(), bov: this.mkBiquad(), clat: this.mkBiquad(), tick: this.mkBiquad(),
      squeal: this.mkBiquad(), wind: this.mkBiquad(), popLp: this.mkBiquad(), body: this.mkBiquad(),
      sq1: this.mkBiquad(), sq2: this.mkBiquad(), sq3: this.mkBiquad(), scrubF: this.mkBiquad(), rumble: this.mkBiquad(), rumble2: this.mkBiquad(), grit: this.mkBiquad(),
      scrapeA: this.mkBiquad(), scrapeB: this.mkBiquad(), horn: this.mkBiquad(), hitLp: this.mkBiquad(), hitBp: this.mkBiquad(),
      stTone: this.mkBiquad(), stBuzz: this.mkBiquad(), stBrush: this.mkBiquad(), stGrowl: this.mkBiquad(), suck: this.mkBiquad(),
    };
    this.bovDecay = Math.exp(-1 / (sr * 0.16));
    this.cnt = 0;
    this.bias = [1];
  }

  mkBank(k) {
    const len = 4096;
    return { buf: new Float32Array(len), w: 0, lp: 0, d: 400 * k, k, muf1: this.mkBiquad(), muf2: this.mkBiquad(), rasp: this.mkBiquad(), env: 0, dc: { x: 0, y: 0 } };
  }

  mkBiquad() { return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: 0, x2: 0, y1: 0, y2: 0 }; }

  setLP(f, fc, q) {
    const w = (2 * Math.PI * Math.min(fc, this.sr * 0.45)) / this.sr;
    const al = Math.sin(w) / (2 * q); const c = Math.cos(w); const a0 = 1 + al;
    f.b0 = ((1 - c) / 2) / a0; f.b1 = (1 - c) / a0; f.b2 = ((1 - c) / 2) / a0; f.a1 = (-2 * c) / a0; f.a2 = (1 - al) / a0;
  }

  setBP(f, fc, q) {
    const w = (2 * Math.PI * Math.min(fc, this.sr * 0.45)) / this.sr;
    const al = Math.sin(w) / (2 * q); const c = Math.cos(w); const a0 = 1 + al;
    f.b0 = al / a0; f.b1 = 0; f.b2 = -al / a0; f.a1 = (-2 * c) / a0; f.a2 = (1 - al) / a0;
  }

  setHP(f, fc, q) {
    const w = (2 * Math.PI * Math.min(fc, this.sr * 0.45)) / this.sr;
    const al = Math.sin(w) / (2 * q); const c = Math.cos(w); const a0 = 1 + al;
    f.b0 = ((1 + c) / 2) / a0; f.b1 = -(1 + c) / a0; f.b2 = ((1 + c) / 2) / a0; f.a1 = (-2 * c) / a0; f.a2 = (1 - al) / a0;
  }

  bq(f, x) {
    const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
    f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
    return y;
  }

  rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
  noise() { return this.rnd() * 2 - 1; }

  message(m) {
    if (!m) return;
    if (m.type === 'profile') this.setProfile(m.profile);
    else if (m.type === 'state') Object.assign(this.target, m.state);
    else if (m.type === 'trigger') this.trigger(m.name, m.value);
  }

  setProfile(p) {
    this.profile = p;
    const n = p.offsets ? p.offsets.length : 0;
    this.bias = [];
    // per-engine cylinder imbalance: every engine has its own lumpy idle signature
    let s = (p.seed || 777) >>> 0;
    const spread = 0.1 + 0.16 * (p.rumble || 0.4) + 0.22 * (p.lope || 0);
    for (let i = 0; i < Math.max(1, n); i++) { s = (s * 1103515245 + 12345) >>> 0; this.bias.push(1 + ((s / 4294967296) - 0.5) * spread); }
    this.bank[0].d = Math.round(this.sr * (p.pipe || 0.0105));
    this.bank[1].d = Math.round(this.sr * (p.pipe || 0.0105) * 0.91);
    for (const b of this.bank) { b.buf.fill(0); b.lp = 0; }
  }

  spawn(amp, len, bank, delay, noisy) {
    let v = this.voices[0];
    for (let i = 0; i < this.voices.length; i++) if (!this.voices[i].active) { v = this.voices[i]; break; }
    v.active = true; v.t = 0; v.len = Math.max(8, len); v.amp = amp; v.bank = bank; v.delay = delay || 0; v.noisy = noisy || 0;
    return v;
  }

  trigger(name, v) {
    const sr = this.sr;
    if (name === 'pop') {
      const k = 1 + Math.floor(this.rnd() * 3);
      let t = 0;
      for (let i = 0; i < k; i++) { t += 0.012 + this.rnd() * 0.05; this.pops.push({ at: Math.round(t * sr), len: Math.round((0.01 + this.rnd() * 0.02) * sr), amp: (0.55 + this.rnd() * 0.6) * (v || 1), t: 0 }); }
    } else if (name === 'bov') {
      this.bov = Math.max(this.bov, Math.min(1.2, v || 1)); this.bovPhase = 0; this.bovFlutter = !!(this.profile && this.profile.flutter);
    } else if (name === 'shift') {
      this.thump = 0.5;
    } else if (name === 'click') {
      // starter solenoid (or glow relay when v is small)
      this.clickT = 0; this.clickAmp = v == null ? 1 : v;
    } else if (name === 'cough') {
      // a weak firing during cranking: the crank speeds up for a moment
      const p = this.profile || {};
      const k = 1 + Math.floor(this.rnd() * 2);
      for (let i = 0; i < k; i++) this.spawn((0.45 + this.rnd() * 0.45) * (v || 1), Math.round(sr * 0.006), p.banks ? i % 2 : 0, Math.round(sr * (i * (0.03 + this.rnd() * 0.04))), 0.3);
      this.kick = Math.min(0.9, this.kick + 0.45);
      if (this.rnd() < 0.5) this.pops.push({ at: Math.round(sr * 0.02), len: Math.round(sr * 0.012), amp: 0.35, t: 0 });
    } else if (name === 'catch') {
      this.catchT = 0; this.kick = 0;
    } else if (name === 'shudder') {
      this.shudT = 0; this.shudAmp = v == null ? 1 : v;
    } else if (name === 'ready') {
      // EV power-on: contactor clunk then a rising two-note chime
      this.clickT = 0; this.clickAmp = 0.55;
      this.chimes.push({ f: 784, at: Math.round(sr * 0.12), t: 0, a: 0.11 }, { f: 1175, at: Math.round(sr * 0.3), t: 0, a: 0.1 });
    } else if (name === 'impact') {
      // body hitting something: a deep thud, crunch and a metallic ring
      const a = Math.min(1.2, (v || 4) / 9);
      this.hits.push({ t: 0, a, f: 48 + this.rnd() * 18, ring: 900 + this.rnd() * 900, kind: 0 });
    } else if (name === 'cone') {
      this.hits.push({ t: 0, a: Math.min(0.6, 0.25 + (v || 5) / 40), f: 140 + this.rnd() * 40, ring: 650 + this.rnd() * 200, kind: 1 });
    } else if (name === 'poweroff') {
      this.chimes.push({ f: 1047, at: 0, t: 0, a: 0.09 }, { f: 698, at: Math.round(sr * 0.17), t: 0, a: 0.09 });
      this.clickT = -0.35; this.clickAmp = 0.4;
    }
  }

  process(L, R, n) {
    const p = this.profile;
    if (!p) { for (let i = 0; i < n; i++) { L[i] = 0; R[i] = 0; } return; }
    const sr = this.sr;
    const tg = this.target;
    const S = p.start || {};
    // block-rate smoothing
    const k = Math.min(1, n / (sr * 0.035));
    this.rpm += (tg.rpm - this.rpm) * Math.min(1, n / (sr * 0.02));
    this.load += (tg.load - this.load) * k;
    this.boost += (tg.boost - this.boost) * k;
    this.slip += (tg.slip - this.slip) * k;
    this.speed += (tg.speed - this.speed) * k;
    this.surf += ((tg.surf || 0) - this.surf) * k;
    this.rough += ((tg.rough || 0) - this.rough) * k;
    this.scrape += ((tg.scrape || 0) - this.scrape) * Math.min(1, n / (sr * 0.02));
    this.scrub += ((tg.scrub || 0) - this.scrub) * k;
    this.horn += ((tg.horn || 0) - this.horn) * Math.min(1, n / (sr * 0.012));
    this.on += (tg.on - this.on) * Math.min(1, n / (sr * 0.05));
    this.crank += ((tg.crank || 0) - this.crank) * Math.min(1, n / (sr * 0.04));
    const stT = tg.starter || 0;
    if (this.stHeld && stT < 0.5) this.overrun = 0.17; // key released: pinion is overrun by the engine for a moment
    this.stHeld = stT >= 0.5;
    this.starter += (stT - this.starter) * Math.min(1, n / (sr * (stT > this.starter ? 0.015 : 0.04)));
    this.master = tg.master;
    const ev = p.kind === 'ev';
    const rpm = Math.max(0, this.rpm);
    const rn = Math.min(1.3, rpm / Math.max(1000, p.redline));
    const load = this.load;
    const vtecOn = p.vtec && rpm > p.vtec ? 1 : 0;
    const bright = Math.min(1.4, (p.bright || 0.4) + vtecOn * 0.35);
    // exhaust filters per block
    const ex = p.exhaust || 'stock';
    const baseFc = (ex === 'straight' ? 1700 : ex === 'sport' ? 820 : 430) * (p.mufK || 1);
    const fc = baseFc * (0.7 + bright * 0.8) + rpm * (ex === 'straight' ? 0.42 : ex === 'sport' ? 0.2 : 0.09) * (0.6 + load * 0.6);
    for (const b of this.bank) {
      this.setLP(b.muf1, fc, 0.75);
      this.setLP(b.muf2, fc * 1.6, 0.6);
      this.setBP(b.rasp, 1400 + bright * 1600 + rpm * 0.25, 0.9);
    }
    const g = ex === 'straight' ? 0.52 : ex === 'sport' ? 0.44 : 0.34;
    const raspAmt = (ex === 'straight' ? 0.55 : ex === 'sport' ? 0.28 : 0.1) * (0.3 + bright) * (p.kind === 'rotary' ? 2.2 : 1) * (p.raspK || 1);
    const exGain = ex === 'straight' ? 1.6 : ex === 'sport' ? 1.15 : 0.75;
    this.setBP(this.f.intake, 220 + rpm * 0.11 * (1 + bright * 0.5), 1.3);
    this.setBP(this.f.body, (70 + rpm / 60 * (p.cyl || 4) / (p.cycleRevs || 2) * 0.5) * (p.bodyK || 1), 0.8);
    const tf = 1600 + this.boost * (p.bigTurbo ? 4200 : 6200) + rpm * 0.12;
    this.setBP(this.f.turboNoise, tf * 0.8, 3);
    this.setBP(this.f.bov, 2100 - this.bovPhase * 900, 1.1);
    this.setBP(this.f.clat, 2900, 1.2);
    this.setHP(this.f.tick, 4500, 0.7);
    this.setBP(this.f.squeal, 1350 + this.rnd() * 200, 6);
    // tyre squeal: resonances that wander with load and slip angle
    this.sqWob += (this.rnd() - 0.5) * 0.25; this.sqWob *= 0.94;
    const sqF = 760 + Math.min(1.2, this.slip) * 420 + this.sqWob * 140;
    this.setBP(this.f.sq1, sqF, 16);
    this.setBP(this.f.sq2, sqF * 2.06, 12);
    this.setBP(this.f.sq3, sqF * 3.1, 9);
    this.setBP(this.f.scrubF, 2300, 0.8);
    this.setLP(this.f.rumble, 70 + this.speed * 1.6, 0.8);
    this.setBP(this.f.rumble2, 260 + this.speed * 2, 0.9);
    this.setBP(this.f.grit, 3200, 1.2);
    this.setBP(this.f.scrapeA, 2900, 1.6);
    this.setBP(this.f.scrapeB, 720, 2.2);
    this.setBP(this.f.horn, 1150, 0.9);
    this.setLP(this.f.hitLp, 900, 0.7);
    this.setBP(this.f.hitBp, 1500, 2.5);
    this.setLP(this.f.wind, 500 + this.speed * 4, 0.6);
    this.setLP(this.f.popLp, 1100, 0.7);
    // starter filters
    const whine = S.whine || 220;
    this.setBP(this.f.stTone, whine * 2.6, 0.9);
    this.setBP(this.f.stBuzz, whine * 7.5, 1.4);
    this.setBP(this.f.stBrush, 3200, 0.8);
    this.setLP(this.f.stGrowl, 160, 0.9);
    this.setBP(this.f.suck, 380, 1.1);

    const cycleRevs = p.cycleRevs || 2;
    const cycHz = rpm / 60 / cycleRevs;
    const offsets = p.offsets || [];
    const nCyl = offsets.length;
    const interval = nCyl ? 1 / (cycHz * nCyl + 1e-6) : 1;
    const wCap = p.kind === 'rotary' ? 0.0028 : p.diesel ? 0.0035 : (p.pw || 0.0062);
    const width = Math.max(0.0007, Math.min(wCap, interval * (p.kind === 'rotary' ? 0.22 : 0.34)));
    const lenS = Math.max(8, Math.round(width * sr));
    const dPh = cycHz / sr;
    const cut = tg.cut;
    const on = this.on;
    const turboAmt = p.turbo ? (p.bigTurbo ? 0.22 : 0.15) : 0;
    const scAmt = p.sc ? 0.07 : 0;
    const intakeAmt = (p.itb ? 0.5 : p.cai ? 0.28 : 0.14) * (0.25 + bright * 0.6) * (p.intakeK || 1);
    const mono = p.banks ? 0.55 : 1;
    const diesel = p.diesel ? 1 : 0;
    const idle = p.idle || 800;
    // compression modulation is strong at cranking speed and fades as the engine spins faster
    const lowRpm = Math.max(0.12, Math.min(1, (950 - rpm) / 700));
    const crankAmt = this.crank;
    const depth = (S.depth || 0.3) * crankAmt * lowRpm;
    const chuffLen = Math.round(sr * (0.02 + 0.022 * lowRpm));
    const lopeAmt = (p.lope || 0) * Math.max(0, Math.min(1, (idle * 1.9 - rpm) / (idle * 0.9)));
    const misBase = S.misfire || 0.25;
    const heavy = S.heavy || 0.5;
    const grind = S.grind == null ? 0.5 : S.grind;
    const chuffAmt = (S.chuff || 0.35);
    const crankBase = Math.max(60, S.crankRpm || 220);

    for (let i = 0; i < n; i++) {
      let outL = 0, outR = 0;
      // ---------------- crank mechanics (starter or coasting without fuel)
      let spd = 1, strain = 0;
      if (nCyl && crankAmt > 0.01 && !ev) {
        const ic = 1 / nCyl;
        let gc = 0, ga = 0;
        for (let c = 0; c < nCyl; c++) {
          let d = this.phase - offsets[c]; d -= Math.round(d);
          const u = d / ic;
          const a = (u + 0.2) / 0.2, b = (u - 0.22) / 0.2;
          gc += Math.exp(-a * a); ga += Math.exp(-b * b);
        }
        strain = Math.min(1, gc);
        spd = (1 - depth * (gc - 0.55 * ga)) / (1 - depth * 0.16);
        spd = Math.max(0.22, spd) * (1 + this.kick);
      }
      if (this.kick > 0.0001) this.kick *= 0.99985;
      // ---------------- combustion and exhaust strokes
      if (!ev && nCyl && rpm > 30) {
        const prev = this.phase;
        this.phase += dPh * spd;
        let wrapped = false;
        if (this.phase >= 1) { this.phase -= 1; wrapped = true; }
        const cur = this.phase;
        for (let c = 0; c < nCyl; c++) {
          const o = offsets[c];
          if (on > 0.02 && (wrapped ? (o > prev || o <= cur) : (o > prev && o <= cur))) {
            let amp = (0.22 + 0.78 * load) * this.bias[c] * (1 + (this.rnd() - 0.5) * (0.16 + (1 - rn) * 0.2)) * on;
            if (cut > 0.5) amp *= 0.04;
            if (rpm < idle * 1.3 && p.kind === 'rotary') amp *= 0.6 + this.rnd() * 0.8;
            if (lopeAmt > 0) amp *= 1 + lopeAmt * (0.42 * Math.sin(this.lopePh * 2 * Math.PI) + 0.5 * (this.rnd() - 0.5));
            if (this.catchT < 1.5) { const pm = misBase * Math.exp(-this.catchT / 0.32); if (this.rnd() < pm) amp *= 0.08 + this.rnd() * 0.25; }
            this.spawn(amp, lenS, p.banks ? p.banks[c] : 0, Math.round((p.hdr ? p.hdr[c] : 0) * interval * sr), 0);
            this.clat = Math.max(this.clat, diesel * amp * (1.1 - rn * 0.6));
            this.tick = Math.max(this.tick, amp * 0.5 * (p.tickK || 1));
          }
          // exhaust stroke puffs while the crank turns without fuel
          if (crankAmt > 0.02 && on < 0.5) {
            let oe = o + 0.375; if (oe >= 1) oe -= 1;
            if (wrapped ? (oe > prev || oe <= cur) : (oe > prev && oe <= cur)) {
              const amp = crankAmt * chuffAmt * (0.65 + 0.55 * this.rnd()) * (0.45 + 0.55 * lowRpm) * this.bias[c];
              this.spawn(amp, chuffLen, p.banks ? p.banks[c] : 0, 0, 0.55);
              this.tick = Math.max(this.tick, 0.18 * crankAmt * (p.tickK || 1));
            }
          }
        }
      }
      if (this.catchT < 99) this.catchT += 1 / sr;
      this.lopePh += (p.lopeHz || 1.4) / sr; if (this.lopePh > 1) this.lopePh -= 1;
      // voices
      let b0 = 0, b1 = 0;
      for (let v = 0; v < this.voices.length; v++) {
        const vo = this.voices[v];
        if (!vo.active) continue;
        if (vo.delay > 0) { vo.delay--; continue; }
        const u = vo.t / vo.len;
        let s;
        if (u < 0.28) s = Math.sin((Math.PI / 2) * (u / 0.28));
        else { const w = Math.cos((Math.PI / 2) * ((u - 0.28) / 0.72)); s = w * w; }
        s *= vo.amp;
        if (vo.noisy) s *= 1 - vo.noisy + vo.noisy * (0.5 + 1.1 * this.rnd());
        if (vo.bank === 0) b0 += s; else b1 += s;
        vo.t++;
        if (vo.t >= vo.len) vo.active = false;
      }
      // pops in the exhaust
      let pop = 0;
      for (let q = this.pops.length - 1; q >= 0; q--) {
        const pp = this.pops[q];
        if (pp.at > 0) { pp.at--; continue; }
        const u = pp.t / pp.len;
        pop += pp.amp * Math.exp(-u * 3) * (this.noise() * 0.8 + Math.sin(pp.t * 0.012) * 0.9);
        pp.t++;
        if (pp.t >= pp.len * 2.5) this.pops.splice(q, 1);
      }
      if (pop !== 0) pop = this.bq(this.f.popLp, pop) * 2.2;
      // exhaust banks
      const bankIn = [b0 + pop * 0.6, b1 + pop * 0.6];
      for (let bi = 0; bi < 2; bi++) {
        const bk = this.bank[bi];
        let x = bankIn[bi];
        bk.env += (Math.abs(x) - bk.env) * 0.004;
        const turb = this.noise() * bk.env * raspAmt;
        x += this.bq(bk.rasp, turb) * 1.5;
        // pipe resonance
        const rd = bk.buf[(bk.w - bk.d + bk.buf.length) & (bk.buf.length - 1)];
        bk.lp += (rd - bk.lp) * 0.45;
        const y = x + g * bk.lp;
        bk.buf[bk.w] = y; bk.w = (bk.w + 1) & (bk.buf.length - 1);
        let m = this.bq(bk.muf1, y);
        m = this.bq(bk.muf2, m);
        // DC blocker
        const dc = m - bk.dc.x + 0.995 * bk.dc.y; bk.dc.x = m; bk.dc.y = dc;
        if (bi === 0) { outL += dc * exGain; outR += dc * exGain * mono; } else { outR += dc * exGain; outL += dc * exGain * mono; }
      }
      // body resonance for rumble
      const body = this.bq(this.f.body, b0 + b1) * (0.5 + (p.rumble || 0.4)) * 0.9 * (p.bodyGain || 1);
      outL += body; outR += body;
      // intake roar
      const env = Math.min(1, (b0 + b1) * 1.2);
      const ia = this.bq(this.f.intake, this.noise()) * intakeAmt * (0.15 + load * 0.85) * (0.2 + rn) * (0.4 + env * 0.8) * on;
      outL += ia; outR += ia;
      // intake suction while cranking: air pulled through the throttle on every intake stroke
      if (crankAmt > 0.01 && !ev) {
        const sk = this.bq(this.f.suck, this.noise()) * crankAmt * (0.03 + 0.05 * (1 - strain)) * lowRpm;
        outL += sk; outR += sk;
      }
      // mechanical tick and diesel clatter
      if (this.tick > 0.001) { const t = this.bq(this.f.tick, this.noise()) * this.tick * 0.05 * (0.4 + rn); outL += t; outR += t; this.tick *= 0.88; }
      if (this.clat > 0.001) { const c = this.bq(this.f.clat, this.noise()) * this.clat * 0.55; outL += c; outR += c; this.clat *= 0.965; }
      // turbo
      if (turboAmt && on > 0.01) {
        this.tPhase += (tf / sr) * (1 + Math.sin(this.cnt * 0.0007) * 0.004);
        if (this.tPhase > 1) this.tPhase -= 1;
        const bst = Math.max(0, this.boost);
        const wh = Math.sin(this.tPhase * 2 * Math.PI) * Math.pow(bst, 1.6) * turboAmt * (0.3 + 0.7 * load);
        const hiss = this.bq(this.f.turboNoise, this.noise()) * bst * turboAmt * 1.2;
        outL += wh + hiss; outR += wh + hiss;
      }
      if (this.bov > 0.002) {
        let b = this.bq(this.f.bov, this.noise()) * this.bov * 0.9;
        if (this.bovFlutter) b *= 0.5 + 0.5 * Math.sin(this.bovPhase * 2 * Math.PI * 9);
        outL += b; outR += b;
        this.bovPhase += 1 / sr;
        if (this.bovPhase > 0.6) this.bov = 0;
        this.bov *= this.bovDecay || 0.9997;
      }
      // supercharger whine
      if (scAmt && on > 0.01) {
        this.scPhase += (rpm / 60) * 13 / sr; if (this.scPhase > 1) this.scPhase -= 1;
        const s = (Math.sin(this.scPhase * 2 * Math.PI) + 0.35 * Math.sin(this.scPhase * 4 * Math.PI)) * scAmt * Math.pow(rn, 1.3) * (0.4 + 0.6 * load);
        outL += s; outR += s;
      }
      // EV drive whine
      if (ev && on > 0.01) {
        const f1 = (rpm / 60) * 6, f2 = f1 * 3.17, f3 = 6800 + rpm * 0.05;
        this.ev1 += f1 / sr; this.ev2 += f2 / sr; this.ev3 += f3 / sr;
        if (this.ev1 > 1) this.ev1 -= 1; if (this.ev2 > 1) this.ev2 -= 1; if (this.ev3 > 1) this.ev3 -= 1;
        const a = (0.12 + 0.88 * load) * Math.min(1, rn * 4 + 0.05) * on;
        const s = (Math.sin(this.ev1 * 2 * Math.PI) * 0.16 + Math.sin(this.ev2 * 2 * Math.PI) * 0.06 + Math.sin(this.ev3 * 2 * Math.PI) * 0.012) * a * 2.4;
        const hum = Math.sin(this.cnt * 2 * Math.PI * 100 / sr) * 0.02 * on;
        outL += s + hum; outR += s * 0.96 + hum;
      }
      // ---------------- starter motor: geared to the crank, it slows and growls on every compression
      if (this.starter > 0.004 || this.overrun > 0) {
        let amt = this.starter, follow = 1 + (spd - 1) * 0.65;
        if (this.overrun > 0) {
          // engine has caught and drives the pinion faster: a short rising chirp before it lets go
          const ovk = this.overrun / 0.17;
          amt = Math.max(amt, 0.75 * ovk);
          follow = Math.min(4.5, Math.max(1, rpm / crankBase) * 0.55 + 0.6);
          this.overrun -= 1 / sr;
        }
        const fm = whine * follow * (1 - 0.1 * strain);
        this.stPhase += fm / sr; if (this.stPhase > 1) this.stPhase -= 1;
        this.stBuzz += (fm * 6) / sr; if (this.stBuzz > 1) this.stBuzz -= 1;
        this.stLow += (fm * 0.5) / sr; if (this.stLow > 1) this.stLow -= 1;
        const ph = this.stPhase * 2 * Math.PI;
        const tone = Math.sin(ph) * 0.5 + Math.sin(2 * ph + 0.4) * 0.3 + Math.sin(3 * ph + 1.1) * 0.2 + Math.sin(5 * ph) * 0.1;
        const toneF = this.bq(this.f.stTone, tone) * 1.6 + tone * 0.35;
        const buzz = this.bq(this.f.stBuzz, this.stBuzz < 0.5 ? 1 : -1) * grind;
        const brush = this.bq(this.f.stBrush, this.noise()) * (0.4 + 0.6 * grind) * (0.6 + 0.4 * follow);
        // strain growl: the starter labouring against compression (the deep "gar")
        const lowSaw = (this.stLow * 2 - 1) * 0.6 + Math.sin(this.stLow * 2 * Math.PI) * 0.4;
        const growl = this.bq(this.f.stGrowl, lowSaw) * strain * strain * heavy * 1.6;
        const level = amt * (0.55 + 0.75 * strain * (0.4 + heavy * 0.6));
        const s = (toneF * 0.085 + buzz * 0.05 + brush * 0.035) * level + growl * amt * 0.22;
        outL += s; outR += s * 0.97;
      }
      // solenoid / relay click
      if (this.clickT < 0.08) {
        if (this.clickT >= 0) {
          const t = this.clickT, a = this.clickAmp;
          const s = (this.noise() * Math.exp(-t / 0.0035) * 0.32 + Math.sin(2 * Math.PI * 1650 * t) * Math.exp(-t / 0.01) * 0.1 + Math.sin(2 * Math.PI * 92 * t) * Math.exp(-t / 0.028) * 0.24) * a;
          outL += s; outR += s;
        }
        this.clickT += 1 / sr;
      }
      // engine rocking back on its mounts as it stops
      if (this.shudT < 0.4) {
        const t = this.shudT;
        const s = (Math.sin(2 * Math.PI * 41 * t) * Math.exp(-t / 0.11) * 0.38 + this.noise() * Math.exp(-t / 0.035) * 0.05) * this.shudAmp;
        outL += s; outR += s;
        this.shudT += 1 / sr;
      }
      // EV chimes
      for (let q = this.chimes.length - 1; q >= 0; q--) {
        const ch = this.chimes[q];
        if (ch.at > 0) { ch.at--; continue; }
        const t = ch.t / sr;
        const e = Math.exp(-t / 0.32) * Math.min(1, t / 0.004);
        const s = (Math.sin(2 * Math.PI * ch.f * t) + 0.32 * Math.sin(2 * Math.PI * ch.f * 2.76 * t) * Math.exp(-t / 0.08)) * e * ch.a;
        outL += s; outR += s;
        ch.t++;
        if (t > 1.4) this.chimes.splice(q, 1);
      }
      // shift clunk
      if (this.thump > 0.001) { this.thumpPhase += 55 / sr; const s = Math.sin(this.thumpPhase * 2 * Math.PI) * this.thump * 0.3; outL += s; outR += s; this.thump *= 0.9993; } else this.thumpPhase = 0;
      // tyres: a tonal squeal when sliding on tarmac, scrub at the grip limit
      if (this.slip > 0.01 || this.scrub > 0.01) {
        const nz = this.noise();
        this.sqEnv += ((0.62 + 0.38 * this.rnd()) - this.sqEnv) * 0.0025;
        const sl = Math.min(1.3, this.slip);
        const amp = Math.pow(sl, 1.35) * this.sqEnv;
        const tone = this.bq(this.f.sq1, nz) * 2.6 + this.bq(this.f.sq2, nz) * 1.3 + this.bq(this.f.sq3, nz) * 0.5;
        const scr = this.bq(this.f.scrubF, nz) * (sl * 0.22 + this.scrub * 0.26);
        const s = tone * amp * 1.75 + scr;
        outL += s; outR += s * 0.96;
      }
      // grass, gravel and dirt under the tyres; kerb rumble strips
      if (this.surf > 0.01) {
        const nz = this.noise();
        const r = this.bq(this.f.rumble, nz) * this.surf * 1.5 + this.bq(this.f.rumble2, nz) * this.surf * 0.2;
        let g = 0;
        if (this.rnd() < this.surf * 0.004) this.gritA = 0.4 + this.rnd() * 0.6;
        if (this.gritA > 0.001) { g = this.bq(this.f.grit, this.noise()) * this.gritA * this.surf * 0.25; this.gritA *= 0.993; }
        outL += r + g; outR += r + g;
      }
      if (this.rough > 0.01 && this.speed > 3) {
        const fK = this.speed / 3.6 / 1.5;
        this.kerbPh += fK / sr;
        if (this.kerbPh > 1) this.kerbPh -= 1;
        const ph = this.kerbPh;
        const thud = ph < 0.3 ? Math.sin((ph / 0.3) * Math.PI) * Math.sin((2 * Math.PI * 85 * ph) / Math.max(1, fK)) : 0;
        const k2 = thud * this.rough * 0.45 + this.bq(this.f.rumble, this.noise()) * this.rough * 0.3;
        outL += k2; outR += k2;
      }
      // metal scraping along a wall
      if (this.scrape > 0.01) {
        const nz = this.noise();
        const s = (this.bq(this.f.scrapeA, nz) * 1.0 + this.bq(this.f.scrapeB, nz) * 0.7) * this.scrape * (0.55 + 0.45 * this.rnd());
        outL += s; outR += s;
      }
      // impacts
      for (let q = this.hits.length - 1; q >= 0; q--) {
        const h = this.hits[q];
        const t = h.t / sr;
        const thump = Math.sin(2 * Math.PI * h.f * t) * Math.exp(-t / (h.kind ? 0.05 : 0.16));
        const crunch = this.bq(this.f.hitLp, this.noise()) * Math.exp(-t / (h.kind ? 0.03 : 0.11)) * (h.kind ? 0.6 : 1.4);
        const ring = Math.sin(2 * Math.PI * h.ring * t) * Math.exp(-t / 0.09) * 0.12;
        const s = (thump * 0.9 + crunch + ring) * h.a * (h.kind ? 6 : 2.5);
        outL += s; outR += s;
        h.t++;
        if (t > 0.6) this.hits.splice(q, 1);
      }
      // horn: two slightly detuned reeds
      if (this.horn > 0.005) {
        this.hornPh1 += 415 / sr; this.hornPh2 += 497 / sr;
        if (this.hornPh1 > 1) this.hornPh1 -= 1; if (this.hornPh2 > 1) this.hornPh2 -= 1;
        const sq = (ph) => Math.tanh(Math.sin(2 * Math.PI * ph) * 3.2);
        const hs = this.bq(this.f.horn, sq(this.hornPh1) + sq(this.hornPh2) * 0.85) * this.horn * 0.42;
        outL += hs; outR += hs;
      }
      if (this.speed > 5) { const w = this.bq(this.f.wind, this.noise()) * Math.min(0.3, this.speed * this.speed * 0.000011); outL += w; outR += w * 0.94; }
      // master soft clip
      const mg = this.master * 0.9;
      const xl = outL * mg, xr = outR * mg;
      L[i] = xl / (1 + Math.abs(xl) * 0.6);
      R[i] = xr / (1 + Math.abs(xr) * 0.6);
      this.cnt++;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Profiles. Everything below runs on the main thread.

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const CARB = new Set(['suz-f8b', 'suz-g10', 'suz-g13ba', 'suz-f10a', 'dai-ed10']);
const BODY_GAIN = { van: 1.35, jeep: 1.2, pickup: 1.15, kei: 1.12, tallboy: 1.12, hatch: 1.05, hothatch: 1.0, sedan: 1.0, fastback: 0.95, suv: 1.05, bigsuv: 1.1 };

// How lumpy an engine idles: big cams, ITBs and V8s lope; economy engines are smooth.
function lopeOf(engine, cfg) {
  if (engine.fuel === 'electric') return 0;
  const lit = Math.max(0.6, (engine.cc || 1000) / 1000);
  const spec = (engine.hp || 60) / lit;
  let l = 0;
  if (engine.asp === 'NA') l = Math.max(0, Math.min(0.8, (spec - 78) / 50));
  else l = Math.max(0, Math.min(0.45, (spec - 110) / 120));
  if (engine.layout === 'V8') l = Math.max(l, 0.42);
  if (engine.layout === 'R2') l = Math.max(l, 0.55);
  if (cfg.intake === 'itb') l += 0.15;
  if (cfg.ecu === 's3') l += 0.12;
  return Math.min(0.9, l);
}

// Starting behaviour for one engine in one car. Deterministic per car + engine + exhaust,
// so every combination has its own signature start.
export function startParams(engine, cfg = {}, car = null) {
  const rnd = seeded(hash32(`${car ? car.id : 'none'}|${engine.id}|${cfg.exhaust || 'stock'}`));
  const r = (a, b) => a + (b - a) * rnd();
  const classicCar = car && car.era === 'classic';
  const carb = CARB.has(engine.id);
  const old = engine.era === 'old';
  const lope = lopeOf(engine, cfg);
  const cyl = engine.cyl || 4;
  const cc = engine.cc || 1200;
  const idle = engine.idle || 800;
  const sp = {
    kind: 'starter', crankRpm: 230, depth: 0.32, dur: 0.75, coughs: [], whine: 250, grind: 0.45, heavy: 0.5, chuff: 0.35,
    flare: 1.6, rise: 0.26, fastIdle: 0.16, fastTau: 2.6, hunt: 0.05, huntHz: 0.7, misfire: 0.14, glow: 0, coast: 1,
  };
  if (engine.fuel === 'electric') return { ...sp, kind: 'ev', dur: 0, flare: 1, fastIdle: 0, hunt: 0 };
  if (engine.fuel === 'hybrid') {
    // motor-generator spins the engine smoothly to ~1000 rpm, no starter whir
    Object.assign(sp, { kind: 'hybrid', crankRpm: r(880, 1050), depth: 0.07, dur: r(0.3, 0.42), whine: r(1450, 1900), grind: 0, heavy: 0.1, chuff: 0.18, flare: r(1.18, 1.32), rise: 0.22, fastIdle: 0.1, fastTau: 2, hunt: 0.02, misfire: 0.05 });
    return sp;
  }
  if (engine.orient === 'BIKE') {
    Object.assign(sp, { kind: 'bike', crankRpm: r(480, 580), depth: 0.2, dur: r(0.38, 0.62), whine: r(620, 760), grind: 0.85, heavy: 0.25, chuff: 0.28, flare: r(2.0, 2.4), rise: 0.17, fastIdle: 0.2, fastTau: 2.2, misfire: 0.1 });
  } else if (engine.layout === 'R2') {
    Object.assign(sp, { crankRpm: r(260, 300), depth: 0.2, dur: r(0.9, 1.35), whine: r(230, 270), grind: 0.55, heavy: 0.45, chuff: 0.4, flare: r(1.85, 2.2), rise: 0.24, fastIdle: 0.22, misfire: 0.5, hunt: 0.25, huntHz: 1.1 });
  } else if (engine.fuel === 'diesel') {
    const modern = !old;
    Object.assign(sp, {
      crankRpm: r(150, 175) - cc / 1000 * 3, depth: r(0.46, 0.56), dur: modern ? r(0.75, 1.1) : r(1.1, 1.7), whine: r(125, 165), grind: 0.7,
      heavy: Math.min(1, 0.75 + cc / 12000), chuff: 0.52, flare: r(1.22, 1.42), rise: 0.36, fastIdle: 0.1, fastTau: 3, misfire: 0.28, glow: modern ? 0.28 : 0.55, hunt: 0.06,
    });
  } else {
    Object.assign(sp, {
      crankRpm: 248 + (cyl <= 3 ? 26 : 0) - Math.min(70, cc / 1000 * 11),
      depth: cyl <= 3 ? 0.38 : cyl >= 8 ? 0.24 : cyl >= 6 ? 0.28 : 0.33,
      dur: carb ? r(1.35, 2.2) : old ? r(0.8, 1.25) : r(0.5, 0.88),
      whine: carb || old ? r(150, 195) : r(225, 300),
      grind: carb ? 0.95 : old ? 0.65 : 0.4,
      heavy: Math.min(1, 0.3 + cc / 6500),
      chuff: cyl >= 8 ? 0.46 : 0.35,
      flare: carb ? r(1.9, 2.2) : old ? r(1.6, 1.9) : r(1.45, 1.75),
      rise: cyl >= 8 ? 0.3 : 0.24,
      fastIdle: carb ? 0.34 : old ? 0.22 : 0.16,
      fastTau: carb ? 4.2 : 2.6,
      hunt: carb ? 0.6 : old ? 0.28 : 0.05,
      huntHz: r(0.55, 0.95),
      misfire: carb ? 0.45 : old ? 0.3 : 0.12,
    });
    if (carb) { const k = rnd() < 0.7 ? 2 : 1; for (let i = 0; i < k; i++) sp.coughs.push(r(0.35, 0.8)); }
    else if (old && rnd() < 0.45) sp.coughs.push(r(0.5, 0.85));
  }
  sp.crankRpm *= r(0.93, 1.07);
  if (classicCar) { sp.dur *= 1.22; sp.whine *= 0.88; sp.grind = Math.min(1, sp.grind * 1.25); if (!sp.coughs.length && rnd() < 0.5) sp.coughs.push(r(0.45, 0.8)); }
  sp.flare += lope * 0.25 + (cfg.exhaust === 'straight' ? 0.12 : 0);
  sp.hunt = Math.min(0.8, sp.hunt + lope * 0.3);
  sp.coughs.sort((a, b) => a - b);
  sp.coughs = sp.coughs.map((t) => t * sp.dur);
  sp.idle = idle;
  return sp;
}

// Firing layouts as fractions of one engine cycle, plus per-engine and per-car timbre.
export function soundProfile(engine, cfg = {}, car = null) {
  const s = engine.snd || { p: 'i4', b: 0.4, r: 0.4 };
  const eseed = hash32(engine.id);
  const er = seeded(eseed);
  const cr = seeded(hash32(car ? car.id : 'none'));
  const p = {
    kind: s.p === 'ev' ? 'ev' : s.p === 'rotary' ? 'rotary' : 'piston',
    redline: engine.fuel === 'electric' ? engine.ev.maxRpm : engine.redline,
    idle: engine.idle || 800,
    bright: s.b, rumble: s.r, vtec: s.vtec || 0,
    diesel: engine.fuel === 'diesel',
    exhaust: cfg.exhaust || 'stock',
    turbo: engine.asp === 'T' || engine.asp === 'TT' || engine.turbo || cfg.fi === 'turbo' || cfg.fi === 'bigturbo',
    bigTurbo: cfg.fi === 'bigturbo',
    sc: engine.asp === 'SC' || cfg.fi === 'sc',
    itb: cfg.intake === 'itb', cai: cfg.intake === 'cai',
    flutter: false,
    cycleRevs: 2,
    pipe: 0.0105,
    cyl: engine.cyl || 4,
    seed: eseed,
  };
  const even = (n) => Array.from({ length: n }, (_, i) => i / n);
  switch (s.p) {
    case 'i3': p.offsets = even(3); p.pipe = 0.009; break;
    case 'i4': case 'd4': p.offsets = even(4); break;
    case 'bike': p.offsets = even(4); p.pipe = 0.006; p.bright = Math.max(p.bright, 0.75); break;
    case 'i6': case 'd6': p.offsets = even(6); p.pipe = 0.012; break;
    case 'v6': p.offsets = even(6); p.banks = [0, 1, 0, 1, 0, 1]; p.pipe = 0.0115; break;
    case 'v8': p.offsets = even(8); p.banks = [0, 1, 1, 0, 1, 0, 0, 1]; p.pipe = 0.0135; break;
    case 'boxer': p.offsets = even(4); p.banks = [0, 1, 0, 1]; p.hdr = [0, 0.24, 0.06, 0.3]; p.pipe = 0.011; break;
    case 'rotary': p.offsets = [0, 0.5]; p.cycleRevs = 1; p.pipe = 0.008; p.cyl = 2; break;
    case 'ev': p.offsets = []; break;
    default: p.offsets = even(engine.cyl || 4);
  }
  if (s.p === 'd4' || s.p === 'd6') p.diesel = true;
  // engine character: header length, intake, rasp and valve-train tick differ engine to engine
  const ccCyl = (engine.cc || 1200) / Math.max(1, engine.cyl || 4);
  p.pipe *= 0.92 + er() * 0.16;
  p.pw = 0.0042 + Math.min(0.004, ccCyl / 1000 * 0.0042);
  p.intakeK = 0.8 + er() * 0.45;
  p.raspK = 0.8 + er() * 0.5;
  p.tickK = (engine.era === 'old' ? 1.35 : 0.9) * (0.8 + er() * 0.4);
  p.lope = lopeOf(engine, cfg);
  p.lopeHz = 1.1 + er() * 0.9;
  // the car: longer cars run longer exhausts, bodies boom differently, mufflers vary
  if (car) {
    const len = (car.dims ? car.dims[0] : 4200) / 1000;
    p.pipe *= Math.sqrt(len / 4.2);
    p.mufK = 0.86 + cr() * 0.3;
    p.bodyK = Math.pow(4.2 / len, 0.6) * (0.92 + cr() * 0.16);
    p.bodyGain = BODY_GAIN[car.body] || 1;
  }
  p.start = startParams(engine, cfg, car);
  return p;
}
