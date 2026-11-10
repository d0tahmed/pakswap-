// PakSwap Studio: application controller.
import { CARS, CAR_BY_ID, CAR_FILTERS, carMatchesFilter } from './data/cars.js';
import { ENGINES, ENGINE_BY_ID, ENGINE_FILTERS, engineLayoutLabel, aspirationLabel } from './data/engines.js';
import { OPTIONS, PAINT_PRESETS, FINISHES, LIVERIES, RIM_STYLES, RIM_COLORS, CALIPER_COLORS, UNDERGLOW, defaultConfig, stockRim, VISUAL_KEYS } from './data/parts.js';
import { analyse, stockFor, fitment, engineSpecLines } from './sim/analysis.js';
import { deriveVehicle, parseTyre } from './sim/vehicle.js';
import { buildCurve } from './sim/powertrain.js';
import { EngineAudio, RevSim } from './audio/engineAudio.js';
import { startParams } from './audio/dsp.js';
import { drawDyno, drawAccel, drawTacho, drawDrag } from './ui/charts.js';
import { MODEL_ACCEPT, readModelFiles, parseModel, CustomCar, saveModel, loadModelRecord, deleteModel } from './three/importer.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => (v == null || !isFinite(v) ? '-' : Number(v).toFixed(d));
const store = {
  get(k, d) { try { const v = localStorage.getItem('pakswap:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('pakswap:' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};

const BODY_ICON = {
  sedan: 'M4 30 L8 22 L24 19.5 L34 11 L53 11 L63 19.5 L78 21 L80 30 Z',
  fastback: 'M4 30 L8 22 L24 19 L34 11 L52 11 L71 20 L80 23 L80 30 Z',
  hatch: 'M4 30 L7 22 L22 19 L32 10 L60 10 L75 17 L78 30 Z',
  hothatch: 'M4 30 L7 22 L22 19 L33 10 L58 11 L76 19 L78 30 Z',
  kei: 'M6 30 L7 21 L18 18.5 L26 8 L64 8 L72 15 L74 30 Z',
  tallboy: 'M6 30 L7 21 L16 18.5 L23 5 L66 5 L72 13 L74 30 Z',
  suv: 'M4 30 L5 20 L20 18 L30 8 L68 8 L78 16 L79 30 Z',
  bigsuv: 'M3 30 L4 18 L19 16 L26 6 L74 6 L78 13 L79 30 Z',
  jeep: 'M6 30 L6 18 L20 16 L24 6 L72 6 L74 14 L75 30 Z',
  pickup: 'M2 30 L3 20 L19 18 L27 8 L46 8 L48 18 L80 18 L81 30 Z',
  van: 'M6 30 L6 13 L13 4 L76 4 L78 8 L78 30 Z',
};
function carIcon(body) {
  return `<svg viewBox="0 0 84 40" aria-hidden="true"><path d="${BODY_ICON[body] || BODY_ICON.sedan}" fill="currentColor" opacity="0.85"/><circle cx="20" cy="30" r="6" fill="var(--panel)" stroke="currentColor" stroke-width="2.5"/><circle cx="64" cy="30" r="6" fill="var(--panel)" stroke="currentColor" stroke-width="2.5"/></svg>`;
}

const FEATURED = [
  { name: 'Mehran-busa', sub: 'Hayabusa in a Mehran', car: 'suzuki-mehran', cfg: { engineId: 'suz-busa', exhaust: 'straight', tyres: 'drag', lsd: 'clutch', brakes: 'bbk', suspension: 'coilovers', rideHeight: -40, rimStyle: 'five', rimSize: 13, rimColor: '#1b1c1f', paint: '#f0a218', finish: 'gloss', livery: 'stripes', liveryColor: '#141518', spoiler: 'ducktail', caliper: '#d4202a', cooling: 'radiator' } },
  { name: '2JZ Mark X', sub: '700+ hp RWD sleeper', car: 'toyota-markx', cfg: { engineId: 'toy-2jz', fi: 'bigturbo', ecu: 's2', exhaust: 'straight', intake: 'cai', tyres: 'drag', lsd: 'clutch', clutch: 'hd', brakes: 'bbk', cooling: 'full', rimStyle: 'mesh', rimSize: 18, rimColor: '#8a6a3d', paint: '#141518', finish: 'satin', widebody: true, tyreWidth: 3, spoiler: 'wing', suspension: 'coilovers', rideHeight: -45, caliper: '#f2c21b' } },
  { name: 'Truck-art Bolan', sub: 'Shaadi-ready Dabba', car: 'suzuki-bolan', cfg: { livery: 'truckart', paint: '#f0a218', finish: 'gloss', roofAcc: 'luggage', mudflaps: true, rimStyle: 'dish', rimColor: '#f4f4f4', underglow: '#ff3fb4', headlight: 'warm' } },
  { name: 'Revo expedition', sub: 'Lifted for Skardu', car: 'toyota-revo', cfg: { suspension: 'lift', tyres: 'at', rimStyle: 'offroad', rimSize: 17, rimColor: '#1b1c1f', roofAcc: 'lightbar', bullbar: true, snorkel: true, mudflaps: true, paint: '#3e5236', finish: 'matte', ecu: 's1', cooling: 'radiator' } },
  { name: 'Electric Corolla', sub: 'EV kit, zero petrol', car: 'toyota-corolla', cfg: { engineId: 'ev-kit', rimStyle: 'turbine', rimColor: '#4b4f55', paint: '#11847e', finish: 'pearl', tyres: 'eco' } },
  { name: 'Civic K20C1', sub: 'Type R heart', car: 'honda-civic', cfg: { engineId: 'hon-k20c1', lsd: 'helical', tyres: 'performance', brakes: 'bbk', caliper: '#d4202a', spoiler: 'wing', lip: true, skirts: true, diffuser: true, paint: '#f2f2ee', finish: 'gloss', livery: 'side', liveryColor: '#b3121f', rimStyle: 'multi', rimSize: 18, rimColor: '#1b1c1f', tips: 'center', exhaust: 'sport' } },
  { name: 'Alto Works', sub: 'Kei turbo pocket rocket', car: 'suzuki-alto', cfg: { engineId: 'suz-r06at', exhaust: 'sport', intake: 'cai', ecu: 's1', suspension: 'springs', rimStyle: 'five', rimSize: 15, rimColor: '#1b1c1f', paint: '#f2f2ee', livery: 'stripes', liveryColor: '#b3121f', tyres: 'performance', lip: true } },
  { name: 'LS Potohar', sub: 'V8 in a tiny jeep', car: 'suzuki-potohar', cfg: { engineId: 'chv-ls3', exhaust: 'straight', tyres: 'at', suspension: 'lift', rimStyle: 'offroad', rimColor: '#1b1c1f', brakes: 'bbk', cooling: 'full', paint: '#c84b11', finish: 'gloss', bullbar: true, roofAcc: 'lightbar', livery: 'camo' } },
];

// ---------------------------------------------------------------- state
const S = {
  carId: 'suzuki-mehran', cfg: null, a: null, tab: 'engine', carFilter: 'all', carQuery: '', engFilter: 'all', engQuery: '',
  xray: false, night: true, spin: false, view: 'front', mobile: false, ready: false, custom: null, customRec: null, customBusy: false,
};
let studio = null, model = null, THREEmod = null, drive = null;
const audio = new EngineAudio();
const rev = new RevSim();
const sound = { on: false, ab: 'build', showT: 0, launch: null, held: false };
const fitCache = new Map();

function car() { return CAR_BY_ID[S.carId]; }

// ---------------------------------------------------------------- toast
let toastT = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400);
}

// ---------------------------------------------------------------- analysis
function recompute() {
  S.a = analyse(car(), S.cfg);
}

function engineFit(engine) {
  const c = car();
  const key = `${c.id}|${engine.id}|${S.cfg.drive}|${S.cfg.gearbox}|${S.cfg.fi}`;
  if (fitCache.has(key)) return fitCache.get(key);
  const cfg = { ...S.cfg, engineId: engine.id };
  const veh = deriveVehicle(c, engine, cfg, ENGINE_BY_ID);
  const f = fitment(c, engine, cfg, veh);
  const out = { label: f.label, d: f.difficulty, hp: veh.curve.peakHp, drive: veh.drive };
  fitCache.set(key, out);
  return out;
}

function fitClass(d, stock) { if (stock) return 'f0'; return d <= 18 ? 'f0' : d <= 40 ? 'f1' : d <= 65 ? 'f2' : 'f3'; }

// ---------------------------------------------------------------- 3D
async function init3D() {
  try {
    const test = document.createElement('canvas');
    const gl = test.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 not available');
  } catch (e) {
    $('#viewport').innerHTML = `<div class="nogl"><div><p><b>3D view needs WebGL 2.</b></p><p>Your browser or device has it switched off. Specs, swaps and sound still work.</p></div></div>`;
    return false;
  }
  const [{ Studio }, { CarModel }] = await Promise.all([import('./three/scene.js'), import('./three/carModel.js')]);
  studio = new Studio($('#viewport'));
  const q = store.get('quality', null);
  const low = (navigator.hardwareConcurrency || 8) <= 4 || /Mobi|Android/i.test(navigator.userAgent);
  studio.setQuality(q || (low ? 'medium' : 'high'));
  model = new CarModel();
  studio.carSlot.add(model.root);
  studio.onFrame.push(frame);
  return true;
}

function buildModel(resetCam = true) {
  if (!model) return;
  const c = car();
  model.build(c, S.cfg, { veh: S.a.veh, fit: S.a.fit, engine: S.a.engine });
  model.setXray(S.xray);
  model.setNight(S.night);
  studio.frameCar(c.dims[0] / 1000, c.dims[2] / 1000);
  if (resetCam) studio.preset(S.xray ? 'engine' : S.view, model.engineCenter);
}

// ---------------------------------------------------------------- car selection and config
function selectCar(id, override, opts = {}) {
  sound.launch = null;
  S.carId = id;
  const c = car();
  S.cfg = { ...defaultConfig(c), ...(override || {}) };
  recompute();
  buildModel(true);
  loadCustomFor(id);
  updateAudioEngine();
  restartEngineSoon();
  renderAll();
  if (!opts.silent) toast(`${c.brand} ${c.model} loaded`);
  store.set('last', { car: id, cfg: S.cfg });
}

const WHEEL_KEYS = new Set(['rimStyle', 'rimSize', 'tyreWidth', 'tyres', 'brakes']);
const KIT_KEYS = new Set(['lip', 'skirts', 'diffuser', 'spoiler', 'hood', 'roofAcc', 'bullbar', 'snorkel', 'mudflaps', 'towhook', 'cage']);
const ENGINE_KEYS = new Set(['engineId', 'fi', 'intake', 'drive']);
const SOUND_KEYS = new Set(['engineId', 'exhaust', 'intake', 'fi', 'ecu', 'nitrous', 'fuelsys']);

function setCfg(patch) {
  const before = S.cfg;
  S.cfg = { ...S.cfg, ...patch };
  const keys = Object.keys(patch).filter((k) => before[k] !== S.cfg[k]);
  if (!keys.length) return;
  sound.launch = null;
  const visualOnly = keys.every((k) => VISUAL_KEYS.has(k));
  if (!visualOnly) { recompute(); fitCache.clear(); }
  if (model) {
    if (keys.includes('widebody') || keys.includes('roof') && (!!before.roof !== !!S.cfg.roof)) buildModel(false);
    else {
      model.info = { veh: S.a.veh, fit: S.a.fit, engine: S.a.engine };
      model.cfg = { ...S.cfg };
      if (keys.some((k) => WHEEL_KEYS.has(k)) || keys.includes('widebody')) model.buildWheels();
      if (keys.some((k) => ENGINE_KEYS.has(k))) { model.buildEngine(); model.buildKits(); model.buildExhaust(); }
      else if (keys.some((k) => KIT_KEYS.has(k))) model.buildKits();
      if (keys.includes('exhaust') || keys.includes('tips')) model.buildExhaust();
      if (keys.includes('suspension') || keys.includes('rideHeight')) model.setRide(S.cfg);
      model.applyVisuals(S.cfg);
      model.setXray(S.xray);
      model.setNight(S.night);
    }
  }
  if (keys.some((k) => SOUND_KEYS.has(k))) updateAudioEngine();
  if (keys.includes('engineId')) restartEngineSoon();
  if (visualOnly) { renderHeaderBits(); if (keys.includes('plate')) return; renderPanel(); }
  else renderAll(false);
  store.set('last', { car: S.carId, cfg: S.cfg });
}

// ---------------------------------------------------------------- rendering
function renderAll(rack = true) {
  if (rack) renderRack();
  renderHeaderBits();
  renderTabs();
  renderPanel();
  renderStats();
}

function renderHeaderBits() {
  const c = car(), a = S.a;
  $('#carTitle').textContent = `${c.brand} ${c.model}`;
  const eng = a.engine;
  $('#carSub').textContent = `${c.trim} · ${c.years} · ${eng.name}${eng.id !== c.engine ? ' swap' : ''}`;
  $('#verdict').innerHTML = `<span class="pk">PK</span><span class="vt"><b>${esc(a.verdict.title)}</b><span>${esc(a.verdict.sub)}</span></span>`;
}

function renderRack() {
  const host = S.mobile ? null : $('#rack');
  if (!host) return;
  host.innerHTML = rackHTML();
}

function rackHTML() {
  const q = S.carQuery.trim().toLowerCase();
  const list = CARS.filter((c) => carMatchesFilter(c, S.carFilter, ENGINE_BY_ID) && (!q || `${c.brand} ${c.model} ${c.trim} ${c.years}`.toLowerCase().includes(q)));
  const feats = FEATURED.map((f, i) => `<button type="button" class="feat" data-feat="${i}"><b>${esc(f.name)}</b><span>${esc(f.sub)}</span></button>`).join('');
  return `<div class="rack-head">
      <div class="label">${CARS.length} Pakistani cars</div>
      <input class="search" id="carSearch" type="search" placeholder="Search Mehran, Corolla, Revo..." value="${esc(S.carQuery)}" aria-label="Search cars">
      <div class="chips" role="group" aria-label="Filter cars">${CAR_FILTERS.map((f) => `<button type="button" class="chip" data-carfilter="${f.id}" aria-pressed="${S.carFilter === f.id}">${esc(f.label)}</button>`).join('')}</div>
    </div>
    <div class="scroll" style="flex:1;min-height:0">
      <div class="featured"><div class="label">Featured builds</div><div class="feat-list">${feats}</div></div>
      <ul class="carlist">${list.map((c) => { const e = ENGINE_BY_ID[c.engine]; const hp = e.fuel === 'hybrid' ? e.hyb.sys : (c.tune?.hp ?? e.hp);
    return `<li><button type="button" class="caritem" data-car="${c.id}" aria-current="${c.id === S.carId}">${carIcon(c.body)}<span style="min-width:0"><span class="nm">${esc(c.brand)} ${esc(c.model)}${c.era !== 'current' ? `<span class="era ${c.era}">${c.era}</span>` : ''}</span><br><span class="sub">${esc(c.trim)} · ${esc(c.years)}</span></span><span class="hp">${hp} hp</span></button></li>`; }).join('') || '<li class="hint" style="padding:12px">No car matches that search.</li>'}</ul>
    </div>`;
}

const TABS = [
  { id: 'cars', label: 'Cars', mobileOnly: true },
  { id: 'engine', label: 'Engine' },
  { id: 'paint', label: 'Paint' },
  { id: 'body', label: 'Body' },
  { id: 'wheels', label: 'Wheels' },
  { id: 'tune', label: 'Tune' },
  { id: 'specs', label: 'Specs' },
];

function renderTabs() {
  const tabs = TABS.filter((t) => !t.mobileOnly || S.mobile);
  if (!tabs.find((t) => t.id === S.tab)) S.tab = 'engine';
  $('#tabs').innerHTML = tabs.map((t) => `<button type="button" class="tab" role="tab" id="tab-${t.id}" aria-selected="${S.tab === t.id}" data-tab="${t.id}">${t.label}</button>`).join('');
}

function renderPanel() {
  const p = $('#panel');
  const scroll = p.scrollTop;
  const fn = { cars: () => `<div style="display:grid;gap:12px">${rackHTML()}</div>`, engine: engineTab, paint: paintTab, body: bodyTab, wheels: wheelsTab, tune: tuneTab, specs: specsTab }[S.tab];
  p.innerHTML = fn();
  p.setAttribute('aria-labelledby', `tab-${S.tab}`);
  p.scrollTop = scroll;
  if (S.tab === 'specs') drawSpecCharts();
}

// ---------------------------------------------------------------- controls
function opts(key, list, value, extra = {}) {
  return `<div class="opts" role="group">${list.map((o) => {
    const dis = extra.disabled && extra.disabled(o);
    return `<button type="button" class="opt" data-k="${key}" data-v="${esc(String(o.id))}" data-t="${typeof o.id}" aria-pressed="${String(value) === String(o.id)}" ${dis ? 'disabled' : ''}>${esc(o.label)}${o.desc && extra.desc !== false ? `<small>${esc(o.desc)}</small>` : ''}</button>`;
  }).join('')}</div>`;
}
function tog(key, label, value) { return `<button type="button" class="tog" data-tog="${key}" aria-pressed="${!!value}"><span>${esc(label)}</span><i></i></button>`; }
function swatches(key, list, value, allowNone) {
  return `<div class="swatches">${allowNone ? `<button type="button" class="sw none" data-k="${key}" data-v="" data-t="null" aria-pressed="${!value}" title="${esc(allowNone)}" aria-label="${esc(allowNone)}"></button>` : ''}${list.map((c) => `<button type="button" class="sw" style="background:${c.hex || 'transparent'}" data-k="${key}" data-v="${c.hex ?? ''}" data-t="${c.hex ? 'string' : 'null'}" aria-pressed="${String(value || '').toLowerCase() === String(c.hex || '').toLowerCase()}" title="${esc(c.name)}" aria-label="${esc(c.name)}"></button>`).join('')}</div>`;
}
function group(label, inner, right = '') { return `<div class="group"><div class="label"><span>${esc(label)}</span>${right ? `<em>${right}</em>` : ''}</div>${inner}</div>`; }

// ---------------------------------------------------------------- tabs
function engineTab() {
  const c = car(), a = S.a, e = a.engine;
  const stockE = ENGINE_BY_ID[c.engine];
  const fit = a.fit;
  const spec = engineSpecLines(e).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const q = S.engQuery.trim().toLowerCase();
  const list = ENGINES.filter((x) => (S.engFilter === 'all' || x.tags.includes(S.engFilter)) && (!q || `${x.name} ${x.desc} ${x.from} ${x.maker}`.toLowerCase().includes(q)));
  list.sort((x, y) => (x.id === c.engine ? -1 : y.id === c.engine ? 1 : 0));
  const rows = list.map((x) => {
    const f = engineFit(x);
    const isStock = x.id === c.engine;
    const delta = Math.round(f.hp - S.a.stock.m.hp);
    return `<button type="button" class="eitem" data-engine="${x.id}" aria-current="${x.id === e.id}">
      <span class="en">${esc(x.name)}${isStock ? '<span class="stock-tag">STOCK</span>' : ''}</span>
      <span class="ep num">${Math.round(f.hp)} <small>hp</small></span>
      <span class="ed">${esc(x.desc)} · ${x.fuel === 'electric' ? `${x.ev.battKg + x.kg} kg` : `${x.kg} kg`}${delta ? ` · ${delta > 0 ? '+' : ''}${delta} hp` : ''}</span>
      <span class="er pill ${fitClass(f.d, isStock)}">${isStock ? 'Factory' : esc(f.label)}</span>
    </button>`;
  }).join('');
  return `<div class="card engine-now">
      <div class="row1"><div><div class="label">${e.id === c.engine ? 'Factory engine' : 'Swapped engine'}</div><h3>${esc(e.name)}</h3><p>${esc(e.desc)} · ${esc(engineLayoutLabel(e))} · ${esc(aspirationLabel(e))}</p></div>
      <span class="pill ${fitClass(fit.difficulty, e.id === c.engine && fit.difficulty === 0)}">${esc(fit.label)}</span></div>
      <dl class="kv">${spec}<dt>Drive in this car</dt><dd>${esc(a.veh.drive)} · ${esc(a.m.gearbox)}</dd></dl>
      ${e.note ? `<p>${esc(e.note)}</p>` : ''}
      <div class="sl-row">${e.id !== c.engine ? `<button type="button" class="btn" data-engine="${c.engine}">Back to stock ${esc(stockE.name)}</button>` : ''}<button type="button" class="btn primary" data-act="hear">Hear this engine</button></div>
    </div>
    <div class="group"><div class="label"><span>Swap library</span><em>${ENGINES.length} engines</em></div>
      <input class="search" id="engSearch" type="search" placeholder="Search 2JZ, K20, Hayabusa, LS3..." value="${esc(S.engQuery)}" aria-label="Search engines">
      <div class="chips">${ENGINE_FILTERS.map((f) => `<button type="button" class="chip" data-engfilter="${f.id}" aria-pressed="${S.engFilter === f.id}">${esc(f.label)}</button>`).join('')}</div>
      <div class="elist">${rows || '<p class="hint">No engine matches that search.</p>'}</div>
    </div>`;
}

function paintTab() {
  const c = S.cfg;
  return `<div class="card">
      ${group('Body colour', `${swatches('paint', PAINT_PRESETS, c.paint)}<label class="colorpick" for="paintPick"><input id="paintPick" type="color" value="${esc(c.paint)}"> Custom colour</label>`, PAINT_PRESETS.find((p) => p.hex.toLowerCase() === String(c.paint).toLowerCase())?.name || 'Custom')}
      ${group('Finish', opts('finish', FINISHES, c.finish))}
      ${group('Roof', swatches('roof', [{ name: 'Gloss black', hex: '#111214' }, { name: 'White', hex: '#f2f2ee' }, { name: 'Silver', hex: '#c3c7cb' }, { name: 'Red', hex: '#b3121f' }], c.roof, 'Same as body'), c.roof ? 'Two-tone' : 'Same as body')}
    </div>
    <div class="card">
      ${group('Livery', opts('livery', LIVERIES, c.livery))}
      ${['stripes', 'side'].includes(c.livery) ? group('Stripe colour', swatches('liveryColor', [{ name: 'White', hex: '#f2f2ee' }, { name: 'Black', hex: '#141518' }, { name: 'Saffron', hex: '#f0a218' }, { name: 'Red', hex: '#b3121f' }, { name: 'Teal', hex: '#11847e' }, { name: 'Blue', hex: '#1f5d8c' }], c.liveryColor)) : ''}
      ${c.livery === 'truckart' ? '<p class="hint">Hand-painted Pakistani truck art pattern, built around your body colour.</p>' : ''}
    </div>
    <div class="card">
      ${group('Window tint', `<input type="range" id="tint" min="0" max="90" step="5" value="${c.tint}" aria-label="Window tint">`, `${c.tint}%`)}
      ${c.tint >= 50 ? '<p class="hint">Dark tint usually needs a permit from the traffic police.</p>' : ''}
      ${group('Number plate', `<input class="textin" id="plateIn" maxlength="10" value="${esc(c.plate)}" aria-label="Number plate text">`)}
      ${group('Headlights', opts('headlight', OPTIONS.headlight, c.headlight))}
      ${group('Underglow', swatches('underglow', UNDERGLOW.filter((u) => u.hex), c.underglow, 'Off'))}
    </div>`;
}

function modelCard() {
  const cm = S.custom;
  if (cm && cm.carId === S.carId) {
    const st = cm.stats;
    return `<div class="card model-card">
      <h3>Real 3D model</h3>
      <p class="hint">${esc(cm.name)} · ${(st.tris / 1000).toFixed(st.tris > 100000 ? 0 : 1)}k triangles · ${st.meshes} parts${cm.wheels ? ` · ${cm.wheels} wheels spin` : ''}${cm.paint ? '' : ' · no body paint found'}</p>
      <div class="opts" role="group">
        <button type="button" class="opt" data-cm="turn">Turn around<small>If the car faces backwards</small></button>
        <button type="button" class="opt" data-cm="rot">Rotate 90°<small>If it sits sideways</small></button>
        <button type="button" class="opt" data-cm="up">Stand upright<small>If it lies on its side</small></button>
      </div>
      <div class="toggles">${tog('__cmpaint', 'Use Paint tab colour', cm.paintOn)}</div>
      <div class="sl-row"><button type="button" class="btn" data-cm="load">Load another</button><button type="button" class="btn" data-cm="remove">Remove model</button></div>
    </div>`;
  }
  return `<div class="card model-card">
      <h3>Real 3D model</h3>
      <p class="hint">Got a 3D model of this car? Load it here: GLB, glTF, ZIP, FBX or OBJ. It replaces the built-in body, and engine swaps, sound and specs keep working. Use models you made, bought or have a licence for.</p>
      <div class="sl-row"><button type="button" class="btn primary" data-cm="load">${S.customBusy ? 'Loading...' : 'Load 3D model'}</button></div>
      <p class="hint">You can also drop the file on the 3D view. It is saved for this car on this device.</p>
    </div>`;
}

function bodyTab() {
  const c = S.cfg;
  return `${modelCard()}<div class="card">
      <h3>Aero kit</h3>
      <div class="toggles">${tog('lip', 'Front lip', c.lip)}${tog('skirts', 'Side skirts', c.skirts)}${tog('diffuser', 'Rear diffuser', c.diffuser)}${tog('widebody', 'Widebody', c.widebody)}</div>
      ${group('Spoiler', opts('spoiler', OPTIONS.spoiler, c.spoiler))}
      ${group('Hood', opts('hood', OPTIONS.hood, c.hood))}
      ${S.a.fit.needsScoop && S.a.engine.fuel !== 'electric' ? '<p class="hint">This engine sits above the hood line, so a scoop is fitted automatically.</p>' : ''}
    </div>
    <div class="card">
      <h3>Accessories</h3>
      ${group('Roof', opts('roofAcc', OPTIONS.roofAcc, c.roofAcc))}
      <div class="toggles">${tog('bullbar', 'Bull bar', c.bullbar)}${tog('snorkel', 'Snorkel', c.snorkel)}${tog('mudflaps', 'Mud flaps', c.mudflaps)}${tog('towhook', 'Tow hook', c.towhook)}${tog('cage', 'Roll cage', c.cage)}</div>
      ${group('Exhaust tips', opts('tips', OPTIONS.tips, c.tips))}
    </div>`;
}

function wheelsTab() {
  const c = S.cfg, car0 = car();
  const t0 = parseTyre(car0.tyre);
  const v = S.a.veh;
  const minR = Math.max(12, t0.d - 1), maxR = Math.min(22, t0.d + 5);
  return `<div class="card">
      ${group('Rim style', opts('rimStyle', RIM_STYLES, c.rimStyle))}
      ${group('Rim size', `<input type="range" id="rimSize" min="${minR}" max="${maxR}" step="1" value="${c.rimSize}" aria-label="Rim size in inches">`, `${c.rimSize} inch (stock ${t0.d})`)}
      ${group('Tyre width', opts('tyreWidth', OPTIONS.tyreWidth, c.tyreWidth))}
      <p class="hint num">Tyre: ${v.tyreW}/${v.aspect} R${c.rimSize} · sidewall ${Math.round(v.side)} mm · overall ${Math.round(v.D)} mm</p>
      ${group('Tyre type', opts('tyres', OPTIONS.tyres, c.tyres))}
    </div>
    <div class="card">
      ${group('Rim colour', swatches('rimColor', RIM_COLORS, c.rimColor))}
      ${group('Brake calipers', swatches('caliper', CALIPER_COLORS, c.caliper))}
    </div>`;
}

function tuneTab() {
  const c = S.cfg, e = S.a.engine;
  const ev = e.fuel === 'electric';
  const turboStock = e.asp === 'T' || e.asp === 'TT' || e.turbo;
  const fiList = OPTIONS.fi.map((o) => turboStock && o.id !== 'none' ? { ...o, label: o.id === 'turbo' ? 'Hybrid turbo' : o.id === 'bigturbo' ? 'Big single turbo' : 'Twin-charge', desc: o.id === 'turbo' ? 'More boost, same spool' : o.desc } : o);
  const adj = ['coilovers', 'air', 'lift'].includes(c.suspension);
  const rh = c.suspension === 'lift' ? [20, 90] : [-90, 30];
  return `${ev ? '<div class="card"><h3>Electric drive</h3><p class="hint">Exhaust, intake, turbo, nitrous and fuel options do not apply. The controller tune below raises motor output.</p></div>' : `<div class="card">
      <h3>Engine</h3>
      ${group('Exhaust', opts('exhaust', OPTIONS.exhaust, c.exhaust))}
      ${group('Intake', opts('intake', OPTIONS.intake, c.intake, { disabled: (o) => o.id === 'itb' && (turboStock || c.fi !== 'none') }))}
      ${group(turboStock ? 'Turbo upgrade' : 'Forced induction', opts('fi', fiList, c.fi))}
      ${group('Nitrous', opts('nitrous', OPTIONS.nitrous, c.nitrous, { desc: false }))}
      ${group('Fuel system', opts('fuelsys', OPTIONS.fuelsys, c.fuelsys, { disabled: (o) => o.id !== 'petrol' && e.fuel !== 'petrol' }))}
      ${group('Cooling', opts('cooling', OPTIONS.cooling, c.cooling, { desc: false }))}
    </div>`}
    <div class="card">
      ${group(ev ? 'Controller tune' : 'ECU tune', opts('ecu', OPTIONS.ecu, c.ecu))}
    </div>
    <div class="card">
      <h3>Drivetrain</h3>
      ${ev ? '' : group('Gearbox', opts('gearbox', OPTIONS.gearbox, c.gearbox, { disabled: (o) => e.orient === 'BIKE' && o.id !== 'auto' && o.id !== 'SEQ6' }), S.a.m.gearbox)}
      ${group('Gearing', opts('gearing', OPTIONS.gearing, c.gearing))}
      ${group('Driven wheels', opts('drive', OPTIONS.drive, c.drive), `Now ${S.a.veh.drive}`)}
      ${group('Differential', opts('lsd', OPTIONS.lsd, c.lsd, { desc: false }))}
      ${ev ? '' : group('Clutch and axles', opts('clutch', OPTIONS.clutch, c.clutch, { desc: false }))}
    </div>
    <div class="card">
      <h3>Chassis</h3>
      ${group('Brakes', opts('brakes', OPTIONS.brakes, c.brakes))}
      ${group('Suspension', opts('suspension', OPTIONS.suspension, c.suspension))}
      ${adj ? group('Ride height', `<input type="range" id="rideH" min="${rh[0]}" max="${rh[1]}" step="5" value="${c.rideHeight || (c.suspension === 'lift' ? 50 : c.suspension === 'air' ? -40 : -50)}" aria-label="Ride height in millimetres">`, `${(c.rideHeight || (c.suspension === 'lift' ? 50 : c.suspension === 'air' ? -40 : -50)) > 0 ? '+' : ''}${c.rideHeight || (c.suspension === 'lift' ? 50 : c.suspension === 'air' ? -40 : -50)} mm · clearance ${Math.round(S.a.m.gc)} mm`) : ''}
      ${group('Weight', opts('weight', OPTIONS.weight, c.weight, { desc: false }))}
    </div>
    <button type="button" class="btn" data-act="reset" style="justify-self:start">Reset to factory</button>`;
}

function deltaCell(b, s, d = 0, lowerBetter = false, unit = '') {
  if (b == null || s == null || !isFinite(b) || !isFinite(s)) return '<td class="dd">-</td>';
  const diff = b - s;
  if (Math.abs(diff) < Math.pow(10, -d) * 0.5) return '<td class="dd" style="color:var(--faint)">=</td>';
  const good = lowerBetter ? diff < 0 : diff > 0;
  return `<td class="dd" style="color:var(${good ? '--good' : '--bad'})">${diff > 0 ? '+' : ''}${fmt(diff, d)}${unit}</td>`;
}

function specsTab() {
  const a = S.a, m = a.m, s = a.stock.m;
  const rows = [
    ['Engine', a.stock.engine.name, a.engine.name, null],
    ['Power', `${fmt(s.hp)} hp`, `${fmt(m.hpNos)} hp`, deltaCell(m.hpNos, s.hp, 0, false, '')],
    ['Torque', `${fmt(s.nm)} Nm`, `${fmt(m.nm)} Nm`, deltaCell(m.nm, s.nm)],
    ['Kerb weight', `${fmt(s.weight)} kg`, `${fmt(m.weight)} kg`, deltaCell(m.weight, s.weight, 0, true)],
    ['Front / rear', `${Math.round(s.wf * 100)}/${Math.round(100 - s.wf * 100)}`, `${Math.round(m.wf * 100)}/${Math.round(100 - m.wf * 100)}`, null],
    ['hp per tonne', fmt(s.pw), fmt(m.pw), deltaCell(m.pw, s.pw)],
    ['Drive', `${a.stock.veh.drive} · ${s.gearbox}`, `${a.veh.drive} · ${m.gearbox}`, null],
    ['0-60 km/h', `${fmt(s.t60, 1)} s`, `${fmt(m.t60, 1)} s`, deltaCell(m.t60, s.t60, 1, true)],
    ['0-100 km/h', `${fmt(s.t100, 1)} s`, `${fmt(m.t100, 1)} s`, deltaCell(m.t100, s.t100, 1, true)],
    ['0-200 km/h', s.t200 ? `${fmt(s.t200, 1)} s` : '-', m.t200 ? `${fmt(m.t200, 1)} s` : '-', deltaCell(m.t200, s.t200, 1, true)],
    ['Quarter mile', `${fmt(s.tQ, 1)} s`, `${fmt(m.tQ, 1)} s @ ${fmt(m.vQ)}`, deltaCell(m.tQ, s.tQ, 1, true)],
    ['Top speed', `${fmt(s.vmax)} km/h`, `${fmt(m.vmax)} km/h`, deltaCell(m.vmax, s.vmax)],
    ['100-0 km/h', `${fmt(s.brake, 1)} m`, `${fmt(m.brake, 1)} m`, deltaCell(m.brake, s.brake, 1, true)],
    ['Cornering grip', `${fmt(s.latG, 2)} g`, `${fmt(m.latG, 2)} g`, deltaCell(m.latG, s.latG, 2)],
    [a.engine.fuel === 'electric' ? 'Range' : 'Fuel city / hwy', s.range ? `${fmt(s.range)} km` : `${fmt(s.kmplC, 1)} / ${fmt(s.kmplH, 1)} km/l`, m.range ? `${fmt(m.range)} km` : `${fmt(m.kmplC, 1)} / ${fmt(m.kmplH, 1)} km/l`, m.range || s.range ? null : deltaCell(m.kmplC, s.kmplC, 1)],
    ['Fuel', s.fuel, m.fuel, null],
    ['Ground clearance', `${fmt(s.gc)} mm`, `${fmt(m.gc)} mm`, deltaCell(m.gc, s.gc)],
    ['Exhaust loudness', `${s.db} dB`, `${m.db} dB`, null],
  ];
  const tbl = `<table class="compare"><thead><tr><th>Spec</th><th>Stock</th><th>Build</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="b">${esc(r[2])}</td>${r[3] || '<td></td>'}</tr>`).join('')}</tbody></table>`;
  const sc = a.scores, ss = a.stock.scores;
  const scoreRow = (k, label) => `<div class="score"><span>${label}</span><div class="bar" role="img" aria-label="${label} ${sc[k]} of 100, stock ${ss[k]}"><b style="width:${sc[k]}%"></b><s style="left:calc(${ss[k]}% - 1px)"></s></div><span class="num" style="text-align:right">${sc[k]}</span></div>`;
  const f = a.fit;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const fitCell = (k, need, bay, over) => `<div class="fitcell"><span class="k">${k}</span><span class="v" style="color:var(${over > 0.03 ? '--bad' : over > 0 ? '--warn' : '--good'})">${Math.round(need * 1000)} mm</span><span class="hint">bay ${Math.round(bay * 1000)} mm${over > 0.005 ? ` · over ${pct(over)}` : ''}</span></div>`;
  return `<div class="card"><div class="label">Verdict</div><h3>${esc(a.verdict.title)}</h3><p class="hint">${esc(a.verdict.sub)}</p></div>
    <div class="card"><h3>Stock vs build</h3><div style="overflow-x:auto">${tbl}</div><p class="hint">Times and speeds come from a physics simulation of this exact setup, not brochure figures.</p></div>
    <div class="card"><h3>Dyno</h3><div class="legend"><span><i style="background:var(--stock)"></i>Stock</span><span><i style="background:var(--accent)"></i>Build</span><span>solid power · dashed torque</span></div><div class="chartbox"><canvas id="dynoCv" aria-label="Power and torque curves"></canvas></div></div>
    <div class="card"><h3>Acceleration</h3><div class="legend"><span><i style="background:var(--stock)"></i>Stock ${fmt(s.t100, 1)} s</span><span><i style="background:var(--accent)"></i>Build ${fmt(m.t100, 1)} s</span><span>to 100 km/h</span></div><div class="chartbox"><canvas id="accCv" aria-label="Speed against time"></canvas></div></div>
    <div class="card"><h3>Pros</h3>${a.pros.length ? `<ul class="pc pro">${a.pros.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="hint">Nothing changed yet. Swap an engine or fit parts to see the gains.</p>'}</div>
    <div class="card"><h3>Cons</h3>${a.cons.length ? `<ul class="pc con">${a.cons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="hint">No real downsides with this setup.</p>'}</div>
    ${a.info.length ? `<div class="card"><h3>Workshop notes</h3><ul class="pc info">${a.info.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><h3>Swap difficulty</h3><div class="meter" role="img" aria-label="Difficulty ${Math.round(f.difficulty)} of 100"><b style="left:calc(${Math.min(99, f.difficulty)}% - 2px)"></b></div><div style="display:flex;justify-content:space-between" class="hint"><span>Bolt-in</span><span>${esc(f.label)}</span><span>Insane</span></div>
      <div class="fitbox">${fitCell('Length', f.need.len, f.bay.len, f.over.len)}${fitCell('Width', f.need.wid, f.bay.wid, f.over.wid)}${fitCell('Height', f.need.ht, f.bay.ht, f.over.ht)}</div></div>
    <div class="card"><h3>Ratings</h3><div class="scores">${scoreRow('reliability', 'Reliability')}${scoreRow('comfort', 'Comfort')}${scoreRow('practicality', 'Pakistani roads')}${scoreRow('fun', 'Fun factor')}</div><p class="hint">Blue mark shows the stock car.</p></div>`;
}

let dynoHover = null;
function drawSpecCharts() {
  const a = S.a;
  const dc = $('#dynoCv'), ac = $('#accCv');
  if (dc) {
    drawDyno(dc, a.stock.veh.curve, a.veh.curve, dynoHover);
    dc.onpointermove = (ev) => { dynoHover = ev.offsetX; drawDyno(dc, a.stock.veh.curve, a.veh.curve, dynoHover); };
    dc.onpointerleave = () => { dynoHover = null; drawDyno(dc, a.stock.veh.curve, a.veh.curve, null); };
  }
  if (ac) drawAccel(ac, a.stock.m.run, a.m.run);
}

function renderStats() {
  const a = S.a, m = a.m, s = a.stock.m;
  const cell = (k, v, unit, b, st, d, lowerBetter) => {
    let dl = '';
    if (b != null && st != null && isFinite(b) && isFinite(st)) {
      const diff = b - st;
      if (Math.abs(diff) >= Math.pow(10, -d) * 0.5) { const good = lowerBetter ? diff < 0 : diff > 0; dl = `<span class="d ${good ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${fmt(Math.abs(diff), d)}</span>`; }
      else dl = '<span class="d">stock</span>';
    }
    return `<div class="stat"><div class="k">${k}</div><div class="v">${v}<small>${unit}</small></div>${dl || '<span class="d">&nbsp;</span>'}</div>`;
  };
  const ev = a.engine.fuel === 'electric';
  $('#statStrip').innerHTML = [
    cell('Power', fmt(m.hpNos), 'hp', m.hpNos, s.hp, 0),
    cell('Torque', fmt(m.nm), 'Nm', m.nm, s.nm, 0),
    cell('Weight', fmt(m.weight), 'kg', m.weight, s.weight, 0, true),
    cell('0-100', fmt(m.t100, 1), 's', m.t100, s.t100, 1, true),
    cell('Top speed', fmt(m.vmax), 'km/h', m.vmax, s.vmax, 0),
    ev ? cell('Range', fmt(m.range), 'km', s.range ? m.range : null, s.range, 0) : cell('Fuel city', fmt(m.kmplC, 1), 'km/l', m.kmplC, s.kmplC, 1),
  ].join('');
}

// ---------------------------------------------------------------- events
function parseVal(v, t) { if (t === 'number') return Number(v); if (t === 'null') return null; if (t === 'boolean') return v === 'true'; return v; }

function bindEvents() {
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.car) { selectCar(b.dataset.car); if (S.mobile) { S.tab = 'engine'; renderTabs(); renderPanel(); } return; }
    if (b.dataset.feat != null) { const f = FEATURED[+b.dataset.feat]; selectCar(f.car, f.cfg, { silent: true }); toast(`${f.name} loaded. Open Specs or start the engine.`); if (S.mobile) { S.tab = 'specs'; renderTabs(); renderPanel(); } return; }
    if (b.dataset.carfilter) { S.carFilter = b.dataset.carfilter; if (S.mobile) renderPanel(); else renderRack(); return; }
    if (b.dataset.engfilter) { S.engFilter = b.dataset.engfilter; renderPanel(); return; }
    if (b.dataset.engine) { swapEngine(b.dataset.engine); return; }
    if (b.dataset.tab) { S.tab = b.dataset.tab; renderTabs(); renderPanel(); $('#panel').scrollTop = 0; return; }
    if (b.dataset.k) { setCfg({ [b.dataset.k]: parseVal(b.dataset.v, b.dataset.t) }); return; }
    if (b.dataset.tog === '__cmpaint') { customPaintToggle(); return; }
    if (b.dataset.tog) { setCfg({ [b.dataset.tog]: !S.cfg[b.dataset.tog] }); return; }
    if (b.dataset.cm) { customAction(b.dataset.cm); return; }
    if (b.dataset.view) { setView(b.dataset.view); return; }
    if (b.dataset.act === 'reset') { selectCar(S.carId, null, { silent: true }); toast('Back to factory spec'); return; }
    if (b.dataset.act === 'hear') { hearBuild(); return; }
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.id === 'carSearch') { S.carQuery = t.value; const pos = t.selectionStart; if (S.mobile) renderPanel(); else renderRack(); const n = $('#carSearch'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
    if (t.id === 'engSearch') { S.engQuery = t.value; const pos = t.selectionStart; renderPanel(); const n = $('#engSearch'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
    if (t.id === 'tint') { setCfg({ tint: +t.value }); }
    if (t.id === 'plateIn') { setCfg({ plate: t.value.toUpperCase() }); }
    if (t.id === 'vol') { audio.setVolume(+t.value); store.set('vol', +t.value); }
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'paintPick') setCfg({ paint: t.value });
    if (t.id === 'rimSize') setCfg({ rimSize: +t.value });
    if (t.id === 'rideH') setCfg({ rideHeight: +t.value });
  });
  $('#tXray').addEventListener('click', () => { S.xray = !S.xray; $('#tXray').setAttribute('aria-pressed', S.xray); if (model) { model.setXray(S.xray); studio.preset(S.xray ? 'engine' : S.view, model.engineCenter); } });
  $('#tNight').addEventListener('click', () => { S.night = !S.night; $('#tNight').setAttribute('aria-pressed', S.night); if (studio) { studio.setNight(S.night); model.setNight(S.night); } });
  $('#tSpin').addEventListener('click', () => { S.spin = !S.spin; $('#tSpin').setAttribute('aria-pressed', S.spin); if (studio) studio.controls.autoRotate = S.spin; });
  $('#btnDrive').addEventListener('click', openDrive);
  $('#btnGarage').addEventListener('click', openGarage);
  $('#btnDrag').addEventListener('click', openDrag);
  $('#btnPhoto').addEventListener('click', openPhoto);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') closeModal(); });
  window.addEventListener('keydown', (ev) => {
    if (drive && drive.active) return;
    if (ev.target.matches('input, textarea, select')) return;
    if (ev.key === 'Escape') closeModal();
    if (ev.code === 'Space') { ev.preventDefault(); if (!sound.held) pressRev(true); }
    if (ev.key === 'e' || ev.key === 'E') toggleEngine();
    if (ev.key === 'x' || ev.key === 'X') $('#tXray').click();
    const views = { 1: 'front', 2: 'side', 3: 'rear', 4: 'top', 5: 'engine' };
    if (views[ev.key]) setView(views[ev.key]);
  });
  window.addEventListener('keyup', (ev) => { if (drive && drive.active) return; if (ev.code === 'Space') pressRev(false); });
  // sound lab
  $('#slStart').addEventListener('click', toggleEngine);
  const revBtn = $('#slRev');
  revBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); revBtn.setPointerCapture?.(e.pointerId); pressRev(true); });
  const up = () => pressRev(false);
  revBtn.addEventListener('pointerup', up); revBtn.addEventListener('pointercancel', up); revBtn.addEventListener('lostpointercapture', up);
  $('#slShow').addEventListener('click', revShow);
  $('#slLaunch').addEventListener('click', launch);
  $('#slAB').addEventListener('click', toggleAB);
  $('#slToggle').addEventListener('click', () => {
    const el = $('#soundLab'); const open = el.dataset.open !== 'true';
    el.dataset.open = String(open); $('#slToggle').setAttribute('aria-expanded', open);
    $('#slToggle').innerHTML = open ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 15l6-6 6 6"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
  });
  const mq = window.matchMedia('(max-width: 760px)');
  const onMq = () => {
    S.mobile = mq.matches;
    const strip = $('#statStrip');
    if (S.mobile) $('#stripHolder').appendChild(strip); else $('.stage-bottom').appendChild(strip);
    if (S.mobile && $('#soundLab').dataset.open === 'true' && !S.ready) $('#slToggle').click();
    renderAll();
  };
  mq.addEventListener ? mq.addEventListener('change', onMq) : mq.addListener(onMq);
  S.mobile = mq.matches;
  if (S.mobile) { $('#stripHolder').appendChild($('#statStrip')); $('#soundLab').dataset.open = 'false'; }
}

