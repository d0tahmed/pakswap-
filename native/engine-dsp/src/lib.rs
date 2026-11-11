//! Engine sound synthesiser core. A line-for-line port of `EngineDSP.process` in
//! `src/audio/dsp.js`, compiled to WebAssembly and run inside the AudioWorklet. The JavaScript
//! class stays as the reference implementation and as the fallback where WebAssembly is not
//! available; `test/dsp-parity.mjs` checks that both produce the same samples.
//!
//! Memory layout shared with JavaScript (all little endian, see `exports` at the bottom):
//!   params  [f64; 64]   profile scalars, index constants below
//!   arrays  [f64; 48]   offsets[16], banks[16], hdr[16]
//!   target  [f64; 16]   live state written by the main thread
//!   out_l / out_r [f32; 4096]
#![allow(clippy::needless_range_loop, clippy::too_many_lines, static_mut_refs)]

use core::f64::consts::PI;

const BUF: usize = 4096;
const MAXN: usize = 4096;

// params indices
const P_KIND: usize = 0; // 0 piston, 1 rotary, 2 ev
const P_REDLINE: usize = 1;
const P_IDLE: usize = 2;
const P_BRIGHT: usize = 3;
const P_RUMBLE: usize = 4;
const P_VTEC: usize = 5;
const P_DIESEL: usize = 6;
const P_EXHAUST: usize = 7; // 0 stock, 1 sport, 2 straight
const P_TURBO: usize = 8;
const P_BIGTURBO: usize = 9;
const P_SC: usize = 10;
const P_ITB: usize = 11;
const P_CAI: usize = 12;
const P_FLUTTER: usize = 13;
const P_CYCLEREVS: usize = 14;
const P_PIPE: usize = 15;
const P_CYL: usize = 16;
const P_SEED: usize = 17;
const P_NCYL: usize = 18; // number of entries in offsets
const P_HASBANKS: usize = 19;
const P_HASHDR: usize = 20;
const P_PW: usize = 21; // 0 = unset
const P_INTAKEK: usize = 22; // 0 = unset (1)
const P_RASPK: usize = 23;
const P_TICKK: usize = 24;
const P_LOPE: usize = 25;
const P_LOPEHZ: usize = 26; // 0 = unset (1.4)
const P_MUFK: usize = 27;
const P_BODYK: usize = 28;
const P_BODYGAIN: usize = 29;
const P_HASPROFILE: usize = 30;
// start block (0 = unset, JS defaults applied)
const S_DEPTH: usize = 32;
const S_MISFIRE: usize = 33;
const S_HEAVY: usize = 34;
const S_GRIND: usize = 35; // -1 = unset (0.5)
const S_CHUFF: usize = 36;
const S_CRANKRPM: usize = 37;
const S_WHINE: usize = 38;

// target indices
const T_RPM: usize = 0;
const T_LOAD: usize = 1;
const T_BOOST: usize = 2;
const T_CUT: usize = 3;
const T_SLIP: usize = 4;
const T_SPEED: usize = 5;
const T_ON: usize = 6;
const T_STARTER: usize = 7;
const T_CRANK: usize = 8;
const T_MASTER: usize = 9;
const T_SURF: usize = 10;
const T_ROUGH: usize = 11;
const T_SCRAPE: usize = 12;
const T_HORN: usize = 13;
const T_SCRUB: usize = 14;

#[derive(Clone, Copy, Default)]
struct Bq { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64, x1: f64, x2: f64, y1: f64, y2: f64 }
impl Bq {
    const fn new() -> Self { Bq { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 } }
    #[inline(always)]
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1; self.x1 = x; self.y2 = self.y1; self.y1 = y;
        y
    }
    fn lp(&mut self, sr: f64, fc: f64, q: f64) {
        let w = (2.0 * PI * fc.min(sr * 0.45)) / sr;
        let al = w.sin() / (2.0 * q); let c = w.cos(); let a0 = 1.0 + al;
        self.b0 = ((1.0 - c) / 2.0) / a0; self.b1 = (1.0 - c) / a0; self.b2 = ((1.0 - c) / 2.0) / a0; self.a1 = (-2.0 * c) / a0; self.a2 = (1.0 - al) / a0;
    }
    fn bp(&mut self, sr: f64, fc: f64, q: f64) {
        let w = (2.0 * PI * fc.min(sr * 0.45)) / sr;
        let al = w.sin() / (2.0 * q); let c = w.cos(); let a0 = 1.0 + al;
        self.b0 = al / a0; self.b1 = 0.0; self.b2 = -al / a0; self.a1 = (-2.0 * c) / a0; self.a2 = (1.0 - al) / a0;
    }
    fn hp(&mut self, sr: f64, fc: f64, q: f64) {
        let w = (2.0 * PI * fc.min(sr * 0.45)) / sr;
        let al = w.sin() / (2.0 * q); let c = w.cos(); let a0 = 1.0 + al;
        self.b0 = ((1.0 + c) / 2.0) / a0; self.b1 = -(1.0 + c) / a0; self.b2 = ((1.0 + c) / 2.0) / a0; self.a1 = (-2.0 * c) / a0; self.a2 = (1.0 - al) / a0;
    }
}

#[derive(Clone, Copy)]
struct Voice { t: f64, len: f64, amp: f64, delay: f64, bank: usize, active: bool, noisy: f64 }
#[derive(Clone, Copy)]
struct Pop { at: f64, len: f64, amp: f64, t: f64 }
#[derive(Clone, Copy)]
struct Chime { f: f64, at: f64, t: f64, a: f64 }
#[derive(Clone, Copy)]
struct Hit { t: f64, a: f64, f: f64, ring: f64, kind: bool }

