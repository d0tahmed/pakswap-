import * as THREE from 'three';
import { Studio } from '../src/three/scene.js';
import { CarModel } from '../src/three/carModel.js';
import { CAR_BY_ID, CARS } from '../src/data/cars.js';
import { ENGINE_BY_ID } from '../src/data/engines.js';
import { defaultConfig } from '../src/data/parts.js';
import { analyse } from '../src/sim/analysis.js';
window.__err = [];
window.addEventListener('error', (e) => window.__err.push(String(e.message)));
const params = new URLSearchParams(location.search);
const studio = new Studio(document.getElementById('v'));
studio.setQuality(params.get('q') || 'medium');
const model = new CarModel();
studio.carSlot.add(model.root);
let frames = 0;
studio.onFrame.push(() => { frames++; });
window.__ids = CARS.map((c) => c.id);

// Build a car and frame it; resolves after a few rendered frames.
window.__show = (id, view = 'side', cfgJson = '{}', night = false, xray = false) => new Promise((resolve) => {
  const car = CAR_BY_ID[id];
  const cfg = { ...defaultConfig(car), ...JSON.parse(cfgJson || '{}') };
  const a = analyse(car, cfg);
  const t0 = performance.now();
  model.build(car, cfg, { veh: a.veh, fit: a.fit, engine: a.engine });
  const ms = performance.now() - t0;
  studio.frameCar(car.dims[0] / 1000, car.dims[2] / 1000);
  studio.setNight(night); model.setNight(night);
  model.setXray(xray);
  studio.preset(view, model.engineCenter); if (studio.tween) studio.tween.dur = 0.0001;
  const f0 = frames;
  const wait = () => { if (frames - f0 >= 3 && !studio.tween) resolve({ ms: Math.round(ms), err: window.__err.slice() }); else requestAnimationFrame(wait); };
  wait();
});

if (params.get('car')) {
  window.__show(params.get('car'), params.get('view') || 'front', params.get('cfg') || '{}', params.get('night') !== '0', params.get('xray') === '1').then((r) => {
    window.__extra = { cam: studio.camera.position.toArray().map((v) => +v.toFixed(2)), tgt: studio.controls.target.toArray().map((v) => +v.toFixed(2)), ...r };
    window.__ready = true;
  });
} else {
  window.__ready = true;
}
