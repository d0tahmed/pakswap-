// Drive mode: open-world driving with the current build. Owns the scene, cameras, physics loop,
// sound hookup, effects, lap timing, drift scoring and the HUD. The studio's renderer is shared.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CarPhysics } from './physics.js';
import { WorldPhysics } from './track.js';
import { buildOpenWorld, nearestRoad } from './openworld.js';
import { OpenWorldView } from './owView.js';
import { SkySystem, TIMES } from './sky.js';
import { Effects } from './effects.js';
import { DriveHud } from './hud.js';
import { DriveInput } from './input.js';

const LOCS = [
  { id: 'pad', label: 'Drift pad' }, { id: 'circuit', label: 'Race circuit' }, { id: 'city', label: 'City' },
  { id: 'motorway', label: 'Motorway' }, { id: 'mountain', label: 'Murree Road' }, { id: 'village', label: 'Village' }, { id: 'lake', label: 'Lake' },
];
const AIDS = { drift: { assist: 0.6, tcs: false, esc: false }, grip: { assist: 0.3, tcs: true, esc: true }, sim: { assist: 0, tcs: false, esc: false } };
const CAMS = [
  { id: 'chase', label: 'Chase' }, { id: 'far', label: 'Far chase' }, { id: 'hood', label: 'Hood' }, { id: 'bumper', label: 'Bumper' },
  { id: 'tv', label: 'TV' }, { id: 'drone', label: 'Drone' }, { id: 'orbit', label: 'Orbit' },
];
const TARMAC = new Set(['asphalt', 'concrete', 'kerb', 'sidewalk']);
const DUSTY = new Set(['grass', 'gravel', 'dirt', 'sand', 'field', 'rock']);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const DT = 1 / 240;