function setView(v) {
  S.view = v;
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  if (v === 'engine' && !S.xray) { S.xray = true; $('#tXray').setAttribute('aria-pressed', 'true'); model?.setXray(true); }
  if (v !== 'engine' && S.xray) { S.xray = false; $('#tXray').setAttribute('aria-pressed', 'false'); model?.setXray(false); }
  if (studio && model) studio.preset(v, model.engineCenter);
}

function swapEngine(id) {
  const c = car();
  const e = ENGINE_BY_ID[id];
  const patch = { engineId: id };
  if (id === c.engine) { patch.gearbox = 'auto'; patch.drive = 'auto'; }
  if (e.fuel === 'electric') { Object.assign(patch, { exhaust: 'stock', intake: 'stock', fi: 'none', nitrous: 'none', fuelsys: 'petrol' }); }
  if (e.fuel !== 'petrol') patch.fuelsys = 'petrol';
  if (e.asp !== 'NA' && S.cfg.intake === 'itb') patch.intake = 'stock';
  if (e.orient === 'BIKE') patch.gearbox = 'auto';
  setCfg(patch);
  const a = S.a;
  toast(id === c.engine ? `Back to the factory ${e.name}` : `${e.name} fitted: ${a.fit.label.toLowerCase()}, ${Math.round(a.m.hpNos)} hp`);
  if (sound.on) { sound.ab = 'build'; $('#slAB').setAttribute('aria-pressed', 'false'); $('#slAB').textContent = 'Hear stock'; }
}

