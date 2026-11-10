// Studio scene: renderer, environment lighting, floor, camera and orbit controls.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { floorTexture, backgroundTexture } from './textures.js';

export class Studio {
  constructor(container) {
    this.container = container;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.quality = 'high';
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement);
    r.domElement.setAttribute('aria-label', '3D car view. Drag to rotate, scroll or pinch to zoom.');
    r.domElement.tabIndex = 0;
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
    this.camera.position.set(5.6, 1.9, 5.2);
    const pm = new THREE.PMREMGenerator(r);
    this.envDay = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envDay;
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2.6;
    this.controls.maxDistance = 14;
    this.controls.maxPolarAngle = 1.5;
    this.controls.enablePan = false;
    this.controls.target.set(0, 0.6, 0);
    this.controls.autoRotateSpeed = 0.6;
    // lights
    this.hemi = new THREE.HemisphereLight('#fff4e6', '#2a2520', 0.35);
    this.key = new THREE.DirectionalLight('#fff3e2', 1.2);
    // overhead soft box: the car sits in its own shadow like a studio shoot
    this.key.position.set(1.6, 9, 2.2);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    sc.left = -3.8; sc.right = 3.8; sc.top = 3.8; sc.bottom = -3.8; sc.near = 2; sc.far = 20;
    this.key.shadow.bias = -0.0005;
    this.key.shadow.normalBias = 0.025;
    this.key.shadow.radius = 5;
    this.rim = new THREE.DirectionalLight('#cfe1ff', 0.6);
    this.rim.position.set(-5, 3, -4);
    this.scene.add(this.hemi, this.key, this.rim);
    // floor
    const fm = new THREE.MeshStandardMaterial({ map: floorTexture(true), roughness: 0.42, metalness: 0.1, envMapIntensity: 0.5 });
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(16, 96), fm);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.carSlot = new THREE.Group();
    this.scene.add(this.carSlot);
    this.night = true;
    this.setNight(true);
    this.tween = null;
    this.onFrame = [];
    this.clock = new THREE.Clock();
    this.composer = null;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.controls.addEventListener('start', () => { this.userInteracted = true; this.tween = null; });
    this.loop = this.loop.bind(this);
    this.running = true;
    requestAnimationFrame(this.loop);
  }

  setQuality(q) {
    this.quality = q;
    const pr = q === 'high' ? Math.min(window.devicePixelRatio || 1, 2) : q === 'medium' ? Math.min(window.devicePixelRatio || 1, 1.4) : 1;
    this.renderer.setPixelRatio(pr);
    const shadows = q !== 'low';
    this.renderer.shadowMap.enabled = shadows;
    this.key.castShadow = shadows;
    if (shadows) {
      const n = q === 'high' ? 2048 : 1024;
      if (this.key.shadow.mapSize.x !== n) { this.key.shadow.mapSize.set(n, n); this.key.shadow.map?.dispose(); this.key.shadow.map = null; }
    }
    this.resize();
    this.updateComposer();
  }

  updateComposer() {
    const want = this.night && this.quality === 'high';
    if (want && !this.composer) {
      const c = new EffectComposer(this.renderer);
      c.addPass(new RenderPass(this.scene, this.camera));
      const size = this.renderer.getSize(new THREE.Vector2());
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.55, 0.5, 0.82);
      c.addPass(this.bloom);
      c.addPass(new OutputPass());
      this.composer = c;
      this.resize();
    } else if (!want && this.composer) {
      this.composer.dispose?.();
      this.composer = null;
    }
  }

  setNight(on) {
    this.night = on;
    this.scene.background = backgroundTexture(on);
    this.scene.fog = new THREE.Fog(on ? '#171513' : '#dcd8d1', 9, 24);
    this.floor.material.map = floorTexture(on);
    this.floor.material.needsUpdate = true;
    this.scene.environmentIntensity = on ? 0.55 : 1.0;
    this.hemi.intensity = on ? 0.18 : 0.55;
    this.key.intensity = on ? 0.45 : 1.3;
    this.rim.intensity = on ? 0.5 : 0.6;
    this.renderer.toneMappingExposure = on ? 1.05 : 1.0;
    this.updateComposer();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.9 ? 44 : 32;
    this.camera.updateProjectionMatrix();
    if (this.composer) this.composer.setSize(w, h);
    if (this.lastPreset && !this.userInteracted && this.carLen) { const [n, e] = this.lastPreset; this.preset(n, e); if (this.tween) this.tween.dur = 0.35; }
  }

  frameCar(len, height) {
    this.carLen = len; this.carH = height; this.userInteracted = false;
    this.controls.target.set(0, Math.min(0.75, height * 0.42), 0);
    this.controls.minDistance = Math.max(2.4, len * 0.62);
    this.controls.maxDistance = Math.max(9, len * 3);
  }

  flyTo(pos, target, dur = 1.1) {
    const q0 = this.controls.target.clone();
    const s0 = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(q0));
    const s1 = new THREE.Spherical().setFromVector3(pos.clone().sub(target));
    let dth = s1.theta - s0.theta;
    while (dth > Math.PI) dth -= Math.PI * 2;
    while (dth < -Math.PI) dth += Math.PI * 2;
    this.tween = { t: 0, dur, s0, s1, dth, q0, q1: target.clone() };
  }

  fitDistance(len, height, along) {
    const vf = (this.camera.fov * Math.PI) / 180;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect);
    const halfW = len * along * 0.5 + 0.45;
    const halfH = height * 0.62 + 0.3;
    return Math.max(halfW / Math.tan(hf / 2), halfH / Math.tan(vf / 2));
  }

  preset(name, extra) {
    const L = this.carLen || 4.2, H = this.carH || 1.5;
    this.lastPreset = [name, extra];
    const ty = Math.min(0.75, H * 0.42);
    const T = new THREE.Vector3(0, ty, 0);
    let p;
    const dir = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
    let v;
    if (name === 'front') { v = dir(0.78, 0.24, 0.62); p = v.multiplyScalar(this.fitDistance(L, H, 0.92)); }
    else if (name === 'side') { v = dir(0.0, 0.1, 1); p = v.multiplyScalar(this.fitDistance(L, H, 1.0)); }
    else if (name === 'rear') { v = dir(-0.8, 0.28, -0.6); p = v.multiplyScalar(this.fitDistance(L, H, 0.92)); }
    else if (name === 'top') { p = new THREE.Vector3(0.01, this.fitDistance(L, 1.9, 1.0) * 1.05, 0.02); }
    else if (name === 'engine' && extra) {
      const c = extra.clone();
      T.copy(c);
      p = new THREE.Vector3(c.x + L * 0.5, c.y + L * 0.42, L * 0.5);
    } else { v = dir(0.78, 0.24, 0.62); p = v.multiplyScalar(this.fitDistance(L, H, 0.92)); }
    if (name !== 'engine' && name !== 'top') p.y += ty;
    this.flyTo(p, T);
  }

  snapshot(width = 1600) {
    const r = this.renderer;
    const old = r.getSize(new THREE.Vector2());
    const pr = r.getPixelRatio();
    const h = Math.round(width / (old.x / old.y));
    r.setPixelRatio(1);
    r.setSize(width, h, false);
    this.camera.aspect = width / h; this.camera.updateProjectionMatrix();
    if (this.composer) { this.composer.setSize(width, h); this.composer.render(); } else r.render(this.scene, this.camera);
    const url = r.domElement.toDataURL('image/png');
    r.setPixelRatio(pr);
    this.resize();
    return url;
  }

  loop() {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    // drive mode takes over the renderer
    if (this.driver) { this.driver.frame(dt); return; }
    if (this.tween) {
      const tw = this.tween;
      tw.t += dt / tw.dur;
      const k = tw.t >= 1 ? 1 : tw.t < 0.5 ? 4 * tw.t * tw.t * tw.t : 1 - Math.pow(-2 * tw.t + 2, 3) / 2;
      this.controls.target.lerpVectors(tw.q0, tw.q1, k);
      const sp = new THREE.Spherical(
        tw.s0.radius + (tw.s1.radius - tw.s0.radius) * k,
        tw.s0.phi + (tw.s1.phi - tw.s0.phi) * k,
        tw.s0.theta + tw.dth * k,
      );
      this.camera.position.setFromSpherical(sp).add(this.controls.target);
      if (tw.t >= 1) this.tween = null;
    }
    this.controls.update();
    for (const f of this.onFrame) f(dt);
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
  }
}