export class DriveMode {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    const saved = ctx.store.get('drive', {}) || {};
    this.set = { loc: 'pad', time: 'day', aids: 'drift', gear: 'auto', cam: 'chase', ...saved };
    if (!AIDS[this.set.aids]) this.set.aids = 'drift';
    if (!TIMES[this.set.time]) this.set.time = 'day';
    this.D = { chain: 0, mult: 1, time: 0, idle: 0, best: ctx.store.get('driftBest', 0) || 0, total: 0, active: false, angle: 0, keep: 0 };
    this.lap = { started: false, t0: 0, sector: 0, invalid: false, last: null, best: null, trace: [], bestTrace: null, lapN: 0, s: null };
    this.cam = { yaw: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), lookYaw: 0, lookPitch: 0, lookT: 0, shake: 0, orbit: { yaw: 0.6, pitch: 0.35, dist: 9 }, tv: null, fov: 60 };
    this.body = { roll: 0, rollV: 0, pitch: 0, pitchV: 0 };
    this.lights = 1;
    this.t = 0;
    // scratch objects reused every frame, so driving creates no garbage
    this.tmp = { size: new THREE.Vector2(), target: new THREE.Vector3(), want: new THREE.Vector3(), local: new THREE.Vector3(), fwd: new THREE.Vector3(), v3: new THREE.Vector3(), hw: [0, 0, 0, 0] };
  }

  // ---------------------------------------------------------------- enter / exit
  async enter() {
    if (this.active) return;
    const ctx = this.ctx, studio = ctx.studio;
    this.active = true;
    this.paused = false;
    document.body.classList.add('driving');
    if (!this.hud) {
      this.hud = new DriveHud(ctx.stage, { onAction: (a, v) => this.action(a, v) });
      this.hud.setOptions({ cams: CAMS });
      this.hud.setLocations(LOCS);
    }
    this.hud.el.hidden = false;
    this.hud.loading(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const quality = studio.tier;
    try {
      if (!this.world) this.world = buildOpenWorld({ quality });
      if (!this.view || this.viewQuality !== quality) {
        if (this.view) { this.scene.remove(this.view.group); this.view.dispose(); }
        this.buildScene(quality);
      }
    } catch (e) {
      console.error(e);
      this.hud.loading(false);
      this.active = false;
      document.body.classList.remove('driving');
      this.hud.el.hidden = true;
      ctx.toast('Could not build the 3D world on this device');
      return;
    }
    this.wp = new WorldPhysics(this.world);
    // the car leaves the studio turntable
    const model = ctx.model;
    this.saved = { parent: model.root.parent, xray: model.xray, night: model.night, beams: (model.beams || []).map((b) => ({ i: b.intensity, d: b.distance, a: b.angle, decay: b.decay })), tail: (model.taillights || []).map((t) => t.material.emissiveIntensity) };
    model.setXray(false);
    this.scene.add(model.root);
    // physics from the current build
    this.buildPhysics();
    this.teleport(this.set.loc, true);
    // renderer: drive look
    const r = studio.renderer;
    this.savedR = { exposure: r.toneMappingExposure, shadows: r.shadowMap.enabled };
    if (!this.camera) { this.camera = new THREE.PerspectiveCamera(60, 1, 0.25, 12000); this.camera.layers.enable(1); }
    r.shadowMap.autoUpdate = true;
    this.applyQuality();
    this.setTime(this.set.time, true);
    this.acc = 0;
    this.camSnap = true;
    studio.controls.enabled = false;
    studio.driver = this;
    // input
    this.input = new DriveInput(r.domElement, (a) => this.action(a));
    this.input.bindTouch(this.hud.el.querySelector('.dv-touch'));
    this.hud.setOptions({ time: this.set.time, aids: this.set.aids, gear: this.set.gear, cam: this.set.cam, volume: ctx.audio.volume, build: ctx.buildName(), touch: matchMedia('(pointer: coarse)').matches });
    this.hud.setMapData(this.world);
    this.hud.loading(false);
    if (!ctx.store.get('driveHelpSeen', false)) { this.hud.help(true); ctx.store.set('driveHelpSeen', true); }
    // engine: start it with the starter if it is not running
    const okAudio = await ctx.ensureAudio();
    const rev = ctx.rev;
    if (okAudio) {
      ctx.audio.setSpace('open');
      ctx.syncAudio();
      if (!rev.running) { if (!rev.on) rev.start(); this.phys.engineOn = false; this.hud.message('Starting the engine', '', 2); }
      else { this.phys.engineOn = true; this.phys.rpm = rev.rpm; }
    } else this.phys.engineOn = true;
  }

  exit() {
    if (!this.active) return;
    const ctx = this.ctx, studio = ctx.studio, model = ctx.model;
    this.active = false;
    studio.driver = null;
    studio.controls.enabled = true;
    this.input?.dispose(); this.input = null;
    this.hud.menu(false); this.hud.help(false);
    this.hud.el.hidden = true;
    document.body.classList.remove('driving');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    // the car goes back to the studio
    (this.saved.parent || studio.carSlot).add(model.root);
    model.root.position.set(0, 0, 0); model.root.rotation.set(0, 0, 0);
    if (model.body) model.body.rotation.set(0, 0, 0);
    if (model.custom) model.custom.root.rotation.set(0, 0, 0);
    for (let i = 0; i < 4; i++) model.setWheelPose?.(i, 0, 0);
    (model.beams || []).forEach((b, i) => { const s = this.saved.beams[i]; if (s) { b.intensity = s.i; b.visible = s.i > 0; b.distance = s.d; b.angle = s.a; b.decay = s.decay; } });
    model.setNight(this.saved.night);
    (model.taillights || []).forEach((t, i) => { t.material.emissiveIntensity = this.saved.tail[i] ?? t.material.emissiveIntensity; });
    model.setXray(this.saved.xray);
    model.setFlames(false);
    const r = studio.renderer;
    r.toneMappingExposure = this.savedR.exposure;
    studio.setNight(studio.night);
    r.shadowMap.autoUpdate = false;
    studio.applyTier();
    // hand the revs back to the free-revving engine model
    const rev = ctx.rev;
    if (this.phys && this.phys.engineOn) { rev.rpm = Math.max(rev.idle || 0, Math.min(this.phys.rpm, (rev.redline || 6000) * 0.8)); rev.throttle = 0; }
    ctx.audio.setState({ slip: 0, speed: 0, surf: 0, rough: 0, scrape: 0, horn: 0, scrub: 0 });
    if (ctx.audio.ready) ctx.audio.setSpace('garage');
    ctx.store.set('drive', this.set);
    ctx.onExit?.();
  }

  buildScene(quality) {
    const studio = this.ctx.studio;
    if (!this.scene) this.scene = new THREE.Scene();
    if (!this.sky) this.sky = new SkySystem(studio.renderer, this.scene);
    this.view = new OpenWorldView(this.world, { quality });
    this.viewQuality = quality;
    this.scene.add(this.view.group);
    if (this.fx) this.fx.dispose();
    this.fx = new Effects(this.scene, quality);
    // trackside camera spots along the roads
    this.tvSpots = [];
    for (const rd of this.world.roads) {
      const rb = rd.rb, step = Math.max(1, Math.round(150 / rb.ds));
      for (let i = 0; i < rb.n; i += step) {
        const side = (i / step) % 2 ? 1 : -1, o = (rd.type.half + 14) * side;
        const x = rb.x[i] - rb.ty[i] * o, y = rb.y[i] + rb.tx[i] * o;
        this.tvSpots.push({ x, y, h: this.world.heightAt(x, y) + 5.5 });
      }
    }
    const cc = this.world.circuit;
    for (let i = 0; i < cc.n; i += 45) { const o = (cc.half + 16) * (cc.ks[i] > 0 ? -1 : 1); this.tvSpots.push({ x: cc.x[i] - cc.ty[i] * o, y: cc.y[i] + cc.tx[i] * o, h: 6 }); }
  }

  applyQuality() {
    const studio = this.ctx.studio, r = studio.renderer, q = studio.tier;
    r.shadowMap.enabled = q !== 'low';
    this.sky.sun.castShadow = q !== 'low';
    const n = q === 'high' ? 2048 : 1024;
    if (this.sky.sun.shadow.mapSize.x !== n) { this.sky.sun.shadow.mapSize.set(n, n); this.sky.sun.shadow.map?.dispose(); this.sky.sun.shadow.map = null; }
    if (this.composer) { this.composer.dispose(); this.bloom?.dispose?.(); this.composer = null; this.bloom = null; }
    if (q === 'high') {
      const size = r.getSize(new THREE.Vector2());
      const pr = r.getPixelRatio();
      const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples: 4 });
      const c = new EffectComposer(r, rt);
      c.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.2, 0.45, 0.9);
      c.addPass(this.bloom);
      c.addPass(new OutputPass());
      this.composer = c;
      this.compSize = [size.x, size.y, pr];
    }
  }

  buildPhysics() {
    const b = this.ctx.getBuild();
    this.build = b;
    const A = AIDS[this.set.aids];
    this.phys = new CarPhysics(b.a.veh, { ...A, manual: this.set.gear === 'manual' });
    this.geo = this.ctx.model.geo;
    this.isDiesel = b.a.engine.fuel === 'diesel';
    this.isEV = b.a.engine.fuel === 'electric';
    this.turbo = b.a.veh.curve.boost && (b.a.veh.curve.boost.kind === 'turbo' || b.a.veh.curve.boost.kind === 'twin');
    this.prev = { x: 0, y: 0, psi: 0 };
    this.lastThr = 0; this.popWin = 0; this.popT = 0; this.flameT = 0;
    this.lapReset();
  }

  // ---------------------------------------------------------------- places
  teleport(id, quiet) {
    const W = this.world;
    const sp = W.spawns[id] || W.spawns.pad;
    const p = this.phys;
    p.reset(sp.x, sp.y, sp.psi);
    p.engineOn = this.ctx.rev.running || !this.ctx.audio.ready;
    if (p.engineOn) p.rpm = Math.max(p.idle, this.ctx.rev.rpm || p.idle);
    this.prev = { x: p.x, y: p.y, psi: p.psi };
    this.set.loc = id;
    this.safe = { x: sp.x, y: sp.y, psi: sp.psi };
    this.cam.yaw = sp.psi; this.cam.tv = null;
    this.camSnap = true;
    if (id === 'pad' || id === 'circuit') this.wp.resetCones();
    this.lapReset();
    this.view.updateTerrain(sp.x, sp.y, 1000);
    this.areaT = 0;
    this.hud.setMode(id);
    if (!quiet) this.hud.message(LOCS.find((l) => l.id === id)?.label || '', '', 1.6);
  }

  resetCar() {
    const p = this.phys, W = this.world;
    const nr = nearestRoad(W, p.x, p.y, 60);
    const inPark = Math.abs(p.x) < 470 && Math.abs(p.y) < 340;
    if (nr && !inPark) {
      const rb = nr.rd.rb, i = nr.i;
      let dir = Math.atan2(rb.ty[i], rb.tx[i]);
      const same = Math.cos(wrap(dir - p.psi)) >= 0;
      if (!same) dir = wrap(dir + Math.PI);
      const s = same ? 1 : -1, off = (nr.rd.type.lanes ? nr.rd.type.lanes[nr.rd.type.lanes.length - 1] : 2) * s;
      p.reset(rb.x[i] - rb.ty[i] * off, rb.y[i] + rb.tx[i] * off, dir);
    } else if (inPark) {
      const c = W.nearestOnCircuit(p.x, p.y, 25);
      if (c) { const cc = W.circuit; p.reset(cc.x[c.i] - cc.ty[c.i] * clamp(c.lat, -3, 3), cc.y[c.i] + cc.tx[c.i] * clamp(c.lat, -3, 3), Math.atan2(cc.ty[c.i], cc.tx[c.i])); }
      else p.reset(p.x, p.y, p.psi);
    } else p.reset(this.safe.x, this.safe.y, this.safe.psi);
    p.engineOn = this.ctx.rev.running || !this.ctx.audio.ready;
    if (p.engineOn) p.rpm = p.idle;
    this.prev = { x: p.x, y: p.y, psi: p.psi };
    this.camSnap = true;
    this.D.chain = 0; this.D.time = 0; this.D.mult = 1;
  }

  // ---------------------------------------------------------------- settings and actions
  action(a, v) {
    const p = this.phys;
    switch (a) {
      case 'menu': this.setPaused(!this.hud.menuOpen); break;
      case 'help': this.hud.help(!this.hud.helpOpen); break;
      case 'exit': this.exit(); break;
      case 'camera': { const i = CAMS.findIndex((c) => c.id === this.set.cam); this.setCam(CAMS[(i + 1) % CAMS.length].id); break; }
      case 'cam': this.setCam(v); break;
      case 'loc': this.teleport(v); this.setPaused(false); break;
      case 'time': {
        if (v) this.setTime(v);
        else { const k = Object.keys(TIMES); this.setTime(k[(k.indexOf(this.set.time) + 1) % k.length]); }
        break;
      }
      case 'aids': {
        const k = Object.keys(AIDS);
        const nv = v || k[(k.indexOf(this.set.aids) + 1) % k.length];
        this.set.aids = nv; Object.assign(p, AIDS[nv]);
        this.hud.setOptions({ aids: nv });
        this.hud.message(`Driving aids: ${{ drift: 'Drift', grip: 'Grip', sim: 'Off' }[nv]}`, '', 1.4);
        break;
      }
      case 'gear': case 'gearbox': {
        const nv = v || (this.set.gear === 'auto' ? 'manual' : 'auto');
        this.set.gear = nv; p.manual = nv === 'manual';
        this.hud.setOptions({ gear: nv });
        if (!v) this.hud.message(nv === 'manual' ? 'Manual: E up, Q down' : 'Automatic gearbox', '', 1.4);
        break;
      }
      case 'shiftUp': if (this.set.gear === 'manual' || p.gear <= 0) p.shiftUp(); break;
      case 'shiftDown': if (this.set.gear === 'manual' || p.gear <= 1) p.shiftDown(); break;
      case 'reset': this.resetCar(); break;
      case 'lights': this.lights = (this.lights + 1) % 3; this.applyLights(); this.hud.message(['Headlights off', 'Dipped beam', 'Main beam'][this.lights], '', 1); break;
      case 'engine': {
        const rev = this.ctx.rev;
        if (rev.on) { rev.rpm = p.rpm; rev.stop(); p.engineOn = false; }
        else { rev.start(); p.engineOn = false; }
        break;
      }
      case 'fullscreen': {
        const el = this.ctx.stage;
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        else el.requestFullscreen?.().catch(() => this.hud.message('Fullscreen is not allowed here', '', 1.5));
        break;
      }
      case 'volume': this.ctx.setVolume(v); break;
      case 'reset-car': this.resetCar(); break;
      default: break;
    }
    if (a === 'reset' && this.hud.menuOpen) this.setPaused(false);
    this.ctx.store.set('drive', this.set);
  }

  setPaused(on) {
    this.paused = on;
    this.hud.menu(on);
    if (on) this.hud.drawWorldMap(this.phys.x, this.phys.y, this.phys.psi, LOCS.map((l) => ({ ...this.world.spawns[l.id], id: l.id, label: l.label })));
    this.ctx.audio.setState({ master: on ? 0.25 : 1 });
  }

  setCam(id) {
    this.set.cam = id;
    this.cam.tv = null;
    this.camSnap = true;
    this.hud.setOptions({ cam: id });
  }

  setTime(name, quiet) {
    this.set.time = name;
    const T = this.sky.setTime(name);
    const night = name === 'night';
    this.view.setNight(night);
    this.fx.setLight(night ? 0.32 : name === 'evening' ? 0.78 : 1.0);
    this.ctx.studio.renderer.toneMappingExposure = T.exposure;
    if (this.bloom) { this.bloom.strength = night ? 0.6 : 0.16; this.bloom.threshold = night ? 0.72 : 0.92; }
    this.ctx.model.setNight(night || name === 'evening');
    this.lights = night || name === 'evening' ? 1 : 0;
    this.applyLights();
    this.hud.setOptions({ time: name });
    if (!quiet) this.hud.message({ day: 'Afternoon', evening: 'Sunset', night: 'Night' }[name], '', 1.2);
  }

  applyLights() {
    const m = this.ctx.model;
    const on = this.lights > 0;
    for (const b of m.beams || []) { b.intensity = on ? (this.lights === 2 ? 320 : 150) : 0; b.visible = on; b.distance = this.lights === 2 ? 160 : 80; b.angle = this.lights === 2 ? 0.36 : 0.5; b.penumbra = 0.55; b.decay = 1.25; }
    for (const h of m.headlights || []) h.material.emissiveIntensity = on ? 2.6 : 0.35;
    this.tailBase = on ? 1.4 : 0.3;
  }

  // ---------------------------------------------------------------- per frame
  frame(dtRaw) {
    const dt = Math.min(0.05, dtRaw);
    this.t += dt;
    const ctx = this.ctx, p = this.phys, studio = ctx.studio, r = studio.renderer;
    // keep the camera and post chain in step with the canvas size
    const size = r.getSize(this.tmp.size);
    const asp = size.x / Math.max(1, size.y);
    if (Math.abs(this.camera.aspect - asp) > 1e-3) { this.camera.aspect = asp; this.camera.updateProjectionMatrix(); }
    if (this.composer && (this.compSize[0] !== size.x || this.compSize[1] !== size.y || this.compSize[2] !== r.getPixelRatio())) { this.composer.setPixelRatio?.(r.getPixelRatio()); this.composer.setSize(size.x, size.y); this.compSize = [size.x, size.y, r.getPixelRatio()]; }
    const inp = this.input.update(dt, p.kmh);
    this.hud.tick(dt);
    if (this.paused) { this.render(); return; }
    // ---------------- engine start/stop handled by the free-revving model until it runs
    const rev = ctx.rev;
    let revState = null;
    if (!p.engineOn) {
      revState = rev.step(dt);
      if (rev.running) { p.engineOn = true; p.rpm = rev.rpm; p.engW = (rev.rpm * Math.PI) / 30; }
      else p.rpm = rev.rpm;
    }
    const revEv = rev.drain();
    for (let i = 0; i < revEv.length; i++) {
      const e = revEv[i];
      if (e.type === 'cough') ctx.audio.trigger('cough', 1);
      else if (e.type === 'pop') ctx.audio.trigger('pop', e.v);
      else if (e.type === 'click' || e.type === 'catch' || e.type === 'ready' || e.type === 'poweroff' || e.type === 'shudder') ctx.audio.trigger(e.type, e.v);
    }
    // ---------------- physics at 240 Hz
    p.input.throttle = inp.throttle; p.input.brake = inp.brake; p.input.steer = inp.steer; p.input.handbrake = inp.handbrake; p.input.nitrous = inp.nitrous;
    this.acc += dt;
    let steps = 0;
    let impact = 0, cones = 0;
    while (this.acc >= DT && steps < 16) {
      this.prev.x = p.x; this.prev.y = p.y; this.prev.psi = p.psi;
      p.step(DT, this.wp);
      this.wp.update(DT);
      const pe = p.events;
      for (let i = 0; i < pe.length; i++) {
        const e = pe[i];
        if (e.type === 'shift') { ctx.audio.trigger('shift'); if (e.up && this.turbo && e.boost > 0.45) ctx.audio.trigger('bov', Math.min(1, e.boost)); }
        else if (e.type === 'limiter') { if (rev.pops && Math.random() < 0.5) { ctx.audio.trigger('pop', 0.8); this.flameT = 0.06; } }
        else if (e.type === 'impact') impact = Math.max(impact, e.dv);
      }
      pe.length = 0;
      const we = this.wp.drain();
      for (let i = 0; i < we.length; i++) if (we[i].type === 'cone') { cones++; ctx.audio.trigger('cone', we[i].v); }
      this.acc -= DT; steps++;
    }
    if (steps >= 16) this.acc = 0;
    if (impact > 0.6) { ctx.audio.trigger('impact', impact); this.cam.shake = Math.min(0.5, this.cam.shake + impact * 0.035); if (impact > 2.5) this.driftCrash(); }
    if (cones && this.D.chain > 0) { this.D.mult = 1; this.D.time = 0; }
    // interpolated pose
    const al = clamp(this.acc / DT, 0, 1) || 0;
    const x = this.prev.x + (p.x - this.prev.x) * al, y = this.prev.y + (p.y - this.prev.y) * al;
    const psi = this.prev.psi + wrap(p.psi - this.prev.psi) * al;
    // ---------------- sound
    this.updateSound(dt, inp, revState);
    // ---------------- the car on the ground
    this.placeCar(dt, x, y, psi);
    // ---------------- tyre smoke, dust, skid marks, sparks
    this.updateEffects(dt, psi);
    // ---------------- scoring and laps
    this.updateDrift(dt);
    this.updateLap(dt);
    this.updateSafety(dt);
    // ---------------- camera, world streaming, lights
    this.updateCamera(dt, x, y, psi, inp);
    this.sky.follow(this.camera.position.x, this.camera.position.z, dt);
    this.view.update(dt, x, y, this.camera.position.x, -this.camera.position.z, this.camera);
    if (this.view.park.cones && this.wp.conesDirty) { this.view.park.syncCones(this.wp.cones); this.wp.conesDirty = false; }
    this.fx.update(dt, this.camera);
    // ---------------- HUD
    this.hudT = (this.hudT || 0) + dt;
    if (this.hudT > 1 / 30) { this.hudT = 0; this.updateHud(x, y, psi); }
    this.render();
  }

  render() {
    const r = this.ctx.studio.renderer;
    if (this.composer) this.composer.render();
    else r.render(this.scene, this.camera);
  }

  updateSound(dt, inp, revState) {
    const ctx = this.ctx, p = this.phys, a = ctx.audio;
    if (!a.ready) return;
    // tyres: squeal while sliding on tarmac, scrub at the grip limit, rumble off the road
    let squeal = 0, scrub = 0, surf = 0, rough = 0;
    const spd = p.speed;
    for (const w of p.wheels) {
      const k = w.kind;
      const load = clamp(w.load / ((p.m * 9.81) / 4), 0, 1.6);
      if (TARMAC.has(k)) {
        squeal = Math.max(squeal, clamp(((w.slide || 0) - 1.4) / 7, 0, 1.25) * Math.min(1, load + 0.2));
        scrub = Math.max(scrub, clamp((Math.abs(w.alpha) - 0.05) / 0.09, 0, 1) * clamp((spd - 4) / 8, 0, 1) * load);
        if (k === 'kerb') rough += 0.25;
      } else if (DUSTY.has(k) || k === 'water') surf += 0.25;
    }
    surf *= clamp(spd / 18, 0, 1.2);
    rough *= clamp(spd / 10, 0, 1);
    const scrape = p.contacts.length ? clamp(p.scrapeV / 10, 0, 1) : 0;
    // lift-off: blow-off valve and pops on the overrun
    const thr = p.thrEff;
    if (p.engineOn && !this.isEV) {
      if (this.lastThr > 0.55 && thr < 0.1) {
        if (this.turbo && p.boost > 0.35) a.trigger('bov', Math.min(1, p.boost));
        if (ctx.rev.pops && p.rpm > 3200) { this.popWin = 0.6 + Math.random() * 0.6; this.popT = 0.05; }
      }
      if (this.popWin > 0) {
        this.popWin -= dt; this.popT -= dt;
        if (this.popT <= 0 && thr < 0.1 && p.rpm > 2400) { a.trigger('pop', 0.6 + Math.random() * 0.6); this.flameT = 0.07; this.popT = 0.06 + Math.random() * 0.16; }
      }
    }
    this.lastThr = thr;
    const tyres = { slip: squeal, scrub, surf: clamp(surf, 0, 1), rough: clamp(rough, 0, 1), scrape, speed: p.kmh, horn: inp.horn ? 1 : 0, master: 1 };
    if (p.engineOn) {
      const cut = p.cutT > 0 || (p.shiftT > 0 && p.shiftTorque === 0) ? 1 : 0;
      a.setState({ rpm: p.rpm, load: cut ? 0 : Math.max(0.07, thr), boost: Math.max(0, p.boost), cut, on: 1, starter: 0, crank: 0, ...tyres });
      ctx.rev.rpm = p.rpm; ctx.rev.boost = p.boost;
    } else if (revState) {
      a.setState({ ...revState, ...tyres });
    } else a.setState({ ...tyres, on: 0 });
  }

  placeCar(dt, x, y, psi) {
    const p = this.phys, m = this.ctx.model, W = this.wp;
    const cp = Math.cos(psi), sp = Math.sin(psi);
    // ground under each wheel (raised kerbs and sidewalks included)
    const hw = this.tmp.hw;
    for (let i = 0; i < 4; i++) { const w = p.wheels[i]; hw[i] = W.groundAt(x + w.px * cp - w.py * sp, y + w.px * sp + w.py * cp); }
    const hF = (hw[0] + hw[1]) / 2, hR = (hw[2] + hw[3]) / 2, hL = (hw[0] + hw[2]) / 2, hRt = (hw[1] + hw[3]) / 2;
    const pitchT = Math.atan2(hF - hR, p.WB), rollT = Math.atan2(hL - hRt, p.track);
    // model origin sits between the axles
    const ox = x - p.xCg * cp, oy = y - p.xCg * sp;
    const g = this.geo;
    const f = g ? clamp((0 - g.xR) / (g.xF - g.xR), 0, 1) : 0.5;
    const hO = hR + (hF - hR) * f;
    const k = Math.min(1, dt * 30);
    this.gp = this.gp || { pitch: pitchT, roll: rollT, h: hO };
    this.gp.pitch += (pitchT - this.gp.pitch) * k; this.gp.roll += (rollT - this.gp.roll) * k; this.gp.h += (hO - this.gp.h) * Math.min(1, dt * 40);
    if (this.camSnap) { this.gp.pitch = pitchT; this.gp.roll = rollT; this.gp.h = hO; }
    m.root.position.set(ox, this.gp.h, -oy);
    m.root.rotation.set(this.gp.roll, psi, this.gp.pitch, 'YZX');
    // body roll and pitch on its springs
    const B = this.body, rollK = p.rollK || 1;
    const tRoll = clamp(p.ayF * 0.0045 * rollK, -0.085, 0.085), tPitch = clamp(p.axF * 0.003, -0.05, 0.05);
    const w0 = 9.5, z0 = 0.42;
    B.rollV += (w0 * w0 * (tRoll - B.roll) - 2 * z0 * w0 * B.rollV) * dt; B.roll += B.rollV * dt;
    B.pitchV += (w0 * w0 * (tPitch - B.pitch) - 2 * z0 * w0 * B.pitchV) * dt; B.pitch += B.pitchV * dt;
    if (m.body) m.body.rotation.set(B.roll, 0, B.pitch);
    if (m.custom) m.custom.root.rotation.set(B.roll, 0, B.pitch);
    // wheels: spin and steer
    const d = p.steerNow;
    for (let i = 0; i < 4; i++) {
      const w = p.wheels[i];
      const steer = i < 2 ? d * (1 + (w.left ? 1 : -1) * Math.sign(d) * 0.08) : 0;
      m.setWheelPose(i ^ 1, w.spin, steer);
    }
    if (m.custom) m.custom.spin(((p.wheels[2].spin + p.wheels[3].spin) / 2) * p.R);
    // brake lights, exhaust flames
    const braking = p.brkEff > 0.05 && p.gear >= 0;
    const tail = braking ? (this.lights ? 6 : 4.5) : this.tailBase ?? 0.3;
    for (const t of m.taillights || []) t.material.emissiveIntensity = tail;
    if (this.flameT > 0) { this.flameT -= dt; m.setFlames(true); } else m.setFlames(false);
    this.carH = this.gp.h;
  }

  updateEffects(dt, psi) {
    const p = this.phys, fx = this.fx, W = this.wp;
    const q = this.ctx.studio.tier === 'low' ? 0.45 : this.ctx.studio.tier === 'medium' ? 0.75 : 1;
    const cp = Math.cos(p.psi), sp = Math.sin(p.psi);
    const vx = p.u * cp - p.v * sp, vy = p.u * sp + p.v * cp;
    const tyreHalf = (this.build.a.veh.tyreW / 1000) * 0.45;
    for (let i = 0; i < 4; i++) {
      const w = p.wheels[i], k = w.kind, slide = w.slide || 0;
      const gx = w.wx, gy = w.wy, h = W.groundAt(gx, gy);
      const head = psi + (i < 2 ? p.steerNow : 0);
      const ax = -Math.sin(head), az = -Math.cos(head);
      if (TARMAC.has(k)) {
        const ks = clamp((slide - 3) / 9, 0, 1);
        if (ks > 0) {
          const rate = ks * 70 * q;
          let n = rate * dt; while (n > 0) { if (Math.random() < n) fx.emit(gx + (Math.random() - 0.5) * 0.3, h + 0.3, -gy + (Math.random() - 0.5) * 0.3, vx * 0.25, 0.1, -vy * 0.25, 'smoke', 0.7 + ks * 0.6); n -= 1; }
        }
        const km = clamp((slide - 1.6) / 6, 0, 1);
        fx.mark(i, km > 0.03 && w.load > 300, gx, -gy, ax, az, tyreHalf, 0.18 + km * 0.62);
      } else {
        fx.mark(i, false);
        if (DUSTY.has(k) && p.speed > 2.5) {
          const kd = clamp(p.speed / 22, 0, 1) * (0.5 + clamp(slide / 8, 0, 1));
          let n = kd * 22 * q * dt; while (n > 0) { if (Math.random() < n) fx.emit(gx, h + 0.35, -gy, vx * 0.15, 0.3, -vy * 0.15, 'dust', 0.6 + kd * 0.5); n -= 1; }
        }
      }
    }
    // sparks where the body scrapes
    if (p.contacts.length && p.scrapeV > 2.5) {
      for (let c = 0; c < p.contacts.length; c += 2) fx.spark(p.contacts[c], this.carH + 0.35, -p.contacts[c + 1], vx, -vy, Math.min(6, Math.round(p.scrapeV / 3)));
    }
    // diesels smoke under load; a cold engine puffs a little
    const m = this.ctx.model;
    if (m.flames && m.flames.length && p.engineOn) {
      const fl = m.flames[0];
      const wp = fl.getWorldPosition(this.tmp.v3);
      if (this.isDiesel && p.thrEff > 0.6 && p.rpm < p.redline * 0.85 && Math.random() < dt * 30) fx.emit(wp.x, wp.y, wp.z, -vx * 0.1, 0.4, vy * 0.1, 'diesel', 0.8 + p.thrEff * 0.4);
      else if (!this.isEV && this.t < 20 && Math.random() < dt * 4) fx.emit(wp.x, wp.y, wp.z, 0, 0.2, 0, 'exhaust', 0.8);
    }
  }

  // ---------------------------------------------------------------- drift score (anywhere on tarmac)
  updateDrift(dt) {
    const p = this.phys, D = this.D;
    const beta = p.beta, deg = Math.abs(beta) * 57.3;
    let onTar = 0; for (let i = 0; i < 4; i++) if (TARMAC.has(p.wheels[i].kind)) onTar++;
    const tarmac = onTar >= 2;
    const drifting = p.speed > 6 && p.u > 2 && deg > 10 && tarmac && p.gear >= 0;
    D.angle = (beta * 57.3);
    if (drifting) {
      D.active = true; D.idle = 0; D.time += dt;
      D.mult = Math.min(5, 1 + Math.floor(D.time / 2.5));
      D.chain += (deg - 8) * p.speed * 0.9 * dt * D.mult;
    } else {
      D.active = false;
      if (D.chain > 0) {
        D.idle += dt;
        if (D.idle > 1.4 || p.speed < 3) this.driftBank();
      }
    }
    D.keep = D.chain > 0 ? (D.active ? 1 : 1 - D.idle / 1.4) : 0;
  }

  driftBank() {
    const D = this.D;
    if (D.chain >= 50) {
      D.total += D.chain;
      const pts = Math.round(D.chain).toLocaleString('en-US');
      if (D.chain > D.best) { D.best = D.chain; this.ctx.store.set('driftBest', D.best); this.hud.message(`Best drift +${pts}`, 'good', 2); }
      else this.hud.message(`Drift +${pts}`, '', 1.4);
    }
    D.chain = 0; D.time = 0; D.mult = 1; D.idle = 0;
  }

  driftCrash() {
    const D = this.D;
    if (D.chain > 50) this.hud.message('Hit something: drift lost', 'bad', 1.6);
    D.chain = 0; D.time = 0; D.mult = 1; D.idle = 0;
  }

  // ---------------------------------------------------------------- lap timing on the circuit
  lapReset() { Object.assign(this.lap, { started: false, sector: 0, invalid: false, trace: [], s: null, t0: 0, onT: 0 }); this.lap.best = this.ctx.store.get('lap:' + this.ctx.buildKey(), null); this.lap.bestTrace = null; }

  updateLap(dt) {
    const p = this.phys, W = this.world, L = this.lap;
    const inPark = Math.abs(p.x) < 470 && Math.abs(p.y) < 340;
    const nr = inPark ? W.nearestOnCircuit(p.x, p.y, 30) : null;
    this.onCircuit = !!nr && Math.abs(nr.lat) < W.circuit.half + 10;
    if (!nr) { if (L.started && !inPark) { L.started = false; } L.s = null; return; }
    const len = W.circuit.length, sS = W.sStart;
    // distance along the lap from the start line
    const s = (nr.s - sS + len) % len;
    if (L.s != null) {
      const ds = s - L.s;
      // crossed the line going forward
      if (ds < -len / 2 && this.onCircuit) {
        const now = this.t;
        if (L.started && L.sector >= 2) {
          const time = now - L.t0;
          L.last = time;
          if (!L.invalid && (L.best == null || time < L.best)) { L.best = time; L.bestTrace = L.trace.slice(); this.ctx.store.set('lap:' + this.ctx.buildKey(), time); this.hud.message(`New best lap ${fmtLap(time)}`, 'good', 2.5); }
          else this.hud.message(L.invalid ? `Lap ${fmtLap(time)} (invalid)` : `Lap ${fmtLap(time)}`, L.invalid ? 'bad' : '', 2);
          L.lapN++;
        }
        L.started = true; L.t0 = now; L.sector = 0; L.invalid = false; L.trace = [];
      }
      if (L.started) {
        if (L.sector === 0 && s > len / 3 && s < len / 2) L.sector = 1;
        if (L.sector === 1 && s > (2 * len) / 3) L.sector = 2;
        if (L.trace.length === 0 || s - L.trace[L.trace.length - 1][0] > 8) L.trace.push([s, this.t - L.t0]);
        // track limits: all four wheels off the tarmac and kerbs
        let offAll = true; for (let i = 0; i < 4; i++) if (TARMAC.has(p.wheels[i].kind)) { offAll = false; break; }
        if (offAll && this.onCircuit) { if (!L.invalid) this.hud.message('Track limits: lap invalid', 'bad', 1.6); L.invalid = true; }
        // wrong way
        const t = W.circuit;
        const dirOk = Math.cos(p.psi) * t.tx[nr.i] + Math.sin(p.psi) * t.ty[nr.i];
        if (dirOk < -0.5 && p.u > 5) { this.wrongT = (this.wrongT || 0) + dt; if (this.wrongT > 1.2) { this.hud.message('Wrong way', 'bad', 0.6); this.wrongT = 0.6; } } else this.wrongT = 0;
      }
    }
    L.s = s;
  }

  lapDelta() {
    const L = this.lap;
    if (!L.started || !L.bestTrace || L.s == null) return null;
    const tr = L.bestTrace;
    let lo = 0, hi = tr.length - 1;
    if (!tr.length || L.s < tr[0][0]) return null;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid][0] > L.s) hi = mid; else lo = mid; }
    const a = tr[lo], b = tr[hi] || a;
    const f = b[0] > a[0] ? (L.s - a[0]) / (b[0] - a[0]) : 0;
    const tb = a[1] + (b[1] - a[1]) * f;
    return this.t - L.t0 - tb;
  }

  // water, out of bounds: put the car back on the road
  updateSafety(dt) {
    const p = this.phys;
    let wet = 0, tar = 0; for (let i = 0; i < 4; i++) { const k = p.wheels[i].kind; if (k === 'water') wet++; else if (TARMAC.has(k)) tar++; }
    const water = wet >= 3;
    if (water) {
      this.wetT = (this.wetT || 0) + dt;
      if (this.wetT > 1.6) { this.hud.message('Into the lake! Back on the road', 'bad', 2); this.wetT = 0; p.reset(this.safe.x, this.safe.y, this.safe.psi); this.prev = { x: p.x, y: p.y, psi: p.psi }; this.camSnap = true; }
      return;
    }
    this.wetT = 0;
    this.safeT = (this.safeT || 0) + dt;
    if (this.safeT > 1 && tar === 4 && p.speed < 45 && Math.abs(p.beta) < 0.3) { this.safeT = 0; this.safe.x = p.x; this.safe.y = p.y; this.safe.psi = p.psi; }
  }

  // ---------------------------------------------------------------- cameras
  updateCamera(dt, x, y, psi, inp) {
    const c = this.cam, cam = this.camera, p = this.phys, m = this.ctx.model;
    const L = (this.build.car.dims[0] / 1000), Hc = this.build.car.dims[2] / 1000;
    const base = this.carH ?? 0;
    const mode = this.set.cam;
    // look around: mouse drag or right stick, drifting back when released
    if (inp.dragging || Math.abs(inp.mouseDX) + Math.abs(inp.mouseDY) > 0 || Math.abs(inp.lookX) + Math.abs(inp.lookY) > 0) {
      c.lookYaw -= inp.mouseDX * 0.006 + inp.lookX * dt * 2.6;
      c.lookPitch = clamp(c.lookPitch + inp.mouseDY * 0.004 + inp.lookY * dt * 1.6, -0.5, 0.9);
      c.lookT = 1.4;
    } else if (mode !== 'orbit') {
      c.lookT -= dt;
      if (c.lookT <= 0) { c.lookYaw *= Math.exp(-dt * 3); c.lookPitch *= Math.exp(-dt * 3); }
    }
    if (inp.wheel && mode === 'orbit') c.orbit.dist = clamp(c.orbit.dist * (1 + inp.wheel * 0.1), 4, 40);
    const cpx = Math.cos(psi), spx = Math.sin(psi);
    const vx = p.u * Math.cos(p.psi) - p.v * Math.sin(p.psi), vy = p.u * Math.sin(p.psi) + p.v * Math.cos(p.psi);
    const spd = Math.hypot(vx, vy);
    let fov = 58;
    const target = this.tmp.target.set(x, base + Hc * 0.45, -y);
    if (mode === 'chase' || mode === 'far') {
      // camera yaw follows a blend of heading and travel direction, so drifts show the car's angle
      let want = psi;
      if (spd > 3 && p.u > 0) want = psi + wrap(Math.atan2(vy, vx) - psi) * 0.55;
      c.yaw += wrap(want - c.yaw) * Math.min(1, dt * (mode === 'far' ? 3 : 4.2));
      if (this.camSnap) c.yaw = want;
      const back = inp.lookBack ? Math.PI : 0;
      const yaw = c.yaw + c.lookYaw + back;
      const dist = (mode === 'far' ? 8 + L * 1.1 : 3.9 + L * 0.82) + clamp(spd / 30, 0, 1) * 0.8;
      const hgt = (mode === 'far' ? 2.8 + Hc * 0.7 : 1.15 + Hc * 0.62) + c.lookPitch * dist * 0.6;
      const want3 = this.tmp.want.set(x - Math.cos(yaw) * dist, base + hgt, -(y - Math.sin(yaw) * dist));
      const k = this.camSnap ? 1 : Math.min(1, dt * 11);
      c.pos.lerp(want3, k);
      // never below the hillside
      const gh = this.wp.heightAt(c.pos.x, -c.pos.z) + 0.6;
      if (c.pos.y < gh) c.pos.y = gh;
      cam.position.copy(c.pos);
      c.look.set(x + Math.cos(c.yaw + back) * 2.2, base + Hc * 0.5, -(y + Math.sin(c.yaw + back) * 2.2));
      cam.lookAt(c.look);
      fov = 56 + clamp(p.kmh / 240, 0, 1) * 14;
    } else if (mode === 'hood' || mode === 'bumper') {
      const g = this.geo;
      const lx = mode === 'hood' ? g.xF - 0.35 : g.xNose + 0.05;
      const ly = mode === 'hood' ? (g.zTop ? g.zTop(g.xF - 0.35) : 1.0) + 0.42 : 0.55;
      const local = this.tmp.local.set(lx, ly, 0);
      m.root.updateMatrixWorld();
      const wpos = local.applyMatrix4(m.root.matrixWorld);
      cam.position.copy(wpos);
      const yaw = psi + c.lookYaw + (inp.lookBack ? Math.PI : 0);
      const fwd = this.tmp.fwd.set(Math.cos(yaw), 0, -Math.sin(yaw));
      const pitch = (this.gp ? this.gp.pitch : 0) + this.body.pitch - 0.035 - c.lookPitch * 0.5;
      fwd.y = Math.tan(pitch);
      cam.up.set(0, 1, 0);
      cam.lookAt(fwd.add(wpos));
      fov = mode === 'hood' ? 62 + clamp(p.kmh / 250, 0, 1) * 10 : 68;
      c.pos.copy(cam.position);
    } else if (mode === 'tv') {
      // nearest trackside spot, zooming to keep the car framed
      let best = c.tv, bd = c.tv ? (c.tv.x - x) ** 2 + (c.tv.y - y) ** 2 : Infinity;
      for (const s of this.tvSpots) { const d = (s.x - x) ** 2 + (s.y - y) ** 2; if (d < bd * 0.5 || (!c.tv && d < bd)) { bd = d; best = s; } }
      if (!c.tv || Math.sqrt((c.tv.x - x) ** 2 + (c.tv.y - y) ** 2) > 140) c.tv = best;
      const s = c.tv || { x: x - 20, y, h: base + 5 };
      cam.position.set(s.x, Math.max(s.h, this.wp.heightAt(s.x, s.y) + 3), -s.y);
      cam.lookAt(target);
      const d = cam.position.distanceTo(target);
      fov = clamp((2 * Math.atan((L * 1.6) / d) * 180) / Math.PI, 7, 55);
      c.pos.copy(cam.position);
    } else if (mode === 'drone') {
      const yaw = c.yaw += wrap(psi - c.yaw) * Math.min(1, dt * 1.5);
      const want3 = this.tmp.want.set(x - Math.cos(yaw) * 9, base + 26, -(y - Math.sin(yaw) * 9));
      c.pos.lerp(want3, this.camSnap ? 1 : Math.min(1, dt * 4));
      cam.position.copy(c.pos);
      cam.lookAt(target);
      fov = 50;
    } else {
      // orbit
      const o = c.orbit;
      o.yaw = (o.yaw ?? 0) - (inp.mouseDX || 0) * 0.006 - inp.lookX * dt * 2;
      o.pitch = clamp((o.pitch ?? 0.3) + (inp.mouseDY || 0) * 0.004 + inp.lookY * dt * 1.4, 0.05, 1.3);
      c.lookYaw = 0; c.lookPitch = 0;
      const yaw = psi + o.yaw + Math.PI;
      cam.position.set(x + Math.cos(yaw) * Math.cos(o.pitch) * o.dist, base + Math.sin(o.pitch) * o.dist + 0.6, -(y + Math.sin(yaw) * Math.cos(o.pitch) * o.dist));
      const gh = this.wp.heightAt(cam.position.x, -cam.position.z) + 0.5;
      if (cam.position.y < gh) cam.position.y = gh;
      cam.lookAt(target);
      fov = 50;
      c.pos.copy(cam.position);
    }
    if (p.nosOn) fov += 6;
    if (!isFinite(c.pos.x + c.pos.y + c.pos.z)) { c.pos.copy(cam.position); }
    c.fov += (fov - c.fov) * Math.min(1, dt * (this.camSnap ? 100 : 4));
    if (Math.abs(cam.fov - c.fov) > 0.01) { cam.fov = c.fov; cam.updateProjectionMatrix(); }
    // shake: impacts, kerbs, very high speed
    let kerb = 0; for (let i = 0; i < 4; i++) if (p.wheels[i].kind === 'kerb') { kerb = 0.012; break; }
    const sh = c.shake + kerb + (p.kmh > 170 ? (p.kmh - 170) * 0.00006 : 0);
    if (sh > 0.0005 && mode !== 'tv') { cam.position.x += (Math.random() - 0.5) * sh; cam.position.y += (Math.random() - 0.5) * sh; cam.position.z += (Math.random() - 0.5) * sh; }
    c.shake *= Math.exp(-dt * 5);
    this.camSnap = false;
  }

  // ---------------------------------------------------------------- HUD
  updateHud(x, y, psi) {
    const p = this.phys, h = this.hud, b = this.build;
    const curve = b.a.veh.curve;
    const ev = this.isEV;
    h.drawTach({ rpm: p.engineOn ? p.rpm : this.ctx.rev.rpm, redline: curve.redline, maxRpm: ev ? curve.maxRpm || curve.redline : Math.ceil((curve.redline + 700) / 1000) * 1000, kmh: p.kmh, gear: p.gearLabel, ev, boostOn: this.turbo || (curve.boost && curve.boost.kind === 'sc'), boost: p.boost, nosCap: p.nosCap, nos: p.nos, nosOn: p.nosOn });
    h.drawMap(x, y, psi);
    h.lamp('abs', null, p.absActive);
    h.lamp('tcs', null, p.tcsActive);
    h.lamp('esc', null, p.escActive);
    h.lamp('nos', null, p.nosOn);
    h.setDrift(this.D);
    const area = this.areaName(x, y);
    h.setArea(area[0], area[1], this.onCircuit);
    if (this.onCircuit || this.lap.started) h.setLap({ lap: this.lap.lapN + 1, cur: this.lap.started ? this.t - this.lap.t0 : null, last: this.lap.last, best: this.lap.best, delta: this.lapDelta(), invalid: this.lap.invalid });
  }

  areaName(x, y) {
    this.areaT = (this.areaT || 0) - 1;
    if (this.areaT > 0 && this.areaCache) return this.areaCache;
    this.areaT = 15;
    const W = this.world;
    let name, road = '';
    if (Math.abs(x) < 470 && Math.abs(y) < 340) {
      const P = W.park.pad;
      name = 'PakSwap Drift Park';
      road = x > P.x0 && x < P.x1 && y > P.y0 && y < P.y1 ? 'Drift pad' : this.onCircuit ? 'Race circuit' : y < -170 && y > -215 ? 'Paddock' : '';
    } else {
      const nr = nearestRoad(W, x, y, 30);
      road = nr ? nr.rd.name || '' : '';
      const L = W.lake;
      if (x > 1000 && x < 2200 && y > -2360 && y < -1240) name = 'Shahr, the city';
      else if (Math.hypot(x + 1640, y + 470) < 300) name = 'Chak 42 village';
      else if (Math.hypot((x - L.x) / L.rx, (y - L.y) / L.ry) < 2.2) name = 'Jheel, the lake';
      else if (y > 700) name = 'Murree hills';
      else if (nr && nr.rd.id === 'M9') name = 'M-9 Motorway';
      else name = 'Countryside';
    }
    this.areaCache = [name, road];
    return this.areaCache;
  }

  dispose() {
    if (this.active) this.exit();
    this.view?.dispose(); this.fx?.dispose(); this.sky?.dispose(); this.hud?.dispose();
  }
}

function fmtLap(t) { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`; }