// ---------------------------------------------------------------- real 3D models
let customToken = 0;
function modelPicker() {
  let inp = $('#modelFile');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file'; inp.id = 'modelFile'; inp.multiple = true; inp.accept = MODEL_ACCEPT; inp.hidden = true;
    document.body.appendChild(inp);
    inp.addEventListener('change', () => { const f = [...inp.files]; inp.value = ''; if (f.length) importModel(f); });
  }
  return inp;
}

function setCustomState(cc, rec) {
  S.custom = cc ? { carId: S.carId, name: rec.name, stats: cc.stats, wheels: (cc.wheels || []).length, paint: cc.paintMats.length > 0, paintOn: rec.paint !== false, orient: rec.orient } : null;
  if (model) { model.customPaint = !cc || rec.paint !== false; model.setCustom(cc || null); }
  if (S.tab === 'body') renderPanel();
}

async function buildCustom(entries, rec) {
  const parsed = await parseModel(entries);
  const cc = new CustomCar(parsed.object, { name: parsed.name, kind: parsed.kind });
  const auto = cc.fit(car(), rec.orient || null);
  if (auto) rec.orient = auto;
  rec.name = rec.name || parsed.name;
  return cc;
}

async function importModel(files) {
  if (!model) { toast('3D view is not available on this device'); return; }
  const token = ++customToken; const carId = S.carId;
  S.customBusy = true; if (S.tab === 'body') renderPanel();
  toast('Loading 3D model...');
  try {
    const entries = await readModelFiles(files);
    const rec = { name: null, entries, orient: null, paint: true, savedAt: Date.now() };
    const cc = await buildCustom(entries, rec);
    if (token !== customToken || carId !== S.carId) { cc.dispose(); return; }
    setCustomState(cc, rec);
    const bytes = entries.reduce((n, e) => n + e.data.byteLength, 0);
    const saved = bytes < 300e6 ? await saveModel(carId, rec) : false;
    S.customRec = rec;
    toast(`${rec.name} loaded${saved ? ' and saved for this car' : ''}. Use Turn around if it faces backwards.`);
  } catch (e) {
    toast(`Could not load that model: ${String(e && e.message || e).slice(0, 90)}`);
  } finally { S.customBusy = false; if (S.tab === 'body') renderPanel(); }
}

