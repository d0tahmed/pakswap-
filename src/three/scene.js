// Studio scene: renderer, showroom lighting, reflective floor, camera and orbit controls.
//
// Performance model
//  - Frames are drawn on demand: an idle studio costs no GPU time at all. Anything that changes
//    the picture calls invalidate() (camera moves, a rebuilt part, an animation).
//  - The shadow map is refreshed only when the car itself changes, never for camera moves.
//  - In "auto" quality a governor watches the frame rate while frames are being drawn and trades
//    render resolution (and then the quality tier) for smoothness, so the same build runs on a
//    gaming GPU and on an old laptop without the user touching a setting.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { floorTexture, backgroundTexture } from './textures.js';

const TIERS = ['low', 'medium', 'high'];
const MIN_SCALE = 0.5;

// Pick a starting tier from the GPU the browser reports. The governor corrects it either way.
export function guessTier(gl) {
  let name = '';
  try { const ext = gl.getExtension('WEBGL_debug_renderer_info'); if (ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || ''); } catch (e) { /* ignore */ }
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  if (/swiftshader|llvmpipe|software|basic render|softpipe/i.test(name)) return 'low';
  // first to fourth generation Intel graphics and other DX10-era chips
  if (/intel\(r\) hd graphics( family| [234]\d{3})?(?! [56]\d\d)|gma|g4[15]|q4[35]|mobile intel|geforce (gt )?[2-5]\d\d[m ]|radeon hd [2-6]\d{3}/i.test(name)) return 'low';
  if (mobile) return 'medium';
  if (/(rtx|gtx|radeon rx|radeon pro|arc\(tm\)|arc a\d|apple m\d|geforce (9|1\d|2\d|3\d|4\d)\d\d)/i.test(name)) return 'high';
  if (/intel/i.test(name) && !/iris\(r\) xe|iris xe|arc/i.test(name)) return 'medium';
  if ((navigator.hardwareConcurrency || 8) <= 4) return 'medium';
  return 'high';
}

