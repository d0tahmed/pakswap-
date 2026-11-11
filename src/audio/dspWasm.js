// Thin wrapper around the WebAssembly build of the synthesiser (native/engine-dsp, Rust).
// Same interface as EngineDSP, so the worklet can use either. Self-contained: it is handed to
// the AudioWorklet as source text, exactly like EngineDSP.
export class EngineWasm {
  constructor(sr, bytes) {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    const x = inst.exports;
    this.x = x;
    x.init(sr);
    this.pP = x.params_ptr(); this.pA = x.arrays_ptr(); this.pT = x.target_ptr(); this.pL = x.out_l_ptr(); this.pR = x.out_r_ptr();
    this.TRIG = { pop: 0, bov: 1, shift: 2, click: 3, cough: 4, catch: 5, shudder: 6, ready: 7, impact: 8, cone: 9, poweroff: 10 };
    this.TGT = { rpm: 0, load: 1, boost: 2, cut: 3, slip: 4, speed: 5, on: 6, starter: 7, crank: 8, master: 9, surf: 10, rough: 11, scrape: 12, horn: 13, scrub: 14 };
    this.views();
  }

  // typed views over the module's memory (re-made if the memory ever grows)
  views() {
    const b = this.x.memory.buffer;
    if (this.buf === b) return;
    this.buf = b;
    this.P = new Float64Array(b, this.pP, 64); this.A = new Float64Array(b, this.pA, 48); this.T = new Float64Array(b, this.pT, 16);
    this.L = new Float32Array(b, this.pL, 4096); this.R = new Float32Array(b, this.pR, 4096);
  }

  message(m) {
    if (!m) return;
    if (m.type === 'profile') this.setProfile(m.profile);
    else if (m.type === 'state') { this.views(); const st = m.state, T = this.T, I = this.TGT; for (const k in st) { const i = I[k]; if (i !== undefined) T[i] = +st[k] || 0; } }
    else if (m.type === 'trigger') { const id = this.TRIG[m.name]; if (id !== undefined) this.x.trigger(id, m.value == null ? NaN : +m.value); }
  }

  setProfile(p) {
    this.views();
    const P = this.P, A = this.A, S = p.start || {};
    P.fill(0); A.fill(0);
    const off = p.offsets || [];
    P[0] = p.kind === 'ev' ? 2 : p.kind === 'rotary' ? 1 : 0;
    P[1] = p.redline || 0; P[2] = p.idle || 0; P[3] = p.bright || 0; P[4] = p.rumble || 0; P[5] = p.vtec || 0;
    P[6] = p.diesel ? 1 : 0; P[7] = p.exhaust === 'straight' ? 2 : p.exhaust === 'sport' ? 1 : 0;
    P[8] = p.turbo ? 1 : 0; P[9] = p.bigTurbo ? 1 : 0; P[10] = p.sc ? 1 : 0; P[11] = p.itb ? 1 : 0; P[12] = p.cai ? 1 : 0; P[13] = p.flutter ? 1 : 0;
    P[14] = p.cycleRevs || 0; P[15] = p.pipe || 0; P[16] = p.cyl || 0; P[17] = (p.seed || 0) >>> 0; P[18] = Math.min(16, off.length);
    P[19] = p.banks ? 1 : 0; P[20] = p.hdr ? 1 : 0; P[21] = p.pw || 0; P[22] = p.intakeK || 0; P[23] = p.raspK || 0; P[24] = p.tickK || 0;
    P[25] = p.lope || 0; P[26] = p.lopeHz || 0; P[27] = p.mufK || 0; P[28] = p.bodyK || 0; P[29] = p.bodyGain || 0; P[30] = 1;
    P[32] = S.depth || 0; P[33] = S.misfire || 0; P[34] = S.heavy || 0; P[35] = S.grind == null ? -1 : S.grind; P[36] = S.chuff || 0; P[37] = S.crankRpm || 0; P[38] = S.whine || 0;
    for (let i = 0; i < Math.min(16, off.length); i++) { A[i] = off[i]; A[16 + i] = p.banks ? p.banks[i] : 0; A[32 + i] = p.hdr ? p.hdr[i] : 0; }
    this.x.set_profile();
  }

  process(L, R, n) {
    this.x.process(n);
    this.views();
    L.set(this.L.subarray(0, n)); R.set(this.R.subarray(0, n));
  }
}