struct Bank { buf: [f32; BUF], w: usize, lp: f64, d: usize, muf1: Bq, muf2: Bq, rasp: Bq, env: f64, dcx: f64, dcy: f64 }
impl Bank { const fn new() -> Self { Bank { buf: [0.0; BUF], w: 0, lp: 0.0, d: 400, muf1: Bq::new(), muf2: Bq::new(), rasp: Bq::new(), env: 0.0, dcx: 0.0, dcy: 0.0 } } }

struct Dsp {
    sr: f64, seed: u32,
    rpm: f64, load: f64, boost: f64, slip: f64, speed: f64, on: f64, starter: f64, crank: f64, master: f64,
    surf: f64, rough: f64, scrape: f64, horn: f64, scrub: f64,
    sq_env: f64, sq_wob: f64, kerb_ph: f64, horn_ph1: f64, horn_ph2: f64, grit_a: f64,
    phase: f64,
    voices: [Voice; 24],
    bank: [Bank; 2],
    pops: Vec<Pop>, chimes: Vec<Chime>, hits: Vec<Hit>,
    bov: f64, bov_phase: f64, bov_flutter: bool,
    clat: f64, tick: f64,
    t_phase: f64, sc_phase: f64, ev1: f64, ev2: f64, ev3: f64,
    st_phase: f64, st_buzz: f64, st_low: f64, st_held: bool, overrun: f64, kick: f64,
    thump: f64, thump_phase: f64,
    click_t: f64, click_amp: f64, shud_t: f64, shud_amp: f64,
    catch_t: f64, lope_ph: f64,
    f_intake: Bq, f_turbo: Bq, f_bov: Bq, f_clat: Bq, f_tick: Bq, f_squeal: Bq, f_wind: Bq, f_pop: Bq, f_body: Bq,
    f_sq1: Bq, f_sq2: Bq, f_sq3: Bq, f_scrub: Bq, f_rumble: Bq, f_rumble2: Bq, f_grit: Bq,
    f_scrape_a: Bq, f_scrape_b: Bq, f_horn: Bq, f_hit_lp: Bq, f_hit_bp: Bq,
    f_st_tone: Bq, f_st_buzz: Bq, f_st_brush: Bq, f_st_growl: Bq, f_suck: Bq,
    bov_decay: f64, cnt: f64,
    bias: [f64; 16], nbias: usize,
}

static mut PARAMS: [f64; 64] = [0.0; 64];
static mut ARRAYS: [f64; 48] = [0.0; 48];
static mut TARGET: [f64; 16] = [0.0; 16];
static mut OUT_L: [f32; MAXN] = [0.0; MAXN];
static mut OUT_R: [f32; MAXN] = [0.0; MAXN];
static mut DSP: Option<Box<Dsp>> = None;

impl Dsp {
    fn new(sr: f64) -> Box<Dsp> {
        let v = Voice { t: 0.0, len: 1.0, amp: 0.0, delay: 0.0, bank: 0, active: false, noisy: 0.0 };
        let mut d = Box::new(Dsp {
            sr, seed: 12345,
            rpm: 0.0, load: 0.0, boost: 0.0, slip: 0.0, speed: 0.0, on: 0.0, starter: 0.0, crank: 0.0, master: 0.8,
            surf: 0.0, rough: 0.0, scrape: 0.0, horn: 0.0, scrub: 0.0,
            sq_env: 0.8, sq_wob: 0.0, kerb_ph: 0.0, horn_ph1: 0.0, horn_ph2: 0.0, grit_a: 0.0,
            phase: 0.0, voices: [v; 24], bank: [Bank::new(), Bank::new()],
            pops: Vec::with_capacity(64), chimes: Vec::with_capacity(8), hits: Vec::with_capacity(16),
            bov: 0.0, bov_phase: 0.0, bov_flutter: false, clat: 0.0, tick: 0.0,
            t_phase: 0.0, sc_phase: 0.0, ev1: 0.0, ev2: 0.0, ev3: 0.0,
            st_phase: 0.0, st_buzz: 0.0, st_low: 0.0, st_held: false, overrun: 0.0, kick: 0.0,
            thump: 0.0, thump_phase: 0.0, click_t: 9.0, click_amp: 0.0, shud_t: 9.0, shud_amp: 0.0,
            catch_t: 99.0, lope_ph: 0.0,
            f_intake: Bq::new(), f_turbo: Bq::new(), f_bov: Bq::new(), f_clat: Bq::new(), f_tick: Bq::new(), f_squeal: Bq::new(), f_wind: Bq::new(), f_pop: Bq::new(), f_body: Bq::new(),
            f_sq1: Bq::new(), f_sq2: Bq::new(), f_sq3: Bq::new(), f_scrub: Bq::new(), f_rumble: Bq::new(), f_rumble2: Bq::new(), f_grit: Bq::new(),
            f_scrape_a: Bq::new(), f_scrape_b: Bq::new(), f_horn: Bq::new(), f_hit_lp: Bq::new(), f_hit_bp: Bq::new(),
            f_st_tone: Bq::new(), f_st_buzz: Bq::new(), f_st_brush: Bq::new(), f_st_growl: Bq::new(), f_suck: Bq::new(),
            bov_decay: (-1.0 / (sr * 0.16)).exp(), cnt: 0.0, bias: [1.0; 16], nbias: 1,
        });
        d.bank[1].d = (400.0 * 0.93) as usize;
        unsafe { TARGET[T_MASTER] = 0.8; }
        d
    }

    #[inline(always)]
    fn rnd(&mut self) -> f64 { self.seed = self.seed.wrapping_mul(1664525).wrapping_add(1013904223); self.seed as f64 / 4294967296.0 }
    #[inline(always)]
    fn noise(&mut self) -> f64 { self.rnd() * 2.0 - 1.0 }

