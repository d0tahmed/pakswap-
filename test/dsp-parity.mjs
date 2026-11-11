// Runs the JavaScript synthesiser and its Rust/WebAssembly build on the same script of
// messages and compares the samples. Usage: node test/dsp-parity.mjs
import fs from 'fs';
import { EngineDSP, soundProfile } from '../src/audio/dsp.js';
import { EngineWasm } from '../src/audio/dspWasm.js';
import { ENGINES } from '../src/data/engines.js';
import { CARS } from '../src/data/cars.js';

const bytes = fs.readFileSync(new URL('../src/audio/engine_dsp.wasm', import.meta.url));
const SR = 48000, N = 128;
let worst = 0, total = 0, tJs = 0, tWasm = 0;
const cases = [];
for (const e of ENGINES) cases.push([e, { exhaust: 'stock', intake: 'stock', fi: 'none', ecu: 'stock' }]);
for (const id of ['toy-2jz', 'suz-f8b', 'chv-ls3', 'maz-13b', 'suz-busa', 'sub-ej257', 'cum-6bt']) { const e = ENGINES.find((x) => x.id === id); if (e) cases.push([e, { exhaust: 'straight', intake: 'itb', fi: 'bigturbo', ecu: 's3' }], [e, { exhaust: 'sport', intake: 'cai', fi: 'sc', ecu: 's1' }]); }
const car = CARS[0];
for (const [engine, cfg] of cases) {
  const a = new EngineDSP(SR), b = new EngineWasm(SR, bytes);
  const send = (m) => { a.message(m); b.message(JSON.parse(JSON.stringify(m))); };
  send({ type: 'profile', profile: soundProfile(engine, cfg, car) });
  const La = new Float32Array(N), Ra = new Float32Array(N), Lb = new Float32Array(N), Rb = new Float32Array(N);
  const red = engine.redline || 9000;
  let diff = 0;
  for (let blk = 0; blk < 1500; blk++) { // 4 seconds
    const t = (blk * N) / SR;
    // start, idle, rev up, lift, slide, horn, impact: every layer of the synthesiser gets used
    if (blk === 0) send({ type: 'trigger', name: 'click', value: 1 });
    if (t < 0.7) send({ type: 'state', state: { rpm: 230, load: 0, boost: 0, cut: 0, on: 0, starter: 1, crank: 1, master: 1 } });
    else if (t < 1.2) send({ type: 'state', state: { rpm: 900, load: 0.3, on: 1, starter: 0, crank: 0 } });
    else if (t < 2.6) send({ type: 'state', state: { rpm: 900 + (red - 900) * ((t - 1.2) / 1.4), load: 1, boost: Math.min(1, (t - 1.2)), speed: 60 * (t - 1.2), slip: t > 2 ? 0.8 : 0, scrub: 0.3 } });
    else send({ type: 'state', state: { rpm: red * 0.5, load: 0.05, boost: 0, cut: t < 2.7 ? 1 : 0, slip: 0, surf: 0.6, rough: 0.4, scrape: t > 3.4 ? 0.7 : 0, horn: t > 3 && t < 3.3 ? 1 : 0, speed: 80 } });
    if (blk === 263) send({ type: 'trigger', name: 'catch' });
    if (blk === 200) send({ type: 'trigger', name: 'cough', value: 1 });
    if (blk === 980) { send({ type: 'trigger', name: 'bov', value: 0.9 }); send({ type: 'trigger', name: 'pop', value: 0.8 }); send({ type: 'trigger', name: 'shift' }); }
    if (blk === 1200) { send({ type: 'trigger', name: 'impact', value: 6 }); send({ type: 'trigger', name: 'cone', value: 5 }); }
    if (blk === 1400) { send({ type: 'trigger', name: 'shudder', value: 1 }); send({ type: 'trigger', name: 'ready' }); send({ type: 'trigger', name: 'poweroff' }); }
    let t0 = performance.now(); a.process(La, Ra, N); tJs += performance.now() - t0;
    t0 = performance.now(); b.process(Lb, Rb, N); tWasm += performance.now() - t0;
    for (let i = 0; i < N; i++) { const d = Math.max(Math.abs(La[i] - Lb[i]), Math.abs(Ra[i] - Rb[i])); if (d > diff) diff = d; if (!Number.isFinite(Lb[i])) diff = Infinity; }
  }
  total++;
  if (diff > worst) worst = diff;
  if (diff > 1e-3) console.log('MISMATCH', engine.id, JSON.stringify(cfg), diff);
}
console.log(`${total} engine set-ups, worst sample difference ${worst.toExponential(2)}`);
console.log(`time for the same audio: JavaScript ${tJs.toFixed(0)} ms, Rust/WASM ${tWasm.toFixed(0)} ms (${(tJs / tWasm).toFixed(2)}x)`);
process.exit(worst > 1e-3 ? 1 : 0);