async function loadCustomFor(carId) {
  const token = ++customToken;
  if (S.custom && S.custom.carId !== carId) setCustomState(null);
  const rec = await loadModelRecord(carId);
  if (token !== customToken || carId !== S.carId) return;
  if (!rec) { if (S.custom) setCustomState(null); return; }
  try {
    const cc = await buildCustom(rec.entries, rec);
    if (token !== customToken || carId !== S.carId) { cc.dispose(); return; }
    S.customRec = rec;
    setCustomState(cc, rec);
  } catch (e) { setCustomState(null); }
}

async function customAction(act) {
  if (act === 'load') { modelPicker().click(); return; }
  const rec = S.customRec, cc = model && model.custom;
  if (!rec || !cc) return;
  if (act === 'remove') {
    await deleteModel(S.carId); S.customRec = null; setCustomState(null); toast('Back to the built-in model'); return;
  }
  const o = { ...(rec.orient || { up: 0, yaw: 0 }) };
  if (act === 'turn') o.yaw = ((o.yaw || 0) + 2) % 4;
  if (act === 'rot') o.yaw = ((o.yaw || 0) + 1) % 4;
  if (act === 'up') o.up = ((o.up || 0) + 1) % 3;
  rec.orient = o;
  cc.fit(car(), o);
  model.setRide(S.cfg);
  saveModel(S.carId, rec);
  S.custom.orient = o;
}

