// Sky (Preetham daylight model), sun and moon, stars, clouds, distant Karakoram-style mountains,
// fog matched to the horizon and an environment map for reflections.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function noise1(seed) {
  const R = rng(seed), N = 512, v = new Float32Array(N);
  for (let i = 0; i < N; i++) v[i] = R();
  return (x) => { const i = Math.floor(x), f = x - i, a = v[((i % N) + N) % N], b = v[(((i + 1) % N) + N) % N]; const s = f * f * (3 - 2 * f); return a + (b - a) * s; };
}

// three.js ACES filmic tone mapping, on the CPU
function acesColor(c, exposure) {
  const e = exposure / 0.6;
  let r = c.r * e, g = c.g * e, b = c.b * e;
  const i0 = 0.59719 * r + 0.35458 * g + 0.04823 * b, i1 = 0.076 * r + 0.90834 * g + 0.01566 * b, i2 = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const f0 = fit(i0), f1 = fit(i1), f2 = fit(i2);
  r = 1.60475 * f0 - 0.53108 * f1 - 0.07367 * f2; g = -0.10208 * f0 + 1.10813 * f1 - 0.00605 * f2; b = -0.00327 * f0 - 0.07276 * f1 + 1.07602 * f2;
  const cl = (v) => Math.max(0, Math.min(1, v));
  return new THREE.Color().setRGB(cl(r), cl(g), cl(b), THREE.LinearSRGBColorSpace);
}

export const TIMES = {
  day: { el: 34, az: 228, turbidity: 3.2, rayleigh: 2.0, mie: 0.0042, g: 0.82, exposure: 0.5, sun: 3.4, sunCol: '#fff1de', hemi: 0.55, sky: '#bcd2ee', ground: '#5d5440', fogK: 0.00026, clouds: 0.85, stars: 0 },
  evening: { el: 7, az: 252, turbidity: 8, rayleigh: 2.4, mie: 0.007, g: 0.88, exposure: 0.62, sun: 2.4, sunCol: '#ffb36b', hemi: 0.4, sky: '#9fb0c8', ground: '#4a3b2c', fogK: 0.0003, clouds: 0.7, stars: 0 },
  night: { el: -16, az: 250, turbidity: 2, rayleigh: 0.6, mie: 0.004, g: 0.8, exposure: 0.95, sun: 0.0, sunCol: '#9fb4ff', hemi: 0.1, sky: '#20304e', ground: '#0c0c10', fogK: 0.00034, clouds: 0.25, stars: 1, moon: 0.22 },
};