export class Studio {
  constructor(container) {
    this.container = container;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false, stencil: false });
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = false;
    container.appendChild(r.domElement);
    r.domElement.setAttribute('aria-label', '3D car view. Drag to rotate, scroll or pinch to zoom.');
    r.domElement.tabIndex = 0;
    this.renderer = r;
    this.gpuTier = guessTier(r.getContext());
    this.quality = 'auto'; // the setting: auto | high | medium | low
    this.tier = this.gpuTier; // what is in effect: high | medium | low
    this.scale = 1; // dynamic resolution factor
    this.gov = { acc: 0, n: 0, slow: 0, fast: 0, cool: 2, ceil: 1, ceilT: 0, fails: 0, before: 0, from: 1, fromTier: 'high', lock: 0, mode: 'steady' };
    this.insets = { left: 0, right: 0, top: 0, bottom: 0 };
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
    this.camera.position.set(5.6, 1.9, 5.2);
    this.camera.layers.enable(1); // layer 1: floor helpers (contact shadows, underglow)
    this.pmrem = new THREE.PMREMGenerator(r);
    this.envs = {};
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2.6;
    this.controls.maxDistance = 14;
    this.controls.maxPolarAngle = 1.5;
    this.controls.enablePan = false;
    this.controls.target.set(0, 0.6, 0);
    this.controls.autoRotateSpeed = 0.6;
    // lights: the environment does most of the work, the key light adds the floor shadow
    this.hemi = new THREE.HemisphereLight('#f4f7ff', '#20242c', 0.3);
    this.key = new THREE.DirectionalLight('#fff6ea', 1.2);
    this.key.position.set(1.6, 9, 2.2);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    sc.left = -3.8; sc.right = 3.8; sc.top = 3.8; sc.bottom = -3.8; sc.near = 2; sc.far = 20;
    this.key.shadow.bias = -0.0005;
    this.key.shadow.normalBias = 0.025;
    this.key.shadow.radius = 5;
    this.rim = new THREE.DirectionalLight('#bfe4ff', 0.6);
    this.rim.position.set(-5, 3, -4);
    this.rim2 = new THREE.DirectionalLight('#ffc999', 0.3);
    this.rim2.position.set(4.5, 2.2, -5);
    this.scene.add(this.hemi, this.key, this.rim, this.rim2);
    this.buildFloor();
    this.carSlot = new THREE.Group();
    this.scene.add(this.carSlot);
    this.night = true;
    this.tween = null;
    this.onFrame = [];
    this.onTier = null; // (tier, reason) => void
    this.clock = new THREE.Clock();
    this.composer = null;
    this.needs = 3;
    this.rendered = false;
    this.setNight(true);
    this.applyTier();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.controls.addEventListener('start', () => { this.userInteracted = true; this.tween = null; });
    this.controls.addEventListener('change', () => this.invalidate());
    r.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    r.domElement.addEventListener('webglcontextrestored', () => { this.lost = false; this.rebuildAfterRestore(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.clock.getDelta(); this.gov.cool = 2; this.invalidate(2); } });
    this.loop = this.loop.bind(this);
    this.running = true;
    requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- frame scheduling
  // Ask for at least `frames` more frames. `shadows` also refreshes the shadow map.
  invalidate(frames = 1, shadows = false) {
    if (frames > this.needs) this.needs = frames;
    if (shadows) this.renderer.shadowMap.needsUpdate = true;
  }

  // ---------------------------------------------------------------- environment and floor
  // A light tent: a long overhead soft box, strip lights down both flanks and fill panels at the
  // nose and tail. Those are what draw the long highlights along a car's shoulder line.
  envFor(night) {
    const key = night ? 'night' : 'day';
    if (this.envs[key]) return this.envs[key];
    const s = new THREE.Scene();
    const add = (w, h, pos, look, col, k) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k), side: THREE.DoubleSide }));
      m.position.set(...pos); m.lookAt(...look);
      s.add(m);
    };
    const room = new THREE.Mesh(new THREE.SphereGeometry(40, 24, 12), new THREE.MeshBasicMaterial({ color: night ? new THREE.Color(0.012, 0.015, 0.02) : new THREE.Color(0.55, 0.56, 0.58), side: THREE.BackSide }));
    s.add(room);
    const fl = new THREE.Mesh(new THREE.CircleGeometry(30, 32), new THREE.MeshBasicMaterial({ color: night ? new THREE.Color(0.02, 0.022, 0.026) : new THREE.Color(0.42, 0.42, 0.42) }));
    fl.rotation.x = -Math.PI / 2; fl.position.y = -0.6; s.add(fl);
    if (night) {
      add(10, 3.2, [0, 6.5, 0], [0, 0, 0], '#ffffff', 4.6);
      add(13, 0.8, [0, 3.0, 7.5], [0, 0.8, 0], '#cfe9ff', 3.2);
      add(13, 0.8, [0, 3.0, -7.5], [0, 0.8, 0], '#ffe2c4', 2.6);
      add(4.5, 2.0, [10, 2.6, 0], [0, 0.8, 0], '#ffffff', 1.4);
      add(4.5, 2.0, [-10, 2.6, 0], [0, 0.8, 0], '#9fd6ff', 1.8);
      add(2.2, 2.2, [-7, 5, -7], [0, 0.6, 0], '#7fd0ff', 2.4);
      add(2.2, 2.2, [7, 5, 7], [0, 0.6, 0], '#ffb37a', 1.6);
    } else {
      add(14, 6, [0, 7, 0], [0, 0, 0], '#ffffff', 2.2);
      add(14, 2.4, [0, 3.2, 8], [0, 0.8, 0], '#ffffff', 1.3);
      add(14, 2.4, [0, 3.2, -8], [0, 0.8, 0], '#ffffff', 1.3);
      add(6, 3, [10, 3, 0], [0, 0.8, 0], '#ffffff', 1.0);
      add(6, 3, [-10, 3, 0], [0, 0.8, 0], '#ffffff', 1.0);
    }
    const tex = this.pmrem.fromScene(s, 0.035).texture;
    s.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    this.envs[key] = tex;
    return tex;
  }

  buildFloor() {
    // Polished showroom floor. On high quality it mirrors the car: the scene is drawn once more
    // from below into a half-size target and blurred by reading its mip levels.
    const fm = new THREE.MeshStandardMaterial({ map: floorTexture(true), roughness: 0.5, metalness: 0.0, envMapIntensity: 0.08 });
    const u = { tReflect: { value: null }, uReflMatrix: { value: new THREE.Matrix4() }, uReflK: { value: 0 } };
    this.floorU = u;
    fm.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 uReflMatrix;\nvarying vec4 vReflUv;\nvarying vec3 vFloorPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvec4 flW = modelMatrix * vec4(transformed, 1.0);\nvReflUv = uReflMatrix * flW;\nvFloorPos = flW.xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D tReflect;\nuniform float uReflK;\nvarying vec4 vReflUv;\nvarying vec3 vFloorPos;')
        .replace('#include <opaque_fragment>', `if (uReflK > 0.001) {
  vec2 ruv = vReflUv.xy / max(vReflUv.w, 1e-4);
  vec3 vdir = normalize(cameraPosition - vFloorPos);
  float fres = 0.22 + 0.78 * pow(1.0 - clamp(vdir.y, 0.0, 1.0), 3.0);
  float fade = 1.0 - smoothstep(4.5, 9.0, length(vFloorPos.xz));
  float lod = 1.1;
  vec2 px = vec2(0.004, 0.006);
  vec3 rc = textureLod(tReflect, ruv, lod).rgb * 0.4
    + textureLod(tReflect, ruv + vec2(px.x, 0.0), lod + 0.6).rgb * 0.15 + textureLod(tReflect, ruv - vec2(px.x, 0.0), lod + 0.6).rgb * 0.15
    + textureLod(tReflect, ruv + vec2(0.0, px.y), lod + 0.6).rgb * 0.15 + textureLod(tReflect, ruv - vec2(0.0, px.y), lod + 0.6).rgb * 0.15;
  outgoingLight += min(rc, vec3(3.0)) * uReflK * fres * fade;
}
#include <opaque_fragment>`);
    };
    fm.customProgramCacheKey = () => 'pakswap-floor-v1';
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(16, 96), fm);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.mirrorCam = new THREE.PerspectiveCamera();
    this.mirrorCam.layers.set(0);
    this.mirrorRT = null;
    this._v = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), m: new THREE.Matrix4(), size: new THREE.Vector2() };
  }

  // Draw the mirrored scene for the floor. Layer 1 holds floor-only helpers (contact shadows,
  // underglow), which must not appear in the mirror.
  renderMirror() {
    const r = this.renderer, cam = this.camera, mc = this.mirrorCam, v = this._v;
    const size = r.getDrawingBufferSize(v.size);
    const w = Math.max(64, Math.round(size.x * 0.5)), h = Math.max(64, Math.round(size.y * 0.5));
    if (!this.mirrorRT) {
      this.mirrorRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, samples: 0 });
      this.floorU.tReflect.value = this.mirrorRT.texture;
    } else if (this.mirrorRT.width !== w || this.mirrorRT.height !== h) this.mirrorRT.setSize(w, h);
    cam.updateMatrixWorld();
    // mirror the camera in the floor plane y = 0
    v.a.setFromMatrixPosition(cam.matrixWorld);
    v.b.set(0, 0, -1).transformDirection(cam.matrixWorld).add(v.a);
    v.c.set(0, 1, 0).transformDirection(cam.matrixWorld);
    mc.position.set(v.a.x, -v.a.y, v.a.z);
    mc.up.set(v.c.x, -v.c.y, v.c.z);
    mc.lookAt(v.b.x, -v.b.y, v.b.z);
    mc.near = cam.near; mc.far = cam.far;
    mc.updateMatrixWorld();
    // the mirrored view is flipped left to right, so a sideways-shifted projection (the view
    // offset that keeps the car clear of the panels) has to be shifted the other way
    mc.projectionMatrix.copy(cam.projectionMatrix);
    mc.projectionMatrix.elements[8] *= -1;
    mc.projectionMatrixInverse.copy(mc.projectionMatrix).invert();
    this.floorU.uReflMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(mc.projectionMatrix).multiply(mc.matrixWorldInverse);
    const prevRT = r.getRenderTarget(), prevBg = this.scene.background, prevFog = this.scene.fog;
    const autoShadow = r.shadowMap.autoUpdate, needShadow = r.shadowMap.needsUpdate;
    this.floor.visible = false;
    this.scene.background = null; this.scene.fog = null;
    r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = false;
    r.setRenderTarget(this.mirrorRT);
    r.render(this.scene, mc);
    r.setRenderTarget(prevRT);
    r.shadowMap.autoUpdate = autoShadow; r.shadowMap.needsUpdate = needShadow;
    this.scene.background = prevBg; this.scene.fog = prevFog;
    this.floor.visible = true;
  }

  // ---------------------------------------------------------------- quality
  // q: 'auto' | 'high' | 'medium' | 'low'
  setQuality(q) {
    if (!['auto', 'high', 'medium', 'low'].includes(q)) q = 'auto';
    this.quality = q;
    this.tier = q === 'auto' ? this.gpuTier : q;
    this.scale = 1;
    Object.assign(this.gov, { acc: 0, n: 0, slow: 0, fast: 0, cool: 2, ceil: 1, ceilT: 0, fails: 0, lock: 0, mode: 'steady' });
    this.applyTier();
  }

  basePixelRatio() {
    const d = window.devicePixelRatio || 1;
    return this.tier === 'high' ? Math.min(d, 2) : this.tier === 'medium' ? Math.min(d, 1.5) : Math.min(d, 1);
  }

  applyTier() {
    const q = this.tier, r = this.renderer;
    const shadows = q !== 'low';
    r.shadowMap.enabled = shadows;
    this.key.castShadow = shadows;
    if (shadows) {
      const n = q === 'high' ? 2048 : 1024;
      if (this.key.shadow.mapSize.x !== n) { this.key.shadow.mapSize.set(n, n); this.key.shadow.map?.dispose(); this.key.shadow.map = null; }
    }
    this.floorU.uReflK.value = q === 'high' ? (this.night ? 0.55 : 0.32) : 0;
    if (q !== 'high' && this.mirrorRT) { this.mirrorRT.dispose(); this.mirrorRT = null; this.floorU.tReflect.value = null; }
    this.applyScale();
    this.updateComposer();
    if (this.driver && this.driver.applyQuality) this.driver.applyQuality();
    this.invalidate(3, true);
  }

  applyScale() {
    this.renderer.setPixelRatio(this.basePixelRatio() * this.scale);
    this.resize();
  }

  // Frame-rate governor. Called once per drawn frame with the real time since the last one.
  // It lowers the render resolution while the frame rate is poor, keeps a reduction only if it
  // actually bought frames, and otherwise tries the next quality tier down (auto mode only). If
  // neither helps, the machine is limited by something else (CPU, a capped refresh rate), so
  // everything is put back and the governor rests.
  govern(dt) {
    const g = this.gov;
    if (this.quality !== 'auto') return;
    if (dt > 0.25 || dt <= 0) { g.acc = 0; g.n = 0; return; }
    g.acc += dt; g.n++;
    if (g.acc < 0.75 || g.n < 12) return;
    const win = g.acc, fps = g.n / g.acc;
    g.acc = 0; g.n = 0;
    if (g.ceilT > 0) g.ceilT -= win;
    if (g.lock > 0) { g.lock -= win; return; }
    if (g.cool > 0) { g.cool--; return; }
    const ti = TIERS.indexOf(this.tier);
    const helped = fps > g.before * 1.12 || fps >= 50;
    if (g.mode === 'scale') {
      g.mode = 'steady';
      if (helped) g.fails = 0;
      else if (++g.fails >= 2) {
        g.fails = 0;
        this.scale = g.from; this.applyScale();
        if (ti > 0) { g.mode = 'tier'; g.before = fps; g.fromTier = this.tier; this.tier = TIERS[ti - 1]; this.applyTier(); g.cool = 3; } else { g.lock = 30; g.cool = 2; }
        return;
      }
    } else if (g.mode === 'tier') {
      g.mode = 'steady';
      if (helped) { if (this.onTier) this.onTier(this.tier, 'slow'); } else { this.tier = g.fromTier; this.applyTier(); g.lock = 60; g.cool = 3; return; }
    }
    if (fps < 46) {
      g.fast = 0;
      if (++g.slow < 2) return;
      g.slow = 0;
      if (this.scale > MIN_SCALE + 0.01) {
        if (!g.fails) g.from = this.scale;
        g.before = fps; g.ceil = this.scale; g.ceilT = 40;
        this.scale = Math.max(MIN_SCALE, this.scale * 0.8);
        this.applyScale(); g.mode = 'scale'; g.cool = 1;
      } else if (ti > 0 && fps < 40) {
        g.mode = 'tier'; g.before = fps; g.fromTier = this.tier;
        this.tier = TIERS[ti - 1]; this.scale = 0.8;
        this.applyTier(); g.cool = 3;
      }
    } else if (fps > 57) {
      g.slow = 0;
      const top = g.ceilT > 0 ? g.ceil * 0.99 : 1;
      if (++g.fast >= 4 && this.scale < top - 0.01) {
        g.fast = 0;
        this.scale = Math.min(top, this.scale * 1.12);
        this.applyScale(); g.cool = 1;
      }
    } else { g.slow = 0; g.fast = 0; }
  }

  updateComposer() {
    const want = this.night && this.tier === 'high';
    if (want && !this.composer) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      // multisampled HDR target: without it the post chain would lose the canvas anti-aliasing
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      const c = new EffectComposer(this.renderer, rt);
      c.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.3, 0.42, 1.25);
      c.addPass(this.bloom);
      c.addPass(new OutputPass());
      this.composer = c;
      this.resize();
    } else if (!want && this.composer) {
      this.composer.dispose();
      this.bloom?.dispose?.();
      this.composer = null; this.bloom = null;
    }
  }

  setNight(on) {
    this.night = on;
    this.scene.background = backgroundTexture(on);
    this.scene.fog = new THREE.Fog(on ? '#090b10' : '#dfe2e6', 9, 24);
    this.scene.environment = this.envFor(on);
    this.floor.material.map = floorTexture(on);
    this.floor.material.roughness = on ? 0.45 : 0.6;
    this.floor.material.envMapIntensity = on ? 0.08 : 0.25;
    this.scene.environmentIntensity = on ? 0.8 : 0.95;
    this.hemi.intensity = on ? 0.12 : 0.45;
    this.key.intensity = on ? 0.5 : 1.25;
    this.rim.intensity = on ? 0.55 : 0.35;
    this.rim2.intensity = on ? 0.3 : 0.15;
    this.renderer.toneMappingExposure = on ? 1.08 : 1.0;
    this.floorU.uReflK.value = this.tier === 'high' ? (on ? 0.55 : 0.32) : 0;
    this.updateComposer();
    this.invalidate(3, true);
  }

  // ---------------------------------------------------------------- layout
  // Screen space covered by the interface panels, in CSS pixels. The car is framed in what is
  // left, by shifting the projection instead of shrinking the canvas.
  setInsets(i) {
    const n = { left: Math.max(0, i.left || 0), right: Math.max(0, i.right || 0), top: Math.max(0, i.top || 0), bottom: Math.max(0, i.bottom || 0) };
    const o = this.insets;
    if (n.left === o.left && n.right === o.right && n.top === o.top && n.bottom === o.bottom) return;
    this.insets = n;
    this.resize();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const size = this.renderer.getSize(this._v.size);
    if (size.x !== w || size.y !== h || this._pr !== this.renderer.getPixelRatio()) {
      this.renderer.setSize(w, h, false);
      this._pr = this.renderer.getPixelRatio();
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.gov.cool = Math.max(this.gov.cool, 1);
    }
    const i = this.insets;
    const fw = Math.max(80, w - i.left - i.right), fh = Math.max(80, h - i.top - i.bottom);
    this.freeW = fw; this.freeH = fh; this.fullW = w; this.fullH = h;
    this.camera.aspect = w / h;
    this.camera.fov = fw / fh < 0.9 ? 44 : 32;
    const dx = i.left + fw / 2 - w / 2, dy = i.top + fh / 2 - h / 2;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) this.camera.setViewOffset(w, h, -dx, -dy, w, h); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    if (this.lastPreset && !this.userInteracted && this.carLen) { const [n, e] = this.lastPreset; this.preset(n, e); if (this.tween) this.tween.dur = 0.35; }
    this.invalidate(2);
  }

  frameCar(len, height) {
    this.carLen = len; this.carH = height; this.userInteracted = false;
    this.controls.target.set(0, Math.min(0.75, height * 0.42), 0);
    this.controls.minDistance = Math.max(2.4, len * 0.62);
    this.controls.maxDistance = Math.max(9, len * 3);
    this.invalidate(2, true);
  }

  flyTo(pos, target, dur = 1.1) {
    const q0 = this.controls.target.clone();
    const s0 = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(q0));
    const s1 = new THREE.Spherical().setFromVector3(pos.clone().sub(target));
    let dth = s1.theta - s0.theta;
    while (dth > Math.PI) dth -= Math.PI * 2;
    while (dth < -Math.PI) dth += Math.PI * 2;
    this.tween = { t: 0, dur, s0, s1, dth, q0, q1: target.clone(), sp: new THREE.Spherical() };
    this.invalidate();
  }

  // Distance at which a car of this size fills the free part of the view.
  fitDistance(len, height, along, fw = this.freeW, fh = this.freeH, full = this.fullH) {
    const vf = (this.camera.fov * Math.PI) / 180;
    const tv = Math.tan(vf / 2);
    const halfW = len * along * 0.5 + 0.45;
    const halfH = height * 0.62 + 0.3;
    // half-angles of the free region, measured against the full-height projection
    const th = tv * ((fw || 1) / (full || 1)), tvf = tv * ((fh || 1) / (full || 1));
    return Math.max(halfW / th, halfH / tvf);
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

  // A clean, centred picture of the car for the build card (panels do not cover it).
  snapshot(width = 1600, aspect = 16 / 9) {
    const r = this.renderer, cam = this.camera;
    const pr = r.getPixelRatio();
    const h = Math.round(width / aspect);
    const pos = cam.position.clone();
    const T = this.controls.target;
    r.setPixelRatio(1);
    r.setSize(width, h, false);
    cam.clearViewOffset();
    cam.aspect = aspect; cam.fov = 32; cam.updateProjectionMatrix();
    // same viewing direction, pulled in or out so the car fills the card
    const off = pos.clone().sub(T);
    const want = this.fitDistance(this.carLen || 4.2, this.carH || 1.5, 0.95, width, h, h);
    if (this.lastPreset && this.lastPreset[0] !== 'engine') off.setLength(Math.max(want, this.controls.minDistance));
    cam.position.copy(T).add(off); cam.lookAt(T); cam.updateMatrixWorld();
    r.shadowMap.needsUpdate = true;
    if (this.floorU.uReflK.value > 0) this.renderMirror();
    if (this.composer) { this.composer.setPixelRatio(1); this.composer.setSize(width, h); this.composer.render(); } else r.render(this.scene, cam);
    const url = r.domElement.toDataURL('image/png');
    cam.position.copy(pos); cam.lookAt(T);
    r.setPixelRatio(pr);
    this._pr = -1;
    this.resize();
    this.invalidate(2, true);
    return url;
  }

  rebuildAfterRestore() {
    for (const k of Object.keys(this.envs)) { this.envs[k].dispose(); delete this.envs[k]; }
    this.pmrem.dispose(); this.pmrem = new THREE.PMREMGenerator(this.renderer);
    if (this.mirrorRT) { this.mirrorRT.dispose(); this.mirrorRT = null; this.floorU.tReflect.value = null; }
    if (this.composer) { this.composer.dispose(); this.bloom?.dispose?.(); this.composer = null; this.bloom = null; }
    this.setNight(this.night);
    this.applyTier();
  }

  loop() {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    const raw = this.clock.getDelta();
    const dt = Math.min(0.05, raw);
    if (this.lost) return;
    // drive mode takes over the renderer
    if (this.driver) { this.driver.frame(dt); this.govern(raw); return; }
    if (this.tween) {
      const tw = this.tween;
      tw.t += dt / tw.dur;
      const k = tw.t >= 1 ? 1 : tw.t < 0.5 ? 4 * tw.t * tw.t * tw.t : 1 - Math.pow(-2 * tw.t + 2, 3) / 2;
      this.controls.target.lerpVectors(tw.q0, tw.q1, k);
      tw.sp.set(tw.s0.radius + (tw.s1.radius - tw.s0.radius) * k, tw.s0.phi + (tw.s1.phi - tw.s0.phi) * k, tw.s0.theta + tw.dth * k);
      this.camera.position.setFromSpherical(tw.sp).add(this.controls.target);
      if (tw.t >= 1) this.tween = null;
      this.invalidate(2);
    }
    this.controls.update(dt);
    for (const f of this.onFrame) f(dt);
    if (this.needs <= 0) { this.rendered = false; return; }
    this.needs--;
    if (this.floorU.uReflK.value > 0) this.renderMirror();
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    // only judge the frame rate while frames follow each other
    if (this.rendered) this.govern(raw);
    this.rendered = true;
  }
}