function customPaintToggle() {
  const rec = S.customRec; if (!rec || !model || !model.custom) return;
  rec.paint = rec.paint === false;
  model.customPaint = rec.paint;
  model.applyVisuals(S.cfg);
  S.custom.paintOn = rec.paint;
  saveModel(S.carId, rec);
  renderPanel();
}

// ---------------------------------------------------------------- sound lab
function currentSoundTarget() {
  const c = car();
  if (sound.ab === 'stock') { const st = stockFor(c); return { engine: st.engine, curve: st.veh.curve, cfg: st.cfg, run: st.m.run, veh: st.veh }; }
  return { engine: S.a.engine, curve: S.a.veh.curve, cfg: S.cfg, run: S.a.m.run, veh: S.a.veh };
}

function updateAudioEngine() {
  const t = currentSoundTarget();
  audio.setProfile(t.engine, t.cfg, car());
  rev.setEngine(t.engine, t.curve, t.cfg, car());
  const ev = t.engine.fuel === 'electric';
  $('#slStart').textContent = rev.on ? (ev ? 'Power off' : rev.running ? 'Stop engine' : 'Starting...') : ev ? 'Power on' : 'Start engine';
  $('#slNote').textContent = soundNote(t.engine, t.cfg);
}

function soundNote(e, cfg) {
  const ex = { stock: 'stock muffler', sport: 'sport exhaust', straight: 'straight pipe' }[cfg.exhaust || 'stock'];
  if (e.fuel === 'electric') return `${e.name}: electric whine, no exhaust. Hold to spin the motor.`;
  const firing = Math.round(((e.idle || 800) / 60) * ((e.cyl || 4) / (e.layout === 'R2' ? 1 : 2)));
  const ch = { i3: 'three-cylinder thrum', i4: 'four-cylinder buzz', i6: 'smooth inline-six howl', v6: 'V6 growl', v8: 'cross-plane V8 burble', boxer: 'boxer rumble', rotary: 'rotary brap', d4: 'diesel clatter', d6: 'big diesel thump', bike: 'superbike scream' }[e.snd?.p] || 'engine note';
  const st = startParams(e, cfg, car());
  const how = st.kind === 'hybrid' ? 'Hybrid start: the motor spins it up, no starter.'
    : st.kind === 'bike' ? 'Bike starter whirr, then it barks to life.'
      : st.glow > 0 ? `Glow plugs, then a heavy ${st.dur.toFixed(1)} s diesel crank.`
        : st.coughs.length ? `Carb-style start: about ${st.dur.toFixed(1)} s of cranking with ${st.coughs.length > 1 ? 'a couple of coughs' : 'a cough'}.`
          : `Starter cranks about ${st.dur.toFixed(1)} s before it catches.`;
  return `${e.name}: ${ch} on a ${ex}, ${firing} Hz firing pulse at idle. ${how} Space revs, E starts.`;
}