    fn set_profile(&mut self) {
        let p = unsafe { &PARAMS };
        let n = p[P_NCYL] as usize;
        let mut s: u32 = if p[P_SEED] != 0.0 { p[P_SEED] as u32 } else { 777 };
        let rumble = if p[P_RUMBLE] != 0.0 { p[P_RUMBLE] } else { 0.4 };
        let spread = 0.1 + 0.16 * rumble + 0.22 * p[P_LOPE];
        self.nbias = n.max(1);
        // the reference does this product in double precision (it exceeds 2^53, so it rounds) and
        // then keeps the low 32 bits: reproduce exactly that, not a true 32-bit multiply
        for i in 0..self.nbias.min(16) { s = ((s as f64 * 1103515245.0 + 12345.0) % 4294967296.0) as u32; self.bias[i] = 1.0 + ((s as f64 / 4294967296.0) - 0.5) * spread; }
        let pipe = if p[P_PIPE] != 0.0 { p[P_PIPE] } else { 0.0105 };
        self.bank[0].d = ((self.sr * pipe).round() as usize).min(BUF - 1);
        self.bank[1].d = ((self.sr * pipe * 0.91).round() as usize).min(BUF - 1);
        for b in self.bank.iter_mut() { b.buf = [0.0; BUF]; b.lp = 0.0; }
    }

    fn spawn(&mut self, amp: f64, len: f64, bank: usize, delay: f64, noisy: f64) {
        let mut idx = 0;
        for i in 0..24 { if !self.voices[i].active { idx = i; break; } }
        let v = &mut self.voices[idx];
        v.active = true; v.t = 0.0; v.len = len.max(8.0); v.amp = amp; v.bank = bank; v.delay = delay; v.noisy = noisy;
    }

    fn trigger(&mut self, id: i32, v: f64) {
        let sr = self.sr;
        let has = !v.is_nan();
        let vv = if has && v != 0.0 { v } else { 1.0 }; // JS: (v || 1)
        let p = unsafe { &PARAMS };
        match id {
            0 => { // pop
                let k = 1 + (self.rnd() * 3.0).floor() as i32;
                let mut t = 0.0;
                for _ in 0..k {
                    t += 0.012 + self.rnd() * 0.05;
                    let len = ((0.01 + self.rnd() * 0.02) * sr).round();
                    let amp = (0.55 + self.rnd() * 0.6) * vv;
                    self.pops.push(Pop { at: (t * sr).round(), len, amp, t: 0.0 });
                }
            }
            1 => { self.bov = self.bov.max(vv.min(1.2)); self.bov_phase = 0.0; self.bov_flutter = p[P_HASPROFILE] != 0.0 && p[P_FLUTTER] != 0.0; }
            2 => { self.thump = 0.5; }
            3 => { self.click_t = 0.0; self.click_amp = if has { v } else { 1.0 }; }
            4 => { // cough
                let k = 1 + (self.rnd() * 2.0).floor() as i32;
                for i in 0..k {
                    let amp = (0.45 + self.rnd() * 0.45) * vv;
                    let bank = if p[P_HASBANKS] != 0.0 { (i % 2) as usize } else { 0 };
                    let delay = (sr * (i as f64 * (0.03 + self.rnd() * 0.04))).round();
                    self.spawn(amp, (sr * 0.006).round(), bank, delay, 0.3);
                }
                self.kick = (self.kick + 0.45).min(0.9);
                if self.rnd() < 0.5 { self.pops.push(Pop { at: (sr * 0.02).round(), len: (sr * 0.012).round(), amp: 0.35, t: 0.0 }); }
            }
            5 => { self.catch_t = 0.0; self.kick = 0.0; }
            6 => { self.shud_t = 0.0; self.shud_amp = if has { v } else { 1.0 }; }
            7 => { // ready
                self.click_t = 0.0; self.click_amp = 0.55;
                self.chimes.push(Chime { f: 784.0, at: (sr * 0.12).round(), t: 0.0, a: 0.11 });
                self.chimes.push(Chime { f: 1175.0, at: (sr * 0.3).round(), t: 0.0, a: 0.1 });
            }
            8 => { // impact
                let a = ((if has && v != 0.0 { v } else { 4.0 }) / 9.0).min(1.2);
                let f = 48.0 + self.rnd() * 18.0; let ring = 900.0 + self.rnd() * 900.0;
                self.hits.push(Hit { t: 0.0, a, f, ring, kind: false });
            }
            9 => { // cone
                let a = (0.25 + (if has && v != 0.0 { v } else { 5.0 }) / 40.0).min(0.6);
                let f = 140.0 + self.rnd() * 40.0; let ring = 650.0 + self.rnd() * 200.0;
                self.hits.push(Hit { t: 0.0, a, f, ring, kind: true });
            }
            10 => { // poweroff
                self.chimes.push(Chime { f: 1047.0, at: 0.0, t: 0.0, a: 0.09 });
                self.chimes.push(Chime { f: 698.0, at: (sr * 0.17).round(), t: 0.0, a: 0.09 });
                self.click_t = -0.35; self.click_amp = 0.4;
            }
            _ => {}
        }
    }