export class SkySystem {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);
    this.sunDir = new THREE.Vector3();
    // sun (or moon) light with a shadow box that follows the car
    this.sun = new THREE.DirectionalLight('#ffffff', 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -42; sc.right = 42; sc.top = 42; sc.bottom = -42; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight('#bcd2ee', '#5d5440', 0.5);
    scene.add(this.hemi);
    this.buildStars();
    this.buildClouds();
    this.buildMountains();
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky(); this.envSky.scale.setScalar(5000);
    this.envScene.add(this.envSky);
    const groundDisc = new THREE.Mesh(new THREE.CircleGeometry(400, 32), new THREE.MeshBasicMaterial({ color: '#4c4637' }));
    groundDisc.rotation.x = -Math.PI / 2; groundDisc.position.y = -6;
    this.envGround = groundDisc;
    this.envScene.add(groundDisc);
    this.env = null;
  }

  setTime(name) {
    const T = TIMES[name] || TIMES.day;
    this.time = name; this.T = T;
    const phi = THREE.MathUtils.degToRad(90 - T.el), theta = THREE.MathUtils.degToRad(T.az);
    // azimuth measured from north (-z) clockwise toward east (+x)
    this.sunDir.set(Math.sin(phi) * Math.sin(theta), Math.cos(phi), -Math.sin(phi) * Math.cos(theta));
    for (const s of [this.sky, this.envSky]) {
      const u = s.material.uniforms;
      u.turbidity.value = T.turbidity; u.rayleigh.value = T.rayleigh; u.mieCoefficient.value = T.mie; u.mieDirectionalG.value = T.g;
      u.sunPosition.value.copy(this.sunDir);
    }
    const night = name === 'night';
    // the moon lights the night: bluish, from high up
    this.lightDir = night ? new THREE.Vector3(-0.35, 0.82, 0.45).normalize() : this.sunDir.clone();
    this.sun.color.set(T.sunCol);
    this.sun.intensity = night ? T.moon : T.sun * Math.min(1, Math.max(0.15, T.el / 12));
    this.hemi.color.set(T.sky); this.hemi.groundColor.set(T.ground); this.hemi.intensity = T.hemi;
    this.stars.visible = night;
    this.moon.visible = night;
    this.clouds.material.uniforms.uAmt.value = T.clouds;
    this.clouds.material.uniforms.uSun.value.copy(this.sunDir);
    this.clouds.material.uniforms.uNight.value = night ? 1 : 0;
    this.clouds.material.uniforms.uTint.value.set(name === 'evening' ? '#ffcf9e' : night ? '#3a4766' : '#ffffff');
    this.envGround.material.color.set(night ? '#060608' : name === 'evening' ? '#3d3227' : '#4c4637');
    // environment for reflections
    if (this.env) this.env.dispose();
    this.env = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 1000).texture;
    this.scene.environment = this.env;
    this.scene.environmentIntensity = night ? 0.35 : name === 'evening' ? 0.9 : 1.0;
    // fog that matches the sky at the horizon (fog is blended after tone mapping, so map it the same way)
    const fogCol = night ? new THREE.Color().setRGB(0.004, 0.006, 0.012) : acesColor(this.horizonColor(), T.exposure);
    this.scene.fog = new THREE.FogExp2(fogCol, T.fogK);
    this.scene.background = null;
    this.mountainMat.uniforms.uNight.value = night ? 1 : 0;
    this.mountainMat.uniforms.uSun.value.copy(this.sunDir);
    this.mountainMat.uniforms.uSunCol.value.set(T.sunCol);
    return T;
  }

  // Render the sky once looking at the horizon (away from the sun) and average it.
  horizonColor() {
    const r = this.renderer;
    const rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.FloatType });
    const cam = new THREE.PerspectiveCamera(20, 1, 1, 30000);
    const az = Math.atan2(this.sunDir.x, -this.sunDir.z) + Math.PI / 2;
    cam.position.set(0, 0, 0);
    cam.lookAt(Math.sin(az), 0.04, -Math.cos(az));
    const prev = r.getRenderTarget();
    const tm = r.toneMapping; r.toneMapping = THREE.NoToneMapping;
    r.setRenderTarget(rt);
    r.render(this.envScene, cam);
    const px = new Float32Array(16 * 16 * 4);
    r.readRenderTargetPixels(rt, 0, 0, 16, 16, px);
    r.setRenderTarget(prev); r.toneMapping = tm;
    rt.dispose();
    let R = 0, G = 0, B = 0, n = 0;
    for (let y = 6; y < 12; y++) for (let x = 0; x < 16; x++) { const o = (y * 16 + x) * 4; R += px[o]; G += px[o + 1]; B += px[o + 2]; n++; }
    const c = new THREE.Color();
    c.setRGB(R / n, G / n, B / n, THREE.LinearSRGBColorSpace);
    if (!isFinite(c.r) || c.r + c.g + c.b < 1e-4) c.set('#c3cfd9');
    return c;
  }

  buildStars() {
    const R = rng(99), n = 2600;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = R(), v = R();
      const th = u * Math.PI * 2, ph = Math.acos(1 - v * 0.98);
      const r = 9000;
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.cos(ph); pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      const b = Math.pow(R(), 3) * 0.9 + 0.1, warm = R();
      col[i * 3] = b * (0.85 + warm * 0.15); col[i * 3 + 1] = b * 0.9; col[i * 3 + 2] = b * (1 - warm * 0.15);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false, transparent: true }));
    this.stars.frustumCulled = false; this.stars.renderOrder = -9;
    this.scene.add(this.stars);
    const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(255,253,240,1)'); gr.addColorStop(0.18, 'rgba(250,248,235,1)'); gr.addColorStop(0.24, 'rgba(200,210,255,0.25)'); gr.addColorStop(1, 'rgba(160,180,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, S, S);
    const mt = new THREE.CanvasTexture(c); mt.colorSpace = THREE.SRGBColorSpace;
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: mt, fog: false, depthWrite: false, transparent: true, color: '#ffffff' }));
    this.moon.scale.setScalar(900); this.moon.position.set(-3500, 6200, 4400);
    this.moon.renderOrder = -8;
    this.scene.add(this.moon);
  }

  buildClouds() {
    // a high cloud deck with a procedural fbm shader, lit from the sun side
    const g = new THREE.PlaneGeometry(26000, 26000, 1, 1);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uAmt: { value: 0.8 }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uTime: { value: 0 }, uNight: { value: 0 }, uTint: { value: new THREE.Color('#ffffff') } },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        varying vec3 vW; uniform float uAmt; uniform vec3 uSun; uniform float uTime; uniform float uNight; uniform vec3 uTint;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
          return mix(mix(h(i), h(i+vec2(1,0)), u.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), u.x), u.y); }
        float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int k = 0; k < 6; k++){ s += a * n(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; } return s; }
        void main(){
          vec2 p = vW.xz / 2600.0 + vec2(uTime * 0.004, uTime * 0.0017);
          float c = fbm(p);
          float cov = smoothstep(0.52 - uAmt * 0.12, 0.78, c);
          float d = length(vW.xz - cameraPosition.xz);
          float fade = 1.0 - smoothstep(4000.0, 12500.0, d);
          vec3 v = normalize(vW - cameraPosition);
          float toward = pow(max(0.0, dot(normalize(vec3(v.x, 0.0, v.z)), normalize(vec3(uSun.x, 0.0, uSun.z)))), 6.0);
          float shade = mix(0.72, 1.0, smoothstep(0.55, 0.85, c));
          vec3 col = uTint * shade * (1.0 + toward * 0.35) * mix(1.25, 0.08, uNight);
          gl_FragColor = vec4(col, cov * fade * 0.85);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.clouds = new THREE.Mesh(g, m);
    this.clouds.position.y = 1500;
    this.clouds.renderOrder = -7;
    this.clouds.frustumCulled = false;
    this.scene.add(this.clouds);
  }

  buildMountains() {
    // two rings: snowy peaks far away and dry brown foothills closer in
    const ring = (radius, depth, peak, seed, segs, snow) => {
      const nz = noise1(seed), nz2 = noise1(seed + 7), nz3 = noise1(seed + 13);
      const rows = 6;
      const pos = [], col = [], idx = [];
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const u = (i / segs) * 64;
        // broad massifs with a few sharper summits on top
        const big = nz(u * 0.55), mid = nz(u * 1.6 + 7.1);
        const crest = 1 - Math.abs(nz(u * 3.4 + 2.3) * 2 - 1);
        let hgt = big * 0.55 + mid * 0.3 + crest * crest * 0.18 * (0.4 + big);
        hgt = Math.pow(Math.max(0, hgt - 0.12) / 0.9, 1.35) * peak * (0.55 + 0.6 * nz2(u * 0.22));
        const rr = radius + nz3(u * 0.5) * depth;
        for (let r = 0; r <= rows; r++) {
          const t = r / rows;
          const y = hgt * Math.sin((t * Math.PI) / 2);
          const rad = rr - depth * 0.6 * (1 - t);
          pos.push(Math.cos(a) * rad, y - 2, Math.sin(a) * rad);
          col.push(t, snow ? 1 : 0, hgt / peak);
        }
      }
      for (let i = 0; i < segs; i++) for (let r = 0; r < rows; r++) {
        const a = i * (rows + 1) + r, b = a + rows + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };
    this.mountainMat = new THREE.ShaderMaterial({
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uNight: { value: 0 }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color('#fff') } }]),
      vertexShader: `
        attribute vec3 color; varying vec3 vC; varying vec3 vN; varying vec3 vW;
        #include <fog_pars_vertex>
        void main(){ vC = color; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz;
          vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        varying vec3 vC; varying vec3 vN; varying vec3 vW; uniform float uNight; uniform vec3 uSun; uniform vec3 uSunCol;
        #include <fog_pars_fragment>
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        void main(){
          float t = vC.x; float snowRing = vC.y; float rel = vC.z;
          float grain = h(floor(vW.xz / 18.0)) * 0.12;
          vec3 rock = mix(vec3(0.26, 0.24, 0.22), vec3(0.36, 0.33, 0.29), grain * 4.0);
          vec3 dryHill = mix(vec3(0.3, 0.29, 0.2), vec3(0.38, 0.35, 0.24), grain * 4.0);
          vec3 base = mix(dryHill, rock, snowRing);
          float snowLine = 0.55 - grain;
          float snow = snowRing * smoothstep(snowLine, snowLine + 0.08, t * rel + t * 0.25) * smoothstep(0.15, 0.4, vN.y + 0.3);
          vec3 col = mix(base, vec3(0.93, 0.95, 0.98), snow);
          float lit = max(0.0, dot(normalize(vN), normalize(uSun))) * 0.85 + 0.35;
          col *= mix(lit * uSunCol, vec3(0.05, 0.06, 0.09), uNight);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          // distant ranges show through the haze more than the scene fog would let them
          #ifdef USE_FOG
            #ifdef FOG_EXP2
              float fogFactor = 1.0 - exp(-fogDensity * fogDensity * 0.3 * vFogDepth * vFogDepth);
            #else
              float fogFactor = smoothstep(fogNear, fogFar * 1.8, vFogDepth);
            #endif
            gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
          #endif
        }`,
    });
    // both rings stand beyond the open world's corners (it spans 5.2 km), so they never cut into it
    const far = new THREE.Mesh(ring(7600, 900, 1700, 3, 720, true), this.mountainMat);
    const near = new THREE.Mesh(ring(4300, 280, 380, 9, 540, false), this.mountainMat);
    for (const m of [far, near]) m.frustumCulled = false;
    this.mountains = new THREE.Group();
    this.mountains.add(far, near);
    this.scene.add(this.mountains);
  }

  // keep the shadow box centred on the car, snapped to shadow texels to stop shimmering
  follow(x, z, dt) {
    const L = this.lightDir || this.sunDir;
    const sc = this.sun.shadow.camera;
    const tex = (sc.right - sc.left) / this.sun.shadow.mapSize.x;
    const sx = Math.round(x / tex) * tex, sz = Math.round(z / tex) * tex;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx + L.x * 150, L.y * 150, sz + L.z * 150);
    this.sun.target.updateMatrixWorld();
    this.clouds.material.uniforms.uTime.value += dt;
    this.clouds.position.x = x; this.clouds.position.z = z;

  }

  dispose() {
    this.env?.dispose();
    this.pmrem.dispose();
  }
}