async function ensureAudio() {
  try { await audio.init(); audio.setVolume(store.get('vol', 0.75)); updateAudioEngine(); return true; }
  catch (e) { toast('Sound is not available in this browser'); return false; }
}

// After a car or engine swap with the engine running: switch off, then start the new one,
// so every swap is heard from the starter onwards.
let restartTimer = null;
function restartEngineSoon() {
  if (!rev.on || !audio.ready) return;
  clearTimeout(restartTimer);
  rev.stop();
  updateAudioEngine();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (sound.on && !rev.on) { rev.start(); updateAudioEngine(); }
  }, 1000);
}

async function toggleEngine() {
  clearTimeout(restartTimer); restartTimer = null;
  if (!(await ensureAudio())) return;
  sound.launch = null;
  if (rev.on) { rev.stop(); sound.on = false; }
  else { rev.start(); sound.on = true; }
  updateAudioEngine();
}

async function pressRev(down) {
  sound.held = down;
  $('#slRev').classList.toggle('held', down);
  if (down) {
    if (!(await ensureAudio())) return;
    sound.launch = null;
    if (!rev.on) { rev.start(); sound.on = true; updateAudioEngine(); }
  }
}

async function revShow() {
  if (!(await ensureAudio())) return;
  sound.launch = null;
  if (!rev.on) { rev.start(); sound.on = true; updateAudioEngine(); }
  sound.showT = 0.001;
}

async function hearBuild() {
  sound.ab = 'build';
  $('#slAB').setAttribute('aria-pressed', 'false'); $('#slAB').textContent = 'Hear stock';
  if (!(await ensureAudio())) return;
  updateAudioEngine();
  if (!rev.on) { rev.start(); sound.on = true; updateAudioEngine(); }
  sound.showT = 0.001;
  if ($('#soundLab').dataset.open !== 'true') $('#slToggle').click();
}

async function toggleAB() {
  sound.ab = sound.ab === 'build' ? 'stock' : 'build';
  $('#slAB').setAttribute('aria-pressed', String(sound.ab === 'stock'));
  $('#slAB').textContent = sound.ab === 'stock' ? 'Hear build' : 'Hear stock';
  if (!(await ensureAudio())) return;
  sound.launch = null;
  updateAudioEngine();
  if (!rev.on) { rev.start(); sound.on = true; updateAudioEngine(); }
  toast(sound.ab === 'stock' ? `Playing the stock ${stockFor(car()).engine.name}` : `Playing your build: ${S.a.engine.name}`);
}

async function launch() {
  if (!(await ensureAudio())) return;
  const t = currentSoundTarget();
  if (!rev.on) { rev.start(); sound.on = true; updateAudioEngine(); }
  const run = t.run;
  const end = Math.min(run.t[run.t.length - 1], (run.marks.t200 || 40) + 1.5, 45);
  sound.launch = { t: -1.4, run, end, lastGear: 1, lastShift: 0, engine: t.engine, cfg: t.cfg, curve: t.curve, gb: t.veh.gbId, done: false };
  toast(`Launch: ${t.engine.name}${run.marks.t100 ? `, 0-100 in ${run.marks.t100.toFixed(1)} s` : ''}`);
}

function sampleRun(run, t) {
  let lo = 0, hi = run.t.length - 1;
  if (t <= run.t[0]) return 0;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (run.t[m] > t) hi = m; else lo = m; }
  return lo;
}