    fn process(&mut self, n: usize) {
        let p = unsafe { PARAMS };
        let (out_l, out_r) = unsafe { (&mut OUT_L, &mut OUT_R) };
        if p[P_HASPROFILE] == 0.0 { for i in 0..n { out_l[i] = 0.0; out_r[i] = 0.0; } return; }
        let arr = unsafe { ARRAYS };
        let tg = unsafe { TARGET };
        let sr = self.sr;
        let nf = n as f64;
        let or = |v: f64, d: f64| if v != 0.0 { v } else { d };
        // block-rate smoothing
        let k = (nf / (sr * 0.035)).min(1.0);
        self.rpm += (tg[T_RPM] - self.rpm) * (nf / (sr * 0.02)).min(1.0);
        self.load += (tg[T_LOAD] - self.load) * k;
        self.boost += (tg[T_BOOST] - self.boost) * k;
        self.slip += (tg[T_SLIP] - self.slip) * k;
        self.speed += (tg[T_SPEED] - self.speed) * k;
        self.surf += (tg[T_SURF] - self.surf) * k;
        self.rough += (tg[T_ROUGH] - self.rough) * k;
        self.scrape += (tg[T_SCRAPE] - self.scrape) * (nf / (sr * 0.02)).min(1.0);
        self.scrub += (tg[T_SCRUB] - self.scrub) * k;
        self.horn += (tg[T_HORN] - self.horn) * (nf / (sr * 0.012)).min(1.0);
        self.on += (tg[T_ON] - self.on) * (nf / (sr * 0.05)).min(1.0);
        self.crank += (tg[T_CRANK] - self.crank) * (nf / (sr * 0.04)).min(1.0);
        let st_t = tg[T_STARTER];
        if self.st_held && st_t < 0.5 { self.overrun = 0.17; }
        self.st_held = st_t >= 0.5;
        self.starter += (st_t - self.starter) * (nf / (sr * (if st_t > self.starter { 0.015 } else { 0.04 }))).min(1.0);
        self.master = tg[T_MASTER];
        let kind = p[P_KIND] as i32;
        let ev = kind == 2;
        let rotary = kind == 1;
        let rpm = self.rpm.max(0.0);
        let rn = (rpm / p[P_REDLINE].max(1000.0)).min(1.3);
        let load = self.load;
        let vtec_on = if p[P_VTEC] != 0.0 && rpm > p[P_VTEC] { 1.0 } else { 0.0 };
        let bright = (or(p[P_BRIGHT], 0.4) + vtec_on * 0.35).min(1.4);
        let ex = p[P_EXHAUST] as i32;
        let base_fc = (if ex == 2 { 1700.0 } else if ex == 1 { 820.0 } else { 430.0 }) * or(p[P_MUFK], 1.0);
        let fc = base_fc * (0.7 + bright * 0.8) + rpm * (if ex == 2 { 0.42 } else if ex == 1 { 0.2 } else { 0.09 }) * (0.6 + load * 0.6);
        for b in self.bank.iter_mut() {
            b.muf1.lp(sr, fc, 0.75);
            b.muf2.lp(sr, fc * 1.6, 0.6);
            b.rasp.bp(sr, 1400.0 + bright * 1600.0 + rpm * 0.25, 0.9);
        }
        let g = if ex == 2 { 0.52 } else if ex == 1 { 0.44 } else { 0.34 };
        let rasp_amt = (if ex == 2 { 0.55 } else if ex == 1 { 0.28 } else { 0.1 }) * (0.3 + bright) * (if rotary { 2.2 } else { 1.0 }) * or(p[P_RASPK], 1.0);
        let ex_gain = if ex == 2 { 1.6 } else if ex == 1 { 1.15 } else { 0.75 };
        let cyl = or(p[P_CYL], 4.0);
        let cycle_revs = or(p[P_CYCLEREVS], 2.0);
        self.f_intake.bp(sr, 220.0 + rpm * 0.11 * (1.0 + bright * 0.5), 1.3);
        self.f_body.bp(sr, (70.0 + rpm / 60.0 * cyl / cycle_revs * 0.5) * or(p[P_BODYK], 1.0), 0.8);
        let big_turbo = p[P_BIGTURBO] != 0.0;
        let tf = 1600.0 + self.boost * (if big_turbo { 4200.0 } else { 6200.0 }) + rpm * 0.12;
        self.f_turbo.bp(sr, tf * 0.8, 3.0);
        self.f_bov.bp(sr, 2100.0 - self.bov_phase * 900.0, 1.1);
        self.f_clat.bp(sr, 2900.0, 1.2);
        self.f_tick.hp(sr, 4500.0, 0.7);
        let r0 = self.rnd();
        self.f_squeal.bp(sr, 1350.0 + r0 * 200.0, 6.0);
        let r1 = self.rnd();
        self.sq_wob += (r1 - 0.5) * 0.25; self.sq_wob *= 0.94;
        let sq_f = 760.0 + self.slip.min(1.2) * 420.0 + self.sq_wob * 140.0;
        self.f_sq1.bp(sr, sq_f, 16.0);
        self.f_sq2.bp(sr, sq_f * 2.06, 12.0);
        self.f_sq3.bp(sr, sq_f * 3.1, 9.0);
        self.f_scrub.bp(sr, 2300.0, 0.8);
        self.f_rumble.lp(sr, 70.0 + self.speed * 1.6, 0.8);
        self.f_rumble2.bp(sr, 260.0 + self.speed * 2.0, 0.9);
        self.f_grit.bp(sr, 3200.0, 1.2);
        self.f_scrape_a.bp(sr, 2900.0, 1.6);
        self.f_scrape_b.bp(sr, 720.0, 2.2);
        self.f_horn.bp(sr, 1150.0, 0.9);
        self.f_hit_lp.lp(sr, 900.0, 0.7);
        self.f_hit_bp.bp(sr, 1500.0, 2.5);
        self.f_wind.lp(sr, 500.0 + self.speed * 4.0, 0.6);
        self.f_pop.lp(sr, 1100.0, 0.7);
        let whine = or(p[S_WHINE], 220.0);
        self.f_st_tone.bp(sr, whine * 2.6, 0.9);
        self.f_st_buzz.bp(sr, whine * 7.5, 1.4);
        self.f_st_brush.bp(sr, 3200.0, 0.8);
        self.f_st_growl.lp(sr, 160.0, 0.9);
        self.f_suck.bp(sr, 380.0, 1.1);

        let cyc_hz = rpm / 60.0 / cycle_revs;
        let n_cyl = (p[P_NCYL] as usize).min(16);
        let has_banks = p[P_HASBANKS] != 0.0;
        let has_hdr = p[P_HASHDR] != 0.0;
        let interval = if n_cyl > 0 { 1.0 / (cyc_hz * n_cyl as f64 + 1e-6) } else { 1.0 };
        let diesel_b = p[P_DIESEL] != 0.0;
        let w_cap = if rotary { 0.0028 } else if diesel_b { 0.0035 } else { or(p[P_PW], 0.0062) };
        let width = (0.0007f64).max(w_cap.min(interval * (if rotary { 0.22 } else { 0.34 })));
        let len_s = (8.0f64).max((width * sr).round());
        let d_ph = cyc_hz / sr;
        let cut = tg[T_CUT];
        let on = self.on;
        let turbo_amt = if p[P_TURBO] != 0.0 { if big_turbo { 0.22 } else { 0.15 } } else { 0.0 };
        let sc_amt = if p[P_SC] != 0.0 { 0.07 } else { 0.0 };
        let intake_amt = (if p[P_ITB] != 0.0 { 0.5 } else if p[P_CAI] != 0.0 { 0.28 } else { 0.14 }) * (0.25 + bright * 0.6) * or(p[P_INTAKEK], 1.0);
        let mono = if has_banks { 0.55 } else { 1.0 };
        let diesel = if diesel_b { 1.0 } else { 0.0 };
        let idle = or(p[P_IDLE], 800.0);
        let low_rpm = (0.12f64).max(((950.0 - rpm) / 700.0).min(1.0));
        let crank_amt = self.crank;
        let depth = or(p[S_DEPTH], 0.3) * crank_amt * low_rpm;
        let chuff_len = (sr * (0.02 + 0.022 * low_rpm)).round();
        let lope_amt = p[P_LOPE] * (0.0f64).max(((idle * 1.9 - rpm) / (idle * 0.9)).min(1.0));
        let mis_base = or(p[S_MISFIRE], 0.25);
        let heavy = or(p[S_HEAVY], 0.5);
        let grind = if p[S_GRIND] < 0.0 { 0.5 } else { p[S_GRIND] };
        let chuff_amt = or(p[S_CHUFF], 0.35);
        let crank_base = (60.0f64).max(or(p[S_CRANKRPM], 220.0));
        let tick_k = or(p[P_TICKK], 1.0);
        let rumble = or(p[P_RUMBLE], 0.4);
        let body_gain = or(p[P_BODYGAIN], 1.0);
        let lope_hz = or(p[P_LOPEHZ], 1.4);
        let mask = BUF - 1;

        for i in 0..n {
            let mut o_l = 0.0f64; let mut o_r = 0.0f64;
            // crank mechanics
            let mut spd = 1.0; let mut strain = 0.0;
            if n_cyl > 0 && crank_amt > 0.01 && !ev {
                let ic = 1.0 / n_cyl as f64;
                let mut gc = 0.0; let mut ga = 0.0;
                for c in 0..n_cyl {
                    let mut d = self.phase - arr[c]; d -= d.round();
                    // JS Math.round rounds half up; for the half-open range used here the difference
                    // from round-half-away-from-zero only matters at exactly -0.5
                    let u = d / ic;
                    let a = (u + 0.2) / 0.2; let b = (u - 0.22) / 0.2;
                    gc += (-a * a).exp(); ga += (-b * b).exp();
                }
                strain = gc.min(1.0);
                spd = (1.0 - depth * (gc - 0.55 * ga)) / (1.0 - depth * 0.16);
                spd = spd.max(0.22) * (1.0 + self.kick);
            }
            if self.kick > 0.0001 { self.kick *= 0.99985; }
            // combustion and exhaust strokes
            if !ev && n_cyl > 0 && rpm > 30.0 {
                let prev = self.phase;
                self.phase += d_ph * spd;
                let mut wrapped = false;
                if self.phase >= 1.0 { self.phase -= 1.0; wrapped = true; }
                let cur = self.phase;
                for c in 0..n_cyl {
                    let o = arr[c];
                    let hit = if wrapped { o > prev || o <= cur } else { o > prev && o <= cur };
                    if on > 0.02 && hit {
                        let bias = self.bias[c.min(15)];
                        let r = self.rnd();
                        let mut amp = (0.22 + 0.78 * load) * bias * (1.0 + (r - 0.5) * (0.16 + (1.0 - rn) * 0.2)) * on;
                        if cut > 0.5 { amp *= 0.04; }
                        if rpm < idle * 1.3 && rotary { amp *= 0.6 + self.rnd() * 0.8; }
                        if lope_amt > 0.0 { let rr = self.rnd(); amp *= 1.0 + lope_amt * (0.42 * (self.lope_ph * 2.0 * PI).sin() + 0.5 * (rr - 0.5)); }
                        if self.catch_t < 1.5 { let pm = mis_base * (-self.catch_t / 0.32).exp(); if self.rnd() < pm { amp *= 0.08 + self.rnd() * 0.25; } }
                        let bank = if has_banks { arr[16 + c] as usize } else { 0 };
                        let delay = ((if has_hdr { arr[32 + c] } else { 0.0 }) * interval * sr).round();
                        self.spawn(amp, len_s, bank, delay, 0.0);
                        self.clat = self.clat.max(diesel * amp * (1.1 - rn * 0.6));
                        self.tick = self.tick.max(amp * 0.5 * tick_k);
                    }
                    if crank_amt > 0.02 && on < 0.5 {
                        let mut oe = o + 0.375; if oe >= 1.0 { oe -= 1.0; }
                        let hit2 = if wrapped { oe > prev || oe <= cur } else { oe > prev && oe <= cur };
                        if hit2 {
                            let bias = self.bias[c.min(15)];
                            let amp = crank_amt * chuff_amt * (0.65 + 0.55 * self.rnd()) * (0.45 + 0.55 * low_rpm) * bias;
                            let bank = if has_banks { arr[16 + c] as usize } else { 0 };
                            self.spawn(amp, chuff_len, bank, 0.0, 0.55);
                            self.tick = self.tick.max(0.18 * crank_amt * tick_k);
                        }
                    }
                }
            }
            if self.catch_t < 99.0 { self.catch_t += 1.0 / sr; }
            self.lope_ph += lope_hz / sr; if self.lope_ph > 1.0 { self.lope_ph -= 1.0; }
            // voices
            let mut b0 = 0.0; let mut b1 = 0.0;
            for v in 0..24 {
                if !self.voices[v].active { continue; }
                if self.voices[v].delay > 0.0 { self.voices[v].delay -= 1.0; continue; }
                let u = self.voices[v].t / self.voices[v].len;
                let mut s = if u < 0.28 { ((PI / 2.0) * (u / 0.28)).sin() } else { let w = ((PI / 2.0) * ((u - 0.28) / 0.72)).cos(); w * w };
                s *= self.voices[v].amp;
                let nz = self.voices[v].noisy;
                if nz != 0.0 { let r = self.rnd(); s *= 1.0 - nz + nz * (0.5 + 1.1 * r); }
                if self.voices[v].bank == 0 { b0 += s; } else { b1 += s; }
                self.voices[v].t += 1.0;
                if self.voices[v].t >= self.voices[v].len { self.voices[v].active = false; }
            }
            // pops
            let mut pop = 0.0;
            let mut q = self.pops.len();
            while q > 0 {
                q -= 1;
                if self.pops[q].at > 0.0 { self.pops[q].at -= 1.0; continue; }
                let pp = self.pops[q];
                let u = pp.t / pp.len;
                let nzv = self.noise();
                pop += pp.amp * (-u * 3.0).exp() * (nzv * 0.8 + (pp.t * 0.012).sin() * 0.9);
                self.pops[q].t += 1.0;
                if self.pops[q].t >= pp.len * 2.5 { self.pops.remove(q); }
            }
            if pop != 0.0 { pop = self.f_pop.run(pop) * 2.2; }
            // exhaust banks
            let pop_in = pop * 0.6;
            for bi in 0..2 {
                let mut x = (if bi == 0 { b0 } else { b1 }) + pop_in;
                let nzv = self.noise();
                let bk = &mut self.bank[bi];
                bk.env += (x.abs() - bk.env) * 0.004;
                let turb = nzv * bk.env * rasp_amt;
                x += bk.rasp.run(turb) * 1.5;
                let rd = bk.buf[(bk.w + BUF - bk.d) & mask] as f64;
                bk.lp += (rd - bk.lp) * 0.45;
                let y = x + g * bk.lp;
                bk.buf[bk.w] = y as f32; bk.w = (bk.w + 1) & mask;
                let mut m = bk.muf1.run(y);
                m = bk.muf2.run(m);
                let dc = m - bk.dcx + 0.995 * bk.dcy; bk.dcx = m; bk.dcy = dc;
                if bi == 0 { o_l += dc * ex_gain; o_r += dc * ex_gain * mono; } else { o_r += dc * ex_gain; o_l += dc * ex_gain * mono; }
            }
            // body resonance
            let body = self.f_body.run(b0 + b1) * (0.5 + rumble) * 0.9 * body_gain;
            o_l += body; o_r += body;
            // intake roar
            let env = ((b0 + b1) * 1.2).min(1.0);
            let nzi = self.noise();
            let ia = self.f_intake.run(nzi) * intake_amt * (0.15 + load * 0.85) * (0.2 + rn) * (0.4 + env * 0.8) * on;
            o_l += ia; o_r += ia;
            if crank_amt > 0.01 && !ev {
                let nzs = self.noise();
                let sk = self.f_suck.run(nzs) * crank_amt * (0.03 + 0.05 * (1.0 - strain)) * low_rpm;
                o_l += sk; o_r += sk;
            }
            if self.tick > 0.001 { let nzt = self.noise(); let t = self.f_tick.run(nzt) * self.tick * 0.05 * (0.4 + rn); o_l += t; o_r += t; self.tick *= 0.88; }
            if self.clat > 0.001 { let nzc = self.noise(); let c = self.f_clat.run(nzc) * self.clat * 0.55; o_l += c; o_r += c; self.clat *= 0.965; }
            // turbo
            if turbo_amt != 0.0 && on > 0.01 {
                self.t_phase += (tf / sr) * (1.0 + (self.cnt * 0.0007).sin() * 0.004);
                if self.t_phase > 1.0 { self.t_phase -= 1.0; }
                let bst = self.boost.max(0.0);
                let wh = (self.t_phase * 2.0 * PI).sin() * bst.powf(1.6) * turbo_amt * (0.3 + 0.7 * load);
                let nzh = self.noise();
                let hiss = self.f_turbo.run(nzh) * bst * turbo_amt * 1.2;
                o_l += wh + hiss; o_r += wh + hiss;
            }
            if self.bov > 0.002 {
                let nzb = self.noise();
                let mut b = self.f_bov.run(nzb) * self.bov * 0.9;
                if self.bov_flutter { b *= 0.5 + 0.5 * (self.bov_phase * 2.0 * PI * 9.0).sin(); }
                o_l += b; o_r += b;
                self.bov_phase += 1.0 / sr;
                if self.bov_phase > 0.6 { self.bov = 0.0; }
                self.bov *= self.bov_decay;
            }
            // supercharger
            if sc_amt != 0.0 && on > 0.01 {
                self.sc_phase += (rpm / 60.0) * 13.0 / sr; if self.sc_phase > 1.0 { self.sc_phase -= 1.0; }
                let s = ((self.sc_phase * 2.0 * PI).sin() + 0.35 * (self.sc_phase * 4.0 * PI).sin()) * sc_amt * rn.powf(1.3) * (0.4 + 0.6 * load);
                o_l += s; o_r += s;
            }
            // EV whine
            if ev && on > 0.01 {
                let f1 = (rpm / 60.0) * 6.0; let f2 = f1 * 3.17; let f3 = 6800.0 + rpm * 0.05;
                self.ev1 += f1 / sr; self.ev2 += f2 / sr; self.ev3 += f3 / sr;
                if self.ev1 > 1.0 { self.ev1 -= 1.0; } if self.ev2 > 1.0 { self.ev2 -= 1.0; } if self.ev3 > 1.0 { self.ev3 -= 1.0; }
                let a = (0.12 + 0.88 * load) * (rn * 4.0 + 0.05).min(1.0) * on;
                let s = ((self.ev1 * 2.0 * PI).sin() * 0.16 + (self.ev2 * 2.0 * PI).sin() * 0.06 + (self.ev3 * 2.0 * PI).sin() * 0.012) * a * 2.4;
                let hum = (self.cnt * 2.0 * PI * 100.0 / sr).sin() * 0.02 * on;
                o_l += s + hum; o_r += s * 0.96 + hum;
            }
            // starter motor
            if self.starter > 0.004 || self.overrun > 0.0 {
                let mut amt = self.starter; let mut follow = 1.0 + (spd - 1.0) * 0.65;
                if self.overrun > 0.0 {
                    let ovk = self.overrun / 0.17;
                    amt = amt.max(0.75 * ovk);
                    follow = (4.5f64).min((1.0f64).max(rpm / crank_base) * 0.55 + 0.6);
                    self.overrun -= 1.0 / sr;
                }
                let fm = whine * follow * (1.0 - 0.1 * strain);
                self.st_phase += fm / sr; if self.st_phase > 1.0 { self.st_phase -= 1.0; }
                self.st_buzz += (fm * 6.0) / sr; if self.st_buzz > 1.0 { self.st_buzz -= 1.0; }
                self.st_low += (fm * 0.5) / sr; if self.st_low > 1.0 { self.st_low -= 1.0; }
                let ph = self.st_phase * 2.0 * PI;
                let tone = ph.sin() * 0.5 + (2.0 * ph + 0.4).sin() * 0.3 + (3.0 * ph + 1.1).sin() * 0.2 + (5.0 * ph).sin() * 0.1;
                let tone_f = self.f_st_tone.run(tone) * 1.6 + tone * 0.35;
                let buzz = self.f_st_buzz.run(if self.st_buzz < 0.5 { 1.0 } else { -1.0 }) * grind;
                let nzr = self.noise();
                let brush = self.f_st_brush.run(nzr) * (0.4 + 0.6 * grind) * (0.6 + 0.4 * follow);
                let low_saw = (self.st_low * 2.0 - 1.0) * 0.6 + (self.st_low * 2.0 * PI).sin() * 0.4;
                let growl = self.f_st_growl.run(low_saw) * strain * strain * heavy * 1.6;
                let level = amt * (0.55 + 0.75 * strain * (0.4 + heavy * 0.6));
                let s = (tone_f * 0.085 + buzz * 0.05 + brush * 0.035) * level + growl * amt * 0.22;
                o_l += s; o_r += s * 0.97;
            }
            // solenoid click
            if self.click_t < 0.08 {
                if self.click_t >= 0.0 {
                    let t = self.click_t; let a = self.click_amp;
                    let nzk = self.noise();
                    let s = (nzk * (-t / 0.0035).exp() * 0.32 + (2.0 * PI * 1650.0 * t).sin() * (-t / 0.01).exp() * 0.1 + (2.0 * PI * 92.0 * t).sin() * (-t / 0.028).exp() * 0.24) * a;
                    o_l += s; o_r += s;
                }
                self.click_t += 1.0 / sr;
            }
            // shudder
            if self.shud_t < 0.4 {
                let t = self.shud_t;
                let nzq = self.noise();
                let s = ((2.0 * PI * 41.0 * t).sin() * (-t / 0.11).exp() * 0.38 + nzq * (-t / 0.035).exp() * 0.05) * self.shud_amp;
                o_l += s; o_r += s;
                self.shud_t += 1.0 / sr;
            }
            // EV chimes
            let mut q = self.chimes.len();
            while q > 0 {
                q -= 1;
                if self.chimes[q].at > 0.0 { self.chimes[q].at -= 1.0; continue; }
                let ch = self.chimes[q];
                let t = ch.t / sr;
                let e = (-t / 0.32).exp() * (t / 0.004).min(1.0);
                let s = ((2.0 * PI * ch.f * t).sin() + 0.32 * (2.0 * PI * ch.f * 2.76 * t).sin() * (-t / 0.08).exp()) * e * ch.a;
                o_l += s; o_r += s;
                self.chimes[q].t += 1.0;
                if t > 1.4 { self.chimes.remove(q); }
            }
            // shift clunk
            if self.thump > 0.001 { self.thump_phase += 55.0 / sr; let s = (self.thump_phase * 2.0 * PI).sin() * self.thump * 0.3; o_l += s; o_r += s; self.thump *= 0.9993; } else { self.thump_phase = 0.0; }
            // tyres
            if self.slip > 0.01 || self.scrub > 0.01 {
                let nz = self.noise();
                let r = self.rnd();
                self.sq_env += ((0.62 + 0.38 * r) - self.sq_env) * 0.0025;
                let sl = self.slip.min(1.3);
                let amp = sl.powf(1.35) * self.sq_env;
                let tone = self.f_sq1.run(nz) * 2.6 + self.f_sq2.run(nz) * 1.3 + self.f_sq3.run(nz) * 0.5;
                let scr = self.f_scrub.run(nz) * (sl * 0.22 + self.scrub * 0.26);
                let s = tone * amp * 1.75 + scr;
                o_l += s; o_r += s * 0.96;
            }
            if self.surf > 0.01 {
                let nz = self.noise();
                let r = self.f_rumble.run(nz) * self.surf * 1.5 + self.f_rumble2.run(nz) * self.surf * 0.2;
                let mut gg = 0.0;
                if self.rnd() < self.surf * 0.004 { self.grit_a = 0.4 + self.rnd() * 0.6; }
                if self.grit_a > 0.001 { let nzg = self.noise(); gg = self.f_grit.run(nzg) * self.grit_a * self.surf * 0.25; self.grit_a *= 0.993; }
                o_l += r + gg; o_r += r + gg;
            }
            if self.rough > 0.01 && self.speed > 3.0 {
                let f_k = self.speed / 3.6 / 1.5;
                self.kerb_ph += f_k / sr;
                if self.kerb_ph > 1.0 { self.kerb_ph -= 1.0; }
                let ph = self.kerb_ph;
                let thud = if ph < 0.3 { ((ph / 0.3) * PI).sin() * ((2.0 * PI * 85.0 * ph) / f_k.max(1.0)).sin() } else { 0.0 };
                let nzr = self.noise();
                let k2 = thud * self.rough * 0.45 + self.f_rumble.run(nzr) * self.rough * 0.3;
                o_l += k2; o_r += k2;
            }
            if self.scrape > 0.01 {
                let nz = self.noise();
                let a = self.f_scrape_a.run(nz) * 1.0 + self.f_scrape_b.run(nz) * 0.7;
                let r = self.rnd();
                let s = a * self.scrape * (0.55 + 0.45 * r);
                o_l += s; o_r += s;
            }
            // impacts
            let mut q = self.hits.len();
            while q > 0 {
                q -= 1;
                let h = self.hits[q];
                let t = h.t / sr;
                let thump = (2.0 * PI * h.f * t).sin() * (-t / (if h.kind { 0.05 } else { 0.16 })).exp();
                let nzh = self.noise();
                let crunch = self.f_hit_lp.run(nzh) * (-t / (if h.kind { 0.03 } else { 0.11 })).exp() * (if h.kind { 0.6 } else { 1.4 });
                let ring = (2.0 * PI * h.ring * t).sin() * (-t / 0.09).exp() * 0.12;
                let s = (thump * 0.9 + crunch + ring) * h.a * (if h.kind { 6.0 } else { 2.5 });
                o_l += s; o_r += s;
                self.hits[q].t += 1.0;
                if t > 0.6 { self.hits.remove(q); }
            }
            // horn
            if self.horn > 0.005 {
                self.horn_ph1 += 415.0 / sr; self.horn_ph2 += 497.0 / sr;
                if self.horn_ph1 > 1.0 { self.horn_ph1 -= 1.0; } if self.horn_ph2 > 1.0 { self.horn_ph2 -= 1.0; }
                let a = ((2.0 * PI * self.horn_ph1).sin() * 3.2).tanh() + ((2.0 * PI * self.horn_ph2).sin() * 3.2).tanh() * 0.85;
                let hs = self.f_horn.run(a) * self.horn * 0.42;
                o_l += hs; o_r += hs;
            }
            if self.speed > 5.0 { let nzw = self.noise(); let w = self.f_wind.run(nzw) * (0.3f64).min(self.speed * self.speed * 0.000011); o_l += w; o_r += w * 0.94; }
            // master soft clip
            let mg = self.master * 0.9;
            let xl = o_l * mg; let xr = o_r * mg;
            out_l[i] = (xl / (1.0 + xl.abs() * 0.6)) as f32;
            out_r[i] = (xr / (1.0 + xr.abs() * 0.6)) as f32;
            self.cnt += 1.0;
        }
    }
}

// ---------------------------------------------------------------- exports
#[no_mangle] pub extern "C" fn init(sr: f64) { unsafe { DSP = Some(Dsp::new(sr)); } }
#[no_mangle] pub extern "C" fn params_ptr() -> *mut f64 { unsafe { PARAMS.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn arrays_ptr() -> *mut f64 { unsafe { ARRAYS.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn target_ptr() -> *mut f64 { unsafe { TARGET.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn out_l_ptr() -> *mut f32 { unsafe { OUT_L.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn out_r_ptr() -> *mut f32 { unsafe { OUT_R.as_mut_ptr() } }
#[no_mangle] pub extern "C" fn set_profile() { unsafe { if let Some(d) = DSP.as_mut() { d.set_profile(); } } }
#[no_mangle] pub extern "C" fn trigger(id: i32, v: f64) { unsafe { if let Some(d) = DSP.as_mut() { d.trigger(id, v); } } }
#[no_mangle] pub extern "C" fn process(n: u32) { unsafe { if let Some(d) = DSP.as_mut() { d.process((n as usize).min(MAXN)); } } }
