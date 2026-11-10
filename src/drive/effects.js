// Tyre smoke and dust (instanced billboards), skid marks (ring buffer of quads) and sparks.
import * as THREE from 'three';
import { smokeTexture, glowTexture } from './textures.js';

const smoke_vs = `
attribute vec2 corner; attribute vec3 iPos; attribute float iSize; attribute float iAlpha; attribute float iRot; attribute vec3 iCol;
varying vec2 vUv; varying float vA; varying vec3 vC;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = viewMatrix * vec4(iPos, 1.0);
  float c = cos(iRot), s = sin(iRot);
  mvPosition.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * iSize;
  gl_Position = projectionMatrix * mvPosition;
  vUv = corner + 0.5;
  vA = iAlpha * smoothstep(0.4, 3.5, -mvPosition.z);
  vC = iCol;
  #include <fog_vertex>
}`;
const smoke_fs = `
uniform sampler2D map; uniform vec3 uLight;
varying vec2 vUv; varying float vA; varying vec3 vC;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(vC * uLight, t.a * vA);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class Effects {
  constructor(scene, quality = 'high') {
    this.scene = scene;
    this.q = quality;
    // ---------------- smoke and dust
    const MAX = quality === 'low' ? 260 : quality === 'medium' ? 480 : 760;
    this.max = MAX;
    this.parts = [];
    this.free = [];
    for (let i = 0; i < MAX; i++) { this.parts.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, s0: 1, s1: 3, a0: 0.4, rot: 0, vr: 0, r: 1, g: 1, b: 1, buoy: 0.3, d2: 0 }); this.free.push(i); }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5], 2));
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iSize', this.aSize); g.setAttribute('iAlpha', this.aAlpha); g.setAttribute('iRot', this.aRot); g.setAttribute('iCol', this.aCol);
    g.instanceCount = 0;
    this.smokeTex = smokeTexture();
    this.smokeMat = new THREE.ShaderMaterial({
      vertexShader: smoke_vs, fragmentShader: smoke_fs, transparent: true, depthWrite: false, fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, uLight: { value: new THREE.Vector3(1, 1, 1) } }]),
    });
    this.smokeMat.uniforms.map.value = this.smokeTex;
    this.smoke = new THREE.Mesh(g, this.smokeMat);
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 10;
    scene.add(this.smoke);
    this.order = new Int32Array(MAX);
    // ---------------- skid marks
    const SEG = quality === 'low' ? 1600 : 4200;
    this.seg = SEG;
    const pos = new Float32Array(SEG * 4 * 3), col = new Float32Array(SEG * 4 * 4);
    const idx = new Uint32Array(SEG * 6);
    for (let i = 0; i < SEG; i++) { const b = i * 4; idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6); }
    const sg = new THREE.BufferGeometry();
    this.skPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.skCol = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
    sg.setAttribute('position', this.skPos); sg.setAttribute('color', this.skCol);
    sg.setIndex(new THREE.BufferAttribute(idx, 1));
    this.skMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, color: '#ffffff' });
    this.skids = new THREE.Mesh(sg, this.skMat);
    this.skids.frustumCulled = false;
    this.skids.renderOrder = 5;
    scene.add(this.skids);
    this.skHead = 0; this.skLo = Infinity; this.skHi = -1;
    this.trails = [0, 1, 2, 3].map(() => ({ on: false, lx: 0, lz: 0, rx: 0, rz: 0, a: 0, cx: 0, cz: 0 }));
    // ---------------- sparks
    const SP = 260;
    this.sparks = [];
    for (let i = 0; i < SP; i++) this.sparks.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 0.4 });
    const spg = new THREE.BufferGeometry();
    this.spPos = new THREE.BufferAttribute(new Float32Array(SP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.spCol = new THREE.BufferAttribute(new Float32Array(SP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    spg.setAttribute('position', this.spPos); spg.setAttribute('color', this.spCol);
    this.spTex = glowTexture('rgba(255,240,200,1)', 'rgba(255,160,60,0)');
    this.spMat = new THREE.PointsMaterial({ size: 0.16, map: this.spTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    this.spPts = new THREE.Points(spg, this.spMat);
    this.spPts.frustumCulled = false;
    this.spPts.renderOrder = 11;
    scene.add(this.spPts);
    this.light = 1;
  }

  setLight(day) {
    // smoke is lit by the sky: bright in the day, dim grey under floodlights
    this.light = day;
    this.smokeMat.uniforms.uLight.value.set(day, day, day * 1.02);
  }

  // ---------------------------------------------------------------- smoke / dust
  emit(x, y, z, vx, vy, vz, kind, strength = 1) {
    const i = this.free.pop();
    if (i === undefined) return;
    const p = this.parts[i];
    p.alive = true; p.x = x; p.y = y; p.z = z; p.age = 0;
    const R = Math.random;
    if (kind === 'dust') {
      p.vx = vx + (R() - 0.5) * 1.6; p.vy = vy + 0.4 + R() * 0.9; p.vz = vz + (R() - 0.5) * 1.6;
      p.life = 1.6 + R() * 1.6; p.s0 = 0.7; p.s1 = 4.2 + R() * 2.5; p.a0 = 0.26 * strength; p.buoy = -0.1;
      const t = 0.55 + R() * 0.08; p.r = t * 1.12; p.g = t * 0.98; p.b = t * 0.78;
    } else if (kind === 'diesel') {
      p.vx = vx + (R() - 0.5) * 0.6; p.vy = vy + 0.3 + R() * 0.4; p.vz = vz + (R() - 0.5) * 0.6;
      p.life = 1.2 + R() * 0.9; p.s0 = 0.25; p.s1 = 2.2 + R(); p.a0 = 0.32 * strength; p.buoy = 0.35;
      const t = 0.1 + R() * 0.06; p.r = t; p.g = t; p.b = t;
    } else if (kind === 'exhaust') {
      p.vx = vx + (R() - 0.5) * 0.3; p.vy = vy + 0.2 + R() * 0.2; p.vz = vz + (R() - 0.5) * 0.3;
      p.life = 0.9 + R() * 0.6; p.s0 = 0.18; p.s1 = 1.3; p.a0 = 0.16 * strength; p.buoy = 0.5;
      const t = 0.82; p.r = t; p.g = t; p.b = t;
    } else {
      // tyre smoke: dense, white-grey, rolls along the ground then lifts
      p.vx = vx + (R() - 0.5) * 1.2; p.vy = vy + 0.25 + R() * 0.5; p.vz = vz + (R() - 0.5) * 1.2;
      p.life = 2.4 + R() * 2.2; p.s0 = 0.6 + R() * 0.3; p.s1 = 5.5 + R() * 3.5; p.a0 = (0.2 + R() * 0.12) * strength; p.buoy = 0.32;
      const t = 0.86 + R() * 0.1; p.r = t; p.g = t; p.b = t * 1.01;
    }
    p.rot = R() * Math.PI * 2; p.vr = (R() - 0.5) * 0.8;
  }

  // ---------------------------------------------------------------- skid marks for wheel k
  mark(k, on, x, z, ax, az, halfW, alpha) {
    const tr = this.trails[k];
    if (!on || alpha < 0.02) { tr.on = false; return; }
    const lx = x + ax * halfW, lz = z + az * halfW, rx = x - ax * halfW, rz = z - az * halfW;
    if (!tr.on) { tr.on = true; tr.lx = lx; tr.lz = lz; tr.rx = rx; tr.rz = rz; tr.a = alpha; tr.cx = x; tr.cz = z; return; }
    const d = Math.hypot(x - tr.cx, z - tr.cz);
    if (d < 0.22) return;
    if (d > 3) { tr.lx = lx; tr.lz = lz; tr.rx = rx; tr.rz = rz; tr.cx = x; tr.cz = z; tr.a = alpha; return; }
    const i = this.skHead;
    this.skHead = (this.skHead + 1) % this.seg;
    const P = this.skPos.array, C = this.skCol.array, y = 0.042;
    const b = i * 12;
    P[b] = tr.lx; P[b + 1] = y; P[b + 2] = tr.lz;
    P[b + 3] = tr.rx; P[b + 4] = y; P[b + 5] = tr.rz;
    P[b + 6] = rx; P[b + 7] = y; P[b + 8] = rz;
    P[b + 9] = lx; P[b + 10] = y; P[b + 11] = lz;
    const c = i * 16, k0 = 0.035;
    for (let v = 0; v < 4; v++) { C[c + v * 4] = k0; C[c + v * 4 + 1] = k0; C[c + v * 4 + 2] = k0; C[c + v * 4 + 3] = v < 2 ? tr.a : alpha; }
    this.skLo = Math.min(this.skLo, i); this.skHi = Math.max(this.skHi, i);
    tr.lx = lx; tr.lz = lz; tr.rx = rx; tr.rz = rz; tr.a = alpha; tr.cx = x; tr.cz = z;
  }

  clearMarks() {
    this.skPos.array.fill(0); this.skCol.array.fill(0);
    this.skPos.needsUpdate = true; this.skCol.needsUpdate = true;
    this.skHead = 0;
    for (const t of this.trails) t.on = false;
    for (const p of this.parts) if (p.alive) { p.alive = false; this.free.push(this.parts.indexOf(p)); }
  }

  // ---------------------------------------------------------------- sparks
  spark(x, y, z, vx, vz, n) {
    for (let k = 0; k < n; k++) {
      const s = this.sparks.find((q) => !q.alive);
      if (!s) return;
      const R = Math.random;
      s.alive = true; s.age = 0; s.life = 0.25 + R() * 0.45;
      s.x = x; s.y = y; s.z = z;
      s.vx = vx * (0.4 + R() * 0.5) + (R() - 0.5) * 4; s.vy = 1 + R() * 3.5; s.vz = vz * (0.4 + R() * 0.5) + (R() - 0.5) * 4;
    }
  }

  update(dt, camera) {
    // smoke
    const cam = camera.position;
    let n = 0;
    const wind = 0.7;
    for (let i = 0; i < this.max; i++) {
      const p = this.parts[i];
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) { p.alive = false; this.free.push(i); continue; }
      const drag = Math.exp(-dt * 1.3);
      p.vx *= drag; p.vz *= drag; p.vy = p.vy * Math.exp(-dt * 0.8) + p.buoy * dt;
      p.x += (p.vx + wind) * dt; p.y += p.vy * dt; p.z += (p.vz - wind * 0.4) * dt;
      const sz = p.s0 + (p.s1 - p.s0) * (1 - Math.exp(-p.age * 1.25));
      if (p.y < sz * 0.32) p.y = sz * 0.32;
      p.rot += p.vr * dt;
      p.size = sz;
      const u = p.age / p.life;
      p.alpha = p.a0 * Math.min(1, p.age / 0.12) * Math.pow(1 - u, 1.6);
      p.d2 = (p.x - cam.x) ** 2 + (p.y - cam.y) ** 2 + (p.z - cam.z) ** 2;
      this.order[n++] = i;
    }
    // back to front
    const ord = Array.from(this.order.subarray(0, n)).sort((a, b) => this.parts[b].d2 - this.parts[a].d2);
    const P = this.aPos.array, S = this.aSize.array, A = this.aAlpha.array, Ro = this.aRot.array, C = this.aCol.array;
    for (let k = 0; k < ord.length; k++) {
      const p = this.parts[ord[k]];
      P[k * 3] = p.x; P[k * 3 + 1] = p.y; P[k * 3 + 2] = p.z;
      S[k] = p.size; A[k] = p.alpha; Ro[k] = p.rot;
      C[k * 3] = p.r; C[k * 3 + 1] = p.g; C[k * 3 + 2] = p.b;
    }
    this.smoke.geometry.instanceCount = ord.length;
    for (const a of [this.aPos, this.aSize, this.aAlpha, this.aRot, this.aCol]) a.needsUpdate = true;
    // skid marks: upload only what changed
    if (this.skHi >= 0) {
      this.skPos.clearUpdateRanges(); this.skCol.clearUpdateRanges();
      this.skPos.addUpdateRange(this.skLo * 12, (this.skHi - this.skLo + 1) * 12);
      this.skCol.addUpdateRange(this.skLo * 16, (this.skHi - this.skLo + 1) * 16);
      this.skPos.needsUpdate = true; this.skCol.needsUpdate = true;
      this.skLo = Infinity; this.skHi = -1;
    }
    // sparks
    const SPp = this.spPos.array, SPc = this.spCol.array;
    this.sparks.forEach((s, i) => {
      if (s.alive) {
        s.age += dt;
        if (s.age >= s.life) s.alive = false;
        s.vy -= 9.81 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
        if (s.y < 0.02) { s.y = 0.02; s.vy *= -0.3; s.vx *= 0.6; s.vz *= 0.6; }
      }
      const k = s.alive ? Math.pow(1 - s.age / s.life, 1.5) * 2.2 : 0;
      SPp[i * 3] = s.x; SPp[i * 3 + 1] = s.alive ? s.y : -100; SPp[i * 3 + 2] = s.z;
      SPc[i * 3] = k; SPc[i * 3 + 1] = k * 0.62; SPc[i * 3 + 2] = k * 0.25;
    });
    this.spPos.needsUpdate = true; this.spCol.needsUpdate = true;
  }

  dispose() {
    for (const o of [this.smoke, this.skids, this.spPts]) { this.scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
    this.smokeTex.dispose(); this.spTex.dispose();
  }
}