let flameT = 0, tachoT = 0, wheelDist = 0, lastFrameAt = 0;
function frame() {
  const now = performance.now();
  const dt = lastFrameAt ? Math.min(0.5, (now - lastFrameAt) / 1000) : 1 / 60;
  lastFrameAt = now;
  const subs = Math.max(1, Math.ceil(dt / (1 / 120)));
  const sdt = dt / subs;
  const stepRev = () => { let s; for (let k = 0; k < subs; k++) s = rev.step(sdt); return s; };
  // sound and gauges
  let state = null; let gauge = null;
  const L = sound.launch;
  if (L && !L.done) {
    if (rev.running || L.t >= 0) L.t += dt;
    if (L.t < 0 && !rev.running) {
      // still cranking: let the start play out before the launch
      const s = stepRev();
      state = { ...s, slip: 0, speed: 0 };
      gauge = { rpm: rev.rpm, speed: 0, gear: 0, boost: 0 };
    } else if (L.t < 0) {
      // pre-launch: hold revs at launch rpm
      rev.throttle = 1;
      const s = stepRev();
      const lr = L.engine.fuel === 'electric' ? 0 : Math.min(L.curve.redline * 0.7, Math.max(L.curve.rpmAtNm + 300, 3000));
      if (rev.rpm > lr && L.engine.fuel !== 'electric') rev.rpm = lr;
      state = { ...s, rpm: rev.rpm, load: 0.6, speed: 0, slip: 0 };
      gauge = { rpm: rev.rpm, speed: 0, gear: 1, boost: s.boost };
    } else {
      const i = sampleRun(L.run, L.t);
      const r = L.run;
      const rpm = r.rpm[i], v = r.v[i] * 3.6, gear = r.gear[i], shifting = r.shift[i], slip = r.slip[i];
      if (gear !== L.lastGear) {
        if (L.engine.fuel !== 'electric') {
          audio.trigger('shift');
          const turbo = L.curve.boost && (L.curve.boost.kind === 'turbo' || L.curve.boost.kind === 'twin');
          if (turbo && r.boost[i] > 0.4 && ['MT4', 'MT5', 'MT6', 'AGS5', 'SEQ6'].includes(L.gb || '')) audio.trigger('bov', 0.7);
          if (rev.pops) { audio.trigger('pop', 0.9); flameT = 0.08; }
        }
        L.lastGear = gear;
      }
      rev.rpm = rpm; rev.boost = r.boost[i];
      state = { rpm, load: shifting ? 0.15 : 1, boost: r.boost[i], cut: shifting && L.engine.fuel !== 'electric' ? 1 : 0, slip: slip ? Math.min(1, 0.6 + v / 120) : 0, speed: v, on: 1, starter: 0, crank: 0 };
      gauge = { rpm, speed: v, gear, boost: r.boost[i] };
      wheelDist = r.x[i] || 0;
      if (L.t >= L.end) {
        L.done = true; rev.rpm = Math.min(rpm, rev.redline * 0.6); rev.throttle = 0;
        if (rev.pops) { audio.trigger('pop', 1); flameT = 0.1; }
        const tq = r.marks.t100 ? `0-100 ${r.marks.t100.toFixed(1)} s` : '';
        const t2 = r.marks.t200 ? ` · 0-200 ${r.marks.t200.toFixed(1)} s` : '';
        toast(`${tq}${t2}${r.marks.tQ ? ` · quarter mile ${r.marks.tQ.toFixed(1)} s` : ''}`);
        sound.launch = null;
      }
    }
  } else {
    if (sound.showT > 0) {
      if (rev.running) sound.showT += dt;
      const t = sound.showT;
      const seq = [[0.4, 0], [0.75, 1], [1.4, 0], [1.6, 1], [1.85, 0], [2.05, 1], [2.3, 0], [2.6, 1], [3.6, 1], [4.6, 0]];
      let thr = 0; for (const [tt, v] of seq) if (t >= tt) thr = v;
      rev.throttle = thr;
      if (t > 5) { sound.showT = 0; rev.throttle = 0; }
    } else rev.throttle = sound.held ? 1 : 0;
    const s = stepRev();
    state = { ...s, slip: 0, speed: 0 };
    gauge = { rpm: rev.rpm, speed: 0, gear: 0, boost: s.boost };
  }
  for (const e of rev.drain()) {
    if (e.type === 'pop') { audio.trigger('pop', e.v); flameT = 0.07; }
    else if (e.type === 'bov') audio.trigger('bov', e.v);
    else if (e.type === 'cough') { audio.trigger('cough', 1); if (rev.pops) flameT = 0.05; }
    else if (['click', 'catch', 'ready', 'poweroff', 'shudder'].includes(e.type)) audio.trigger(e.type, e.v);
    if (e.type === 'catch' || e.type === 'ready') { const b = $('#slStart'); if (b) b.textContent = e.type === 'ready' ? 'Power off' : 'Stop engine'; }
  }
  if (state && audio.ready) audio.setState({ ...state, master: 1 });
  if (model) {
    if (flameT > 0) { flameT -= dt; model.setFlames(true); } else model.setFlames(false);
    if (sound.launch && !sound.launch.done) model.spinWheels(wheelDist);
  }
  tachoT += dt;
  if (tachoT > 1 / 30 && $('#soundLab').dataset.open === 'true') {
    tachoT = 0;
    const t = currentSoundTarget();
    const ev = t.engine.fuel === 'electric';
    const maxRpm = ev ? t.curve.maxRpm : Math.ceil((t.curve.redline + 600) / 1000) * 1000;
    drawTacho($('#tacho'), { rpm: gauge ? gauge.rpm : 0, redline: t.curve.redline, maxRpm, speed: gauge ? gauge.speed : 0, gear: gauge ? gauge.gear : 0, boost: gauge ? gauge.boost : 0, boostOn: t.curve.boost && t.curve.boost.kind !== 'none', ev });
  }
}

// ---------------------------------------------------------------- drive mode (open world)
function buildKey() {
  const j = JSON.stringify(S.cfg);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < j.length; i++) { h ^= j.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return `${S.carId}-${h.toString(36)}`;
}

async function openDrive() {
  if (!studio || !model) { toast('Driving needs the 3D view (WebGL 2)'); return; }
  closeModal();
  sound.launch = null; sound.showT = 0; sound.ab = 'build';
  if (!drive) {
    const { DriveMode } = await import('./drive/drive.js');
    drive = new DriveMode({
      studio, model, audio, rev, store, toast,
      stage: $('#stage'),
      ensureAudio,
      syncAudio: () => updateAudioEngine(),
      getBuild: () => ({ car: car(), cfg: S.cfg, a: S.a }),
      buildName: () => `${car().brand} ${car().model} · ${S.a.engine.name}`,
      buildKey,
      setVolume: (v) => { audio.setVolume(v); store.set('vol', v); $('#vol').value = v; },
      onExit: () => { sound.on = rev.on; updateAudioEngine(); renderHeaderBits(); },
    });
  }
  await drive.enter();
}

// ---------------------------------------------------------------- modals
let modalCleanup = null;
function openModal(title, html, onOpen) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
  modalCleanup = onOpen ? onOpen() : null;
  setTimeout(() => $('#modalClose').focus(), 30);
}
function closeModal() { if ($('#modal').hidden) return; $('#modal').hidden = true; if (modalCleanup) modalCleanup(); modalCleanup = null; }

function encodeBuild() {
  const data = { v: 1, car: S.carId, cfg: S.cfg };
  return 'PSW1.' + btoa(unescape(encodeURIComponent(JSON.stringify(data))));
}
function decodeBuild(code) {
  const s = code.trim().replace(/^PSW1\./, '');
  const data = JSON.parse(decodeURIComponent(escape(atob(s))));
  if (!CAR_BY_ID[data.car]) throw new Error('Unknown car');
  return data;
}

function openGarage() {
  const builds = store.get('builds', []);
  const list = () => {
    const b = store.get('builds', []);
    return b.length ? b.map((x, i) => `<div class="buildrow"><b>${esc(x.name)}</b><button type="button" class="btn" data-load="${i}">Load</button><button type="button" class="btn ghost" data-del="${i}" aria-label="Delete ${esc(x.name)}">Delete</button><span>${esc(CAR_BY_ID[x.car]?.brand)} ${esc(CAR_BY_ID[x.car]?.model)} · ${esc(ENGINE_BY_ID[x.cfg.engineId]?.name)} · ${esc(new Date(x.at).toLocaleDateString())}</span></div>`).join('') : '<p class="hint">No saved builds yet. Name this build and save it.</p>';
  };
  void builds;
  openModal('Your garage', `
    <div class="group"><div class="label"><span>Save this build</span></div>
      <div class="sl-row"><input class="search" id="buildName" maxlength="40" placeholder="${esc(car().model)} ${esc(S.a.engine.name)} build" aria-label="Build name"><button type="button" class="btn primary" id="saveBuild">Save</button></div>
      <p class="hint">Builds are kept in this browser only.</p></div>
    <div class="group"><div class="label"><span>Saved builds</span></div><div id="buildList" style="display:grid;gap:6px">${list()}</div></div>
    <div class="group"><div class="label"><span>Share with a friend</span></div>
      <textarea class="code" id="buildCode" readonly aria-label="Build code">${esc(encodeBuild())}</textarea>
      <div class="sl-row"><button type="button" class="btn" id="copyCode">Copy build code</button></div>
      <textarea class="code" id="pasteCode" placeholder="Paste a build code here" aria-label="Paste build code"></textarea>
      <div class="sl-row"><button type="button" class="btn" id="loadCode">Load pasted code</button></div></div>`, () => {
    const body = $('#modalBody');
    const handler = (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.id === 'saveBuild') {
        const name = ($('#buildName').value || $('#buildName').placeholder).trim();
        const all = store.get('builds', []); all.unshift({ name, car: S.carId, cfg: S.cfg, at: Date.now() });
        if (store.set('builds', all.slice(0, 40))) { $('#buildList').innerHTML = list(); toast('Build saved'); } else toast('This browser blocked saving. Copy the build code instead.');
      }
      if (b.dataset.load != null) { const x = store.get('builds', [])[+b.dataset.load]; if (x) { selectCar(x.car, x.cfg, { silent: true }); closeModal(); toast(`${x.name} loaded`); } }
      if (b.dataset.del != null) { const all = store.get('builds', []); all.splice(+b.dataset.del, 1); store.set('builds', all); $('#buildList').innerHTML = list(); }
      if (b.id === 'copyCode') {
        const ta = $('#buildCode');
        const ok = () => toast('Build code copied');
        try { navigator.clipboard.writeText(ta.value).then(ok, () => { ta.focus(); ta.select(); toast('Select and copy the code'); }); } catch (e) { ta.focus(); ta.select(); toast('Select and copy the code'); }
      }
      if (b.id === 'loadCode') {
        try { const d = decodeBuild($('#pasteCode').value); selectCar(d.car, d.cfg, { silent: true }); closeModal(); toast('Build loaded from code'); } catch (e) { toast('That code is not a valid PakSwap build'); }
      }
    };
    body.addEventListener('click', handler);
    return () => body.removeEventListener('click', handler);
  });
}

function openDrag() {
  const opts = CARS.map((c) => `<option value="${c.id}" ${c.id === 'honda-type-r' ? 'selected' : ''}>${esc(c.brand)} ${esc(c.model)} ${esc(c.trim)}</option>`).join('');
  openModal('Quarter-mile drag race', `
    <div class="group"><div class="label"><span>Opponent (factory spec)</span></div><select class="search" id="opp">${opts}</select></div>
    <canvas class="dragcv" id="dragCv" aria-label="Drag strip"></canvas>
    <div class="sl-row"><button type="button" class="btn primary" id="goDrag">Race</button></div>
    <div class="res" id="dragRes"></div>`, () => {
    let raf = 0; let running = false;
    const lanesFor = () => {
      const opp = CAR_BY_ID[$('#opp').value];
      const so = stockFor(opp);
      return [
        { label: `Your ${car().model} (${S.a.engine.name})`, run: S.a.m.run, color: getComputedStyle(document.documentElement).getPropertyValue('--accent'), m: S.a.m },
        { label: `${opp.brand} ${opp.model} (stock)`, run: so.m.run, color: getComputedStyle(document.documentElement).getPropertyValue('--stock'), m: so.m },
      ];
    };
    const draw = (t) => drawDrag($('#dragCv'), lanesFor(), t);
    draw(0);
    const go = () => {
      if (running) return; running = true;
      const lanes = lanesFor();
      const tEnd = Math.max(...lanes.map((l) => l.m.tQ || 30)) + 0.6;
      const t0 = performance.now();
      $('#dragRes').innerHTML = '';
      const step = () => {
        const t = (performance.now() - t0) / 1000;
        drawDrag($('#dragCv'), lanes, t);
        if (t < tEnd) raf = requestAnimationFrame(step);
        else {
          running = false;
          const win = (lanes[0].m.tQ || 99) <= (lanes[1].m.tQ || 99) ? 0 : 1;
          $('#dragRes').innerHTML = lanes.map((l, i) => `<div class="card" style="${i === win ? 'border-color:var(--accent)' : ''}"><div class="label">${i === win ? 'Winner' : 'Runner-up'}</div><b>${esc(l.label)}</b><div class="num" style="font-size:22px;font-weight:700">${fmt(l.m.tQ, 2)} s</div><div class="hint">${fmt(l.m.vQ)} km/h trap · 0-100 ${fmt(l.m.t100, 1)} s</div></div>`).join('');
        }
      };
      raf = requestAnimationFrame(step);
    };
    const onClick = (ev) => { if (ev.target.id === 'goDrag') go(); };
    const onChange = (ev) => { if (ev.target.id === 'opp') { draw(0); $('#dragRes').innerHTML = ''; } };
    const body = $('#modalBody');
    body.addEventListener('click', onClick); body.addEventListener('change', onChange);
    return () => { cancelAnimationFrame(raf); body.removeEventListener('click', onClick); body.removeEventListener('change', onChange); };
  });
}

function openPhoto() {
  if (!studio) { toast('Build cards need the 3D view'); return; }
  const shot = studio.snapshot(1400);
  const img = new Image();
  img.onload = () => {
    const W = 1400, H = Math.round((W / img.width) * img.height) + 190;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const x = cv.getContext('2d');
    x.fillStyle = '#121110'; x.fillRect(0, 0, W, H);
    x.drawImage(img, 0, 0, W, H - 190);
    const a = S.a, m = a.m, c = car();
    const y0 = H - 190;
    const grd = x.createLinearGradient(0, y0 - 80, 0, y0); grd.addColorStop(0, 'rgba(18,17,16,0)'); grd.addColorStop(1, 'rgba(18,17,16,1)');
    x.fillStyle = grd; x.fillRect(0, y0 - 80, W, 80);
    x.fillStyle = '#f5b301'; x.font = '700 18px "Chakra Petch", sans-serif'; x.fillText('PAKSWAP STUDIO', 40, y0 + 34);
    x.fillStyle = '#efe9e0'; x.font = '700 44px "Chakra Petch", sans-serif'; x.fillText(`${c.brand} ${c.model} · ${a.engine.name}`, 40, y0 + 86);
    x.fillStyle = '#a69d90'; x.font = '500 20px "Archivo", sans-serif'; x.fillText(`${a.verdict.title}: ${a.verdict.sub}`, 40, y0 + 120);
    const stats = [[`${fmt(m.hpNos)} hp`, 'Power'], [`${fmt(m.nm)} Nm`, 'Torque'], [`${fmt(m.t100, 1)} s`, '0-100 km/h'], [`${fmt(m.vmax)} km/h`, 'Top speed'], [`${fmt(m.weight)} kg`, 'Weight']];
    stats.forEach(([v, k], i) => { const sx = 40 + i * 268; x.fillStyle = '#efe9e0'; x.font = '700 30px "Chakra Petch", sans-serif'; x.fillText(v, sx, y0 + 166); x.fillStyle = '#a69d90'; x.font = '600 14px "Chakra Petch", sans-serif'; x.fillText(k.toUpperCase(), sx, y0 + 184); });
    const url = cv.toDataURL('image/png');
    const dl = typeof __ARTIFACT__ !== 'undefined' && __ARTIFACT__ ? '' : `<div class="sl-row"><a class="btn primary" href="${url}" download="pakswap-${c.id}.png">Download image</a></div>`;
    openModal('Build card', `<img class="photo" src="${url}" alt="Build card for ${esc(c.brand)} ${esc(c.model)} with ${esc(a.engine.name)}"><p class="hint">Right-click or long-press the image to save or share it.</p>${dl}`);
  };
  img.src = shot;
}

function openSettings() {
  const q = studio ? studio.quality : 'off';
  openModal('Settings', `
    <div class="group"><div class="label"><span>Graphics quality</span></div><div class="opts">${['high', 'medium', 'low'].map((k) => `<button type="button" class="opt" data-q="${k}" aria-pressed="${q === k}">${k[0].toUpperCase() + k.slice(1)}<small>${k === 'high' ? 'Sharpest, bloom at night' : k === 'medium' ? 'Balanced' : 'Fast on older phones'}</small></button>`).join('')}</div></div>
    <div class="group"><div class="label"><span>Keyboard</span></div><p class="hint">Space: rev · E: start or stop · X: X-ray · 1 to 5: camera views · Esc: close</p></div>
    <div class="group"><div class="label"><span>Drive mode</span></div><p class="hint">Press Drive in the top bar to take this build into the open world. W A S D or arrows: drive · Space: handbrake · N: nitrous · H: horn · C: camera · R: reset to the road · Esc: menu and map · F1: all controls. Gamepads and touch screens work too.</p></div>
    <div class="group"><div class="label"><span>About the numbers</span></div><p class="hint">Factory figures come from published specs for the Pakistani market. Performance is simulated from power curves, gearing, weight, grip and drag, so treat it as a strong estimate, not a guarantee.</p></div>`, () => {
    const body = $('#modalBody');
    const h = (ev) => { const b = ev.target.closest('[data-q]'); if (!b || !studio) return; studio.setQuality(b.dataset.q); store.set('quality', b.dataset.q); body.querySelectorAll('[data-q]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); };
    body.addEventListener('click', h);
    return () => body.removeEventListener('click', h);
  });
}

// ---------------------------------------------------------------- boot
async function boot() {
  bindEvents();
  const last = store.get('last', null);
  if (last && CAR_BY_ID[last.car]) { S.carId = last.car; S.cfg = { ...defaultConfig(CAR_BY_ID[last.car]), ...last.cfg }; }
  else { S.carId = 'suzuki-mehran'; S.cfg = defaultConfig(car()); }
  if (!ENGINE_BY_ID[S.cfg.engineId]) S.cfg.engineId = car().engine;
  recompute();
  renderAll();
  updateAudioEngine();
  $('#vol').value = store.get('vol', 0.75);
  const ok = await init3D();
  if (ok) { buildModel(true); loadCustomFor(S.carId); }
  const stage = $('#stage');
  stage.addEventListener('dragover', (ev) => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) { ev.preventDefault(); stage.classList.add('drop'); } });
  stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
  stage.addEventListener('drop', (ev) => { ev.preventDefault(); stage.classList.remove('drop'); const f = [...(ev.dataTransfer?.files || [])]; if (f.length) importModel(f); });
  $('#loading').classList.add('hide');
  S.ready = true;
  window.__pakswapReady = true;
  window.PakSwap = { state: S, audio, rev, version: '1.2', drive: () => drive, openDrive };
  // frames stop in a background tab, so pause the engine sound instead of letting it hang
  document.addEventListener('visibilitychange', () => {
    if (!audio.ctx) return;
    if (document.hidden) audio.ctx.suspend().catch(() => {});
    else if (sound.on || rev.on) audio.ctx.resume().catch(() => {});
  });
  if (!ok) { // keep tacho alive without 3D
    const tick = () => { frame(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
}

boot().catch((e) => {
  console.error(e);
  const l = $('#loading'); if (l) l.innerHTML = `<div class="ld"><span>Something went wrong while loading</span><span style="text-transform:none;letter-spacing:0">${esc(e.message)}</span></div>`;
});
