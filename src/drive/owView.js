// Three.js view of the open world: LOD terrain, lake, roads with paint, sidewalks, the city,
// the village, motorway furniture, service areas, poles and wires, trees, plus the drift park.
import * as THREE from 'three';
import * as TX from './textures.js';
import { makeTruckArt } from '../three/textures.js';
import { WorldView, parkMacroTexture, GB } from './worldView.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { S_ASPHALT, S_GRASS } from './track.js';
import { S_SIDEWALK, ROAD_TYPES } from './openworld.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const smooth = (a, b, x) => { if (x <= a) return 0; if (x >= b) return 1; const t = (x - a) / (b - a); return t * t * (3 - 2 * t); };

// markings per road type: offsets measured from the centre line, left positive
const MARKS = {
  motorway: { lines: [{ o: 10.5, w: 0.22 }, { o: -10.5, w: 0.22 }, { o: 6.85, w: 0.16, dash: 4 }, { o: -6.85, w: 0.16, dash: 4 }, { o: 3.2, w: 0.18, col: 'rgba(240,196,40,0.95)' }, { o: -3.2, w: 0.18, col: 'rgba(240,196,40,0.95)' }], median: 2.0 },
  highway: { lines: [{ o: 5.25, w: 0.18 }, { o: -5.25, w: 0.18 }, { o: 0, w: 0.14, dash: 4 }] },
  boulevard: { lines: [{ o: 8.1, w: 0.16 }, { o: -8.1, w: 0.16 }, { o: 4.6, w: 0.13, dash: 3, per: 2 }, { o: -4.6, w: 0.13, dash: 3, per: 2 }], median: 1.05 },
  street: { lines: [{ o: 0, w: 0.12, dash: 3, per: 2 }] },
  ring: { lines: [{ o: 0, w: 0.13, dash: 3, per: 2 }, { o: 5.9, w: 0.15 }, { o: -5.9, w: 0.15 }] },
  mountain: { lines: [{ o: 3.6, w: 0.15 }, { o: -3.6, w: 0.15 }, { o: -0.09, w: 0.1, col: 'rgba(240,196,40,0.95)' }, { o: 0.09, w: 0.1, col: 'rgba(240,196,40,0.95)' }] },
};

export class OpenWorldView {
  constructor(world, opts = {}) {
    this.Wd = world;
    this.q = opts.quality || 'high';
    this.group = new THREE.Group();
    this.group.name = 'open-world';
    this.disposables = [];
    this.uTime = { value: 0 };
    this.uNight = { value: 0 };
    this.lamps = []; // positions that can host a real light at night
    const t0 = performance.now();
    this.park = new WorldView(world.park, { quality: this.q, ground: false, trees: false });
    this.group.add(this.park.group);
    for (const p of this.park.lampHeads) this.lamps.push(p);
    this.buildMaterials();
    this.buildTerrain();
    this.buildWater();
    this.buildRoads();
    this.buildSidewalks();
    this.buildCity();
    this.buildVillage();
    this.buildRoadside();
    this.buildPoles();
    this.buildTrees();
    this.buildTrucks();
    this.buildGrass();
    // Static scenery is baked into one mesh per material *per map cell*, and instanced props
    // (10,000 trees, poles, lamps) are split the same way. A cell that is out of view is skipped
    // whole, so the GPU only ever sees the part of the 5 km map the camera or the sun's shadow
    // box can reach, instead of every triangle of it on every frame.
    this.cells = new Map();
    this.cellList = [];
    const skip = new Set([...this.chunks.map((c) => c.mesh), this.water, this.grass, this.park.cones, this.park.pools].filter(Boolean));
    this.merged = mergeStatic(this.group, skip, this.disposables, (o, cx, cz) => this.cellFor(cx, cz).add(o));
    this.split = splitInstanced(this.group, skip, (o, cx, cz) => this.cellFor(cx, cz).add(o));
    for (const c of this.cellList) {
      const box = new THREE.Box3();
      for (const o of c.children) {
        if (o.isInstancedMesh) { o.computeBoundingSphere(); box.union(new THREE.Box3().setFromCenterAndSize(o.boundingSphere.center, new THREE.Vector3().setScalar(o.boundingSphere.radius * 2))); }
        else { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox); }
      }
      c.userData.bs = box.getBoundingSphere(new THREE.Sphere());
    }
    // the source geometry of everything that was baked is no longer referenced by any mesh:
    // let go of it (it would otherwise sit in memory twice for as long as the world lives)
    const live = new Set();
    this.group.traverse((o) => { if (o.geometry) live.add(o.geometry); });
    for (const v of this.geoCache.values()) live.add(v.g);
    this.disposables = this.disposables.filter((d) => !d.isBufferGeometry || live.has(d));
    this.park.disposables = this.park.disposables.filter((d) => !d.isBufferGeometry || live.has(d));
    this.frustum = new THREE.Frustum();
    this.pm = new THREE.Matrix4();
    this.lodT = 0;
    // how far props and whole cells are drawn, by quality tier: [small, medium, cell range]
    this.reach = this.q === 'low' ? [260, 800, 1900] : this.q === 'medium' ? [520, 1700, 3400] : [900, 2800, 1e9];
    this.lampPick = { t: 0, idx: new Int32Array(8).fill(-1), d2: new Float64Array(8) };
    this.terrainAt = { x: Infinity, y: Infinity, pending: true };
    this.ms = performance.now() - t0;
  }

  cellFor(x, z) {
    const key = (Math.floor(x / CELL) + 512) * 4096 + (Math.floor(z / CELL) + 512);
    let g = this.cells.get(key);
    if (!g) { g = new THREE.Group(); g.name = 'cell'; this.cells.set(key, g); this.cellList.push(g); this.group.add(g); }
    return g;
  }

  // Coarse culling of the map cells: one sphere test per cell, every frame. A cell near the
  // camera stays on even when it is behind it, because it can still cast shadows into view.
  cullCells(camera, dt) {
    camera.updateMatrixWorld();
    this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pm);
    const cp = camera.position;
    this.lodT -= dt;
    const lod = this.lodT <= 0;
    if (lod) this.lodT = 0.25;
    for (let i = 0; i < this.cellList.length; i++) {
      const c = this.cellList[i], bs = c.userData.bs;
      const dx = bs.center.x - cp.x, dy = bs.center.y - cp.y, dz = bs.center.z - cp.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - bs.radius;
      const vis = d < 190 || (d < this.reach[2] && this.frustum.intersectsSphere(bs));
      if (c.visible !== vis) c.visible = vis;
      // small props drop out with distance; checked a few times a second
      if (lod && vis) {
        const ch = c.children;
        for (let k = 0; k < ch.length; k++) { const o = ch[k], cl = o.userData.cls; if (cl !== undefined) { const v = d < (cl === 9 ? o.userData.maxDist : this.reach[cl]); if (o.visible !== v) o.visible = v; } }
      }
    }
  }

  track(o) { this.disposables.push(o); return o; }

  // ---------------------------------------------------------------- shared materials
  buildMaterials() {
    const A = this.park.asphaltTex;
    this.asphalt = A;
    const mk = (opts) => this.track(new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...opts }));
    this.matConcrete = this.park.matConcrete;
    this.matMetal = this.park.matMetal;
    this.matDarkMetal = this.park.matDarkMetal;
    this.matPaint = this.park.matPaint;
    this.matSteel = mk({ color: '#a9aeb3', roughness: 0.38, metalness: 0.85 });
    this.matWhite = mk({ color: '#efece4', roughness: 0.6 });
    this.matGlass = mk({ color: '#1d2a36', roughness: 0.08, metalness: 0.6, envMapIntensity: 1.4 });
    this.matBlack = mk({ color: '#151515', roughness: 0.6 });
    const pav = TX.paverTexture(); this.track(pav);
    this.matPaver = mk({ map: pav, roughness: 0.85 });
    const mud = TX.mudTexture(); this.track(mud);
    this.matMud = mk({ map: mud, roughness: 0.95 });
    this.matCurb = mk({ color: '#b9b5ab', roughness: 0.8 });
    this.matCurbPaint = this.track(new THREE.MeshStandardMaterial({ map: this.park.matKerb.map, roughness: 0.6 }));
    this.matGreen = mk({ color: '#4d6b2e', roughness: 0.95 });
    this.emissiveLamp = mk({ color: '#d8d6cf', emissive: '#ffe8c0', emissiveIntensity: 0, roughness: 0.3 });
  }

  // ---------------------------------------------------------------- terrain
  worldMacro() {
    // colour tint (x100) and a dirt/gravel mask for the whole map, 2048 px over 5.2 km
    const Wd = this.Wd, B = Wd.bounds;
    const S = this.q === 'low' ? 1024 : 2048;
    const size = B.x1 - B.x0, k = S / size;
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const x = cv.getContext('2d');
    const mv = document.createElement('canvas'); mv.width = mv.height = S;
    const m = mv.getContext('2d');
    // base tint from a small noise image, smoothly upscaled
    const N = 128, nc = document.createElement('canvas'); nc.width = nc.height = N;
    const nx = nc.getContext('2d'), img = nx.createImageData(N, N);
    const R = rng(909);
    const lat = Array.from({ length: (N / 8 + 2) ** 2 }, () => R());
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const fx = i / 8, fy = j / 8, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, W2 = N / 8 + 2;
      const g = (a, b) => lat[b * W2 + a];
      const v = (g(ix, iy) * (1 - tx) + g(ix + 1, iy) * tx) * (1 - ty) + (g(ix, iy + 1) * (1 - tx) + g(ix + 1, iy + 1) * tx) * ty;
      const dry = Math.max(0, v - 0.5) * 2;
      const o = (j * N + i) * 4;
      img.data[o] = (0.95 + dry * 0.35 + (R() - 0.5) * 0.06) * 100; img.data[o + 1] = (1.0 + dry * 0.1 + (R() - 0.5) * 0.06) * 100; img.data[o + 2] = (0.95 - dry * 0.25) * 100; img.data[o + 3] = 255;
    }
    nx.putImageData(img, 0, 0);
    x.imageSmoothingEnabled = true; x.drawImage(nc, 0, 0, S, S);
    m.fillStyle = '#000'; m.fillRect(0, 0, S, S);
    const P = (wx, wy) => [(wx - B.x0) * k, (B.y1 - wy) * k];
    // fields
    const tint = { wheat: 'rgb(162,116,52)', mustard: 'rgb(190,160,30)', green: 'rgb(84,120,76)', ploughed: 'rgb(104,92,82)' };
    for (const f of Wd.village.fields) {
      const c = Math.cos(f.ang), s = Math.sin(f.ang);
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => P(f.x + c * a * f.w / 2 - s * b * f.d / 2, f.y + s * a * f.w / 2 + c * b * f.d / 2));
      x.fillStyle = tint[f.kind]; x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.closePath(); x.fill();
      if (f.kind === 'ploughed') { m.fillStyle = 'rgb(95,95,95)'; m.beginPath(); pts.forEach((p, i) => (i ? m.lineTo(p[0], p[1]) : m.moveTo(p[0], p[1]))); m.closePath(); m.fill(); }
    }
    // dusty shoulders along country roads, darker grass along the motorway verge
    for (const rd of Wd.roads) {
      const t = rd.typeName;
      if (['street', 'boulevard', 'ring', 'pad'].includes(t)) continue;
      const w = (rd.type.half + (t === 'motorway' ? 6 : 4)) * 2 * k;
      m.strokeStyle = t === 'motorway' ? 'rgb(30,30,30)' : 'rgb(85,85,85)'; m.lineWidth = w; m.lineJoin = 'round'; m.lineCap = 'round';
      x.strokeStyle = t === 'motorway' ? 'rgb(92,100,88)' : 'rgb(118,104,88)'; x.lineWidth = w; x.lineJoin = 'round'; x.lineCap = 'round';
      for (const ctx of [m, x]) { ctx.beginPath(); for (let i = 0; i < rd.rb.n; i += 2) { const [px, py] = P(rd.rb.x[i], rd.rb.y[i]); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); } if (rd.closed) ctx.closePath(); ctx.stroke(); }
    }
    // village yards and the dhaba
    const v0 = P(-1640, -470);
    const gr = m.createRadialGradient(v0[0], v0[1], 0, v0[0], v0[1], 230 * k); gr.addColorStop(0, 'rgba(110,110,110,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    m.fillStyle = gr; m.fillRect(v0[0] - 240 * k, v0[1] - 240 * k, 480 * k, 480 * k);
    const gx = x.createRadialGradient(v0[0], v0[1], 0, v0[0], v0[1], 230 * k); gx.addColorStop(0, 'rgba(120,104,88,0.85)'); gx.addColorStop(1, 'rgba(120,104,88,0)');
    x.fillStyle = gx; x.fillRect(v0[0] - 240 * k, v0[1] - 240 * k, 480 * k, 480 * k);
    for (const p of Wd.pads) if (p.kind === 'dhaba') { const a = P(p.rect.x0, p.rect.y1), b = P(p.rect.x1, p.rect.y0); m.fillStyle = 'rgb(110,110,110)'; m.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
    // lake shore sand
    const L = Wd.lake;
    {
      const c0 = P(L.x - L.rx * 1.7, L.y + L.ry * 1.7), c1 = P(L.x + L.rx * 1.7, L.y - L.ry * 1.7);
      const xi = x.getImageData(c0[0] | 0, c0[1] | 0, (c1[0] - c0[0]) | 0, (c1[1] - c0[1]) | 0), mi = m.getImageData(c0[0] | 0, c0[1] | 0, (c1[0] - c0[0]) | 0, (c1[1] - c0[1]) | 0);
      for (let j = 0; j < xi.height; j++) for (let i = 0; i < xi.width; i++) {
        const wx = B.x0 + ((c0[0] | 0) + i + 0.5) / k, wy = B.y1 - ((c0[1] | 0) + j + 0.5) / k;
        const h = Wd.HF.heightAt(wx, wy);
        const s = 1 - smooth(L.level + 0.3, L.level + 2.2, h);
        if (s <= 0) continue;
        const o = (j * xi.width + i) * 4;
        xi.data[o] = xi.data[o] * (1 - s) + 150 * s; xi.data[o + 1] = xi.data[o + 1] * (1 - s) + 128 * s; xi.data[o + 2] = xi.data[o + 2] * (1 - s) + 96 * s;
        mi.data[o] = Math.max(mi.data[o], 255 * s);
      }
      x.putImageData(xi, c0[0] | 0, c0[1] | 0); m.putImageData(mi, c0[0] | 0, c0[1] | 0);
    }
    const cd = x.getImageData(0, 0, S, S).data, md = m.getImageData(0, 0, S, S).data;
    const data = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) { data[i * 4] = cd[i * 4]; data[i * 4 + 1] = cd[i * 4 + 1]; data[i * 4 + 2] = cd[i * 4 + 2]; data[i * 4 + 3] = md[i * 4]; }
    const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    t.flipY = false; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
    return this.track(t);
  }

  terrainMaterial() {
    const grass = TX.grassTextures(this.q === 'low' ? 512 : 1024), gravel = TX.gravelTextures(512), rock = TX.rockTextures(512);
    for (const t of [grass.map, grass.normalMap, gravel.map, gravel.normalMap, rock.map, rock.normalMap]) this.track(t);
    const park = parkMacroTexture(this.Wd.park, this.q); this.track(park.tex);
    const world = this.worldMacro();
    const B = this.Wd.bounds;
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.96, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, {
        tGrass: { value: grass.map }, tGrassN: { value: grass.normalMap }, tGravel: { value: gravel.map }, tGravelN: { value: gravel.normalMap },
        tRock: { value: rock.map }, tRockN: { value: rock.normalMap }, tPark: { value: park.tex }, uPark: { value: new THREE.Vector4(-park.half, -park.half, 2 * park.half, 2 * park.half) },
        tWorld: { value: world }, uWorld: { value: new THREE.Vector4(B.x0, B.y0, B.x1 - B.x0, B.y1 - B.y0) },
      });
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWN;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normalize(mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWN; uniform sampler2D tGrass, tGrassN, tGravel, tGravelN, tRock, tRockN, tPark, tWorld; uniform vec4 uPark, uWorld;')
        .replace('#include <map_fragment>', `
          vec2 wp = vec2(vWPos.x, -vWPos.z);
          vec2 wu = (wp - uWorld.xy) / uWorld.zw;
          vec4 mW = texture2D(tWorld, vec2(wu.x, 1.0 - wu.y));
          mW.rgb *= 2.55;
          vec2 pu = (wp - uPark.xy) / uPark.zw;
          float inP = step(0.0, pu.x) * step(pu.x, 1.0) * step(0.0, pu.y) * step(pu.y, 1.0);
          float eP = inP * smoothstep(0.0, 0.06, min(min(pu.x, 1.0 - pu.x), min(pu.y, 1.0 - pu.y)));
          vec4 mP = texture2D(tPark, vec2(pu.x, 1.0 - pu.y)) * vec4(1.275, 1.275, 1.275, 1.0);
          vec4 macro = mix(mW, mP, eP);
          float gm = smoothstep(0.6, 0.9, macro.a);
          float dm = smoothstep(0.18, 0.4, macro.a) * (1.0 - gm);
          vec3 gr1 = texture2D(tGrass, wp / 3.1).rgb;
          vec3 gr2 = texture2D(tGrass, wp / 41.0 + 0.37).rgb;
          vec3 grassC = gr1 * mix(vec3(1.0), gr2 * 1.9, 0.45);
          // higher up the grass gets thinner and cooler
          grassC *= mix(vec3(1.0), vec3(0.8, 0.86, 0.82), smoothstep(80.0, 320.0, vWPos.y));
          vec3 gravC = texture2D(tGravel, wp / 2.3).rgb;
          vec3 col = mix(grassC, gravC, gm);
          col = mix(col, gravC * vec3(0.82, 0.66, 0.5), dm);
          col *= macro.rgb;
          // rock on steep slopes and high crests (tri-planar so cliffs do not stretch)
          vec3 an = abs(vWN);
          vec3 tw = an / (an.x + an.y + an.z);
          vec3 rk = texture2D(tRock, vec2(-vWPos.z, vWPos.y) / 7.0).rgb * tw.x + texture2D(tRock, vWPos.xz / 7.0).rgb * tw.y + texture2D(tRock, vWPos.xy / 7.0).rgb * tw.z;
          float rockK = clamp(smoothstep(0.24, 0.46, 1.0 - vWN.y) + smoothstep(380.0, 600.0, vWPos.y) * 0.45, 0.0, 1.0) * (1.0 - eP);
          col = mix(col, rk, rockK);
          diffuseColor.rgb *= col;
        `)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness - gm * 0.05 - rockK * 0.08;')
        .replace('#include <normal_fragment_maps>', `
          vec3 nG = texture2D(tGrassN, wp / 3.1).xyz * 2.0 - 1.0;
          vec3 nV = texture2D(tGravelN, wp / 2.3).xyz * 2.0 - 1.0;
          vec3 tn = normalize(mix(nG, nV, max(gm, dm)));
          // perturb the geometric normal in world space (terrain tangent frame is world x / -z)
          vec3 base = normalize(vWN);
          vec3 tx = normalize(vec3(1.0, 0.0, 0.0) - base * base.x);
          vec3 tz = cross(tx, base);
          vec3 nW = normalize(base * tn.z + (tx * tn.x - tz * tn.y) * (0.9 - rockK * 0.4));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        `);
    };
    return this.track(mat);
  }

  buildTerrain() {
    const HF = this.Wd.HF;
    this.terrainMat = this.terrainMaterial();
    const C = 130;
    this.CC = C;
    this.nCh = Math.round((HF.nx - 1) / C);
    this.chunks = [];
    this.geoCache = new Map();
    this.lodSteps = [1, 2, 5, 10];
    for (let cj = 0; cj < this.nCh; cj++) for (let ci = 0; ci < this.nCh; ci++) {
      const x0 = HF.x0 + ci * C * HF.res, y0 = HF.y0 + cj * C * HF.res;
      const ch = { ci, cj, x0, y0, x1: x0 + C * HF.res, y1: y0 + C * HF.res, lod: -1, mesh: null };
      ch.mesh = new THREE.Mesh(this.chunkGeo(ci, cj, 3), this.terrainMat);
      ch.lod = 3;
      ch.mesh.receiveShadow = true;
      ch.mesh.castShadow = false;
      this.group.add(ch.mesh);
      this.chunks.push(ch);
    }
  }

  chunkGeo(ci, cj, lod) {
    const key = `${ci},${cj},${lod}`;
    const hit = this.geoCache.get(key);
    if (hit) { hit.used = performance.now(); return hit.g; }
    const HF = this.Wd.HF, H = HF.h, nx = HF.nx, res = HF.res;
    const step = this.lodSteps[lod], C = this.CC, n = C / step;
    const i0 = ci * C, j0 = cj * C;
    const nv = (n + 1) * (n + 1), nSk = 4 * (n + 1);
    const pos = new Float32Array((nv + nSk) * 3), nor = new Float32Array((nv + nSk) * 3);
    const hAt = (i, j) => H[Math.min(HF.ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
    for (let b = 0; b <= n; b++) for (let a = 0; a <= n; a++) {
      const i = i0 + a * step, j = j0 + b * step, v = b * (n + 1) + a;
      pos[v * 3] = HF.x0 + i * res; pos[v * 3 + 1] = hAt(i, j); pos[v * 3 + 2] = -(HF.y0 + j * res);
      const dx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * res), dy = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * res);
      const l = Math.hypot(dx, 1, dy);
      nor[v * 3] = -dx / l; nor[v * 3 + 1] = 1 / l; nor[v * 3 + 2] = dy / l;
    }
    const idx = [];
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
      const v00 = b * (n + 1) + a, v10 = v00 + 1, v01 = v00 + n + 1, v11 = v01 + 1;
      idx.push(v00, v10, v01, v10, v11, v01);
    }
    // skirts hide the cracks between neighbouring chunks at different detail
    let s = nv;
    const edges = [[...Array(n + 1).keys()].map((a) => a), [...Array(n + 1).keys()].map((a) => n * (n + 1) + a), [...Array(n + 1).keys()].map((b) => b * (n + 1)), [...Array(n + 1).keys()].map((b) => b * (n + 1) + n)];
    for (const e of edges) {
      const base = s;
      for (const v of e) { pos[s * 3] = pos[v * 3]; pos[s * 3 + 1] = pos[v * 3 + 1] - 8; pos[s * 3 + 2] = pos[v * 3 + 2]; nor[s * 3] = nor[v * 3]; nor[s * 3 + 1] = nor[v * 3 + 1]; nor[s * 3 + 2] = nor[v * 3 + 2]; s++; }
      for (let k = 0; k < e.length - 1; k++) { const a = e[k], b = e[k + 1], c = base + k, d = base + k + 1; idx.push(a, c, b, b, c, d, a, b, c, b, d, c); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(nv + nSk > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    this.geoCache.set(key, { g, used: performance.now(), lod });
    return g;
  }

  updateTerrain(cx, cy, budget = 2) {
    const near = this.q === 'low' ? [260, 800, 1800] : [420, 1100, 2300];
    const want = [];
    for (const ch of this.chunks) {
      const dx = Math.max(ch.x0 - cx, 0, cx - ch.x1), dy = Math.max(ch.y0 - cy, 0, cy - ch.y1);
      const d = Math.hypot(dx, dy);
      const lod = d < near[0] ? 0 : d < near[1] ? 1 : d < near[2] ? 2 : 3;
      if (lod !== ch.lod) want.push([d, ch, lod]);
    }
    want.sort((a, b) => a[0] - b[0]);
    let built = 0, pending = false;
    for (const [, ch, lod] of want) {
      const key = `${ch.ci},${ch.cj},${lod}`;
      if (!this.geoCache.has(key)) { if (built >= budget && lod <= 1) { pending = true; continue; } built++; }
      ch.mesh.geometry = this.chunkGeo(ch.ci, ch.cj, lod);
      ch.lod = lod;
    }
    // drop detailed geometry nobody uses
    if (this.geoCache.size > 160) {
      const inUse = new Set(this.chunks.map((c) => `${c.ci},${c.cj},${c.lod}`));
      const old = [...this.geoCache.entries()].filter(([k, v]) => !inUse.has(k) && v.lod <= 1).sort((a, b) => a[1].used - b[1].used);
      for (const [k, v] of old.slice(0, old.length - 20)) { v.g.dispose(); this.geoCache.delete(k); }
    }
    return pending;
  }

  // ---------------------------------------------------------------- lake
  buildWater() {
    const L = this.Wd.lake;
    const nm = TX.waterNormal(256); this.track(nm);
    nm.repeat.set(60, 60);
    this.waterNormal = nm;
    const mat = this.track(new THREE.MeshStandardMaterial({ color: '#1b3f48', roughness: 0.05, metalness: 0.1, normalMap: nm, normalScale: new THREE.Vector2(0.3, 0.3), transparent: true, opacity: 0.9, envMapIntensity: 1.25 }));
    const g = this.track(new THREE.CircleGeometry(1, 96)); g.rotateX(-Math.PI / 2);
    const w = new THREE.Mesh(g, mat);
    w.scale.set(L.rx * 1.55, 1, L.ry * 1.55);
    w.position.set(L.x, L.level, -L.y);
    w.receiveShadow = true;
    w.renderOrder = 2;
    this.group.add(w);
    this.water = w;
  }

  // ---------------------------------------------------------------- roads
  roadMaterial(type) {
    const M = MARKS[type];
    const half = (ROAD_TYPES[type] || ROAD_TYPES.highway).half;
    const tex = this.track(TX.roadMarkTexture(half, M ? M.lines : [], (x, W, H, U) => {
      if (M && M.median) { x.fillStyle = 'rgba(150,148,140,1)'; x.fillRect(U(-M.median), 0, U(M.median) - U(-M.median), H); }
    }));
    const A = this.asphalt;
    const mat = new THREE.MeshStandardMaterial({ map: A.map, normalMap: A.normalMap, roughnessMap: A.roughnessMap, normalScale: new THREE.Vector2(0.7, 0.7), vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.tMark = { value: tex };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aMark; varying vec2 vMark;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvMark = aMark;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tMark; varying vec2 vMark;')
        .replace('#include <map_fragment>', '#include <map_fragment>\nvec4 mk = texture2D(tMark, vMark);\ndiffuseColor.rgb = mix(diffuseColor.rgb, mk.rgb, mk.a);')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.6, mk.a);');
    };
    mat.customProgramCacheKey = () => 'pakswap-road';
    return this.track(mat);
  }

  buildRoads() {
    const Wd = this.Wd, HF = Wd.HF;
    const mats = {};
    const R = rng(3);
    const byMat = new Map();
    const get = (key) => { if (!byMat.has(key)) byMat.set(key, { p: [], n: [], uv: [], m: [], c: [], idx: [] }); return byMat.get(key); };
    for (const rd of Wd.roads) {
      const t = rd.typeName;
      if (t === 'dirt') continue;
      const markType = rd.type.mark;
      const key = markType;
      if (!mats[key]) mats[key] = this.roadMaterial(markType);
      const B = get(key);
      const rb = rd.rb, n = rb.n, half = rd.type.half;
      const offs = [-half, -half * 0.55, 0, half * 0.55, half];
      const rows = rd.closed ? n + 1 : n;
      const base = B.p.length / 3;
      const tint = t === 'motorway' ? 0.92 : t === 'mountain' ? 1.0 : t === 'street' ? 1.12 : 1.04;
      for (let k = 0; k < rows; k++) {
        const i = k % n;
        const nx = -rb.ty[i], ny = rb.tx[i];
        const patch = 0.96 + R() * 0.08;
        for (const o of offs) {
          const x = rb.x[i] + nx * o, y = rb.y[i] + ny * o;
          B.p.push(x, HF.heightAt(x, y) + 0.06, -y);
          B.n.push(0, 1, 0);
          B.uv.push(x / 4, y / 4);
          B.m.push((o + half) / (2 * half), (k * rb.ds) / 12);
          const edge = Math.abs(o) / half;
          const v = tint * patch * (1 + edge * edge * 0.08);
          B.c.push(v, v, v);
        }
      }
      const w = offs.length;
      for (let k = 0; k < rows - 1; k++) for (let j = 0; j < w - 1; j++) {
        const a = base + k * w + j, b = a + 1, c = a + w + 1, d = a + w;
        B.idx.push(a, d, c, a, c, b);
      }
    }
    for (const [key, B] of byMat) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(B.n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
      g.setAttribute('aMark', new THREE.Float32BufferAttribute(B.m, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(B.c, 3));
      g.setIndex(B.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(B.idx, 1) : new THREE.Uint16BufferAttribute(B.idx, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const m = new THREE.Mesh(this.track(g), mats[key]);
      m.receiveShadow = true;
      this.group.add(m);
    }
    // dirt tracks: soft edged ribbons of packed earth
    {
      const gravel = TX.gravelTextures(512); this.track(gravel.map); this.track(gravel.normalMap);
      const mat = new THREE.MeshStandardMaterial({ map: gravel.map, normalMap: gravel.normalMap, color: '#b49478', roughness: 0.95, transparent: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
      mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aMark; varying vec2 vMark;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvMark = aMark;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vMark;')
          .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= smoothstep(0.0, 0.22, vMark.x) * smoothstep(1.0, 0.78, vMark.x);');
      };
      this.track(mat);
      for (const rd of Wd.roads.filter((r) => r.typeName === 'dirt')) {
        const rb = rd.rb, half = rd.type.half + 0.8, offs = [-half, -half * 0.4, half * 0.4, half];
        const p = [], uv = [], mk = [], idx = [];
        for (let i = 0; i < rb.n; i++) {
          const nx = -rb.ty[i], ny = rb.tx[i];
          for (const o of offs) { const x = rb.x[i] + nx * o, y = rb.y[i] + ny * o; p.push(x, HF.heightAt(x, y) + 0.04, -y); uv.push(x / 2.3, y / 2.3); mk.push((o + half) / (2 * half), 0); }
        }
        for (let k = 0; k < rb.n - 1; k++) for (let j = 0; j < 3; j++) { const a = k * 4 + j, b = a + 1, c = a + 5, d = a + 4; idx.push(a, d, c, a, c, b); }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('aMark', new THREE.Float32BufferAttribute(mk, 2));
        g.setIndex(idx); g.computeVertexNormals();
        const m = new THREE.Mesh(this.track(g), mat); m.receiveShadow = true; m.renderOrder = 1; this.group.add(m);
      }
    }
    // gravel shoulders along country roads, feathered into the grass
    {
      const gravel = TX.gravelTextures(512); this.track(gravel.map); this.track(gravel.normalMap);
      const mat = new THREE.MeshStandardMaterial({ map: gravel.map, normalMap: gravel.normalMap, color: '#a89a86', roughness: 0.95, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
      mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aMark; varying vec2 vMark;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvMark = aMark;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vMark;')
          .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= smoothstep(1.0, 0.5, vMark.x);');
      };
      mat.customProgramCacheKey = () => 'pakswap-shoulder';
      this.track(mat);
      const p = [], uv = [], mk = [], idx = [];
      for (const rd of Wd.roads) {
        if (!['highway', 'gt', 'mountain', 'motorway'].includes(rd.typeName)) continue;
        const rb = rd.rb, half = rd.type.half, w = rd.typeName === 'motorway' ? 1.4 : 1.9;
        for (const side of [1, -1]) {
          const base = p.length / 3;
          for (let i = 0; i < rb.n; i++) {
            const nx = -rb.ty[i], ny = rb.tx[i];
            for (const [o, u] of [[half - 0.1, 0], [half + w * 0.5, 0.5], [half + w, 1]]) {
              const x = rb.x[i] + nx * o * side, y = rb.y[i] + ny * o * side;
              p.push(x, HF.heightAt(x, y) + 0.045, -y); uv.push(x / 2.3, y / 2.3); mk.push(u, 0);
            }
          }
          for (let k = 0; k < rb.n - 1; k++) for (let j = 0; j < 2; j++) {
            const a = base + k * 3 + j, b = a + 1, c = a + 4, d = a + 3;
            if (side > 0) idx.push(a, d, c, a, c, b); else idx.push(a, c, d, a, b, c);
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('aMark', new THREE.Float32BufferAttribute(mk, 2));
      g.setIndex(p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
      g.computeVertexNormals();
      const m = new THREE.Mesh(this.track(g), mat); m.receiveShadow = true; m.renderOrder = 1; this.group.add(m);
    }
    // junction patches (plain tarmac over the paint) and zebra crossings in the city
    {
      const A = this.asphalt;
      const mat = this.track(new THREE.MeshStandardMaterial({ map: A.map, normalMap: A.normalMap, roughnessMap: A.roughnessMap, normalScale: new THREE.Vector2(0.7, 0.7), roughness: 1, color: '#f0f0f0', polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }));
      const gb = new GB();
      const zb = new GB();
      for (const j of Wd.junctions) {
        if (j.a === 'GT' && j.b === 'MURREE') continue;
        const seg = 28, r = j.cross ? j.r + 0.6 : j.r * 0.9;
        const c0 = [j.x, HF.heightAt(j.x, j.y) + 0.075, -j.y];
        for (let k = 0; k < seg; k++) {
          const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
          const p = (a) => { const x = j.x + Math.cos(a) * r, y = j.y + Math.sin(a) * r; return [x, HF.heightAt(x, y) + 0.075, -y]; };
          const p0 = p(a0), p1 = p(a1);
          const ids = [gb.v(...c0, 0, 1, 0, j.x / 4, j.y / 4), gb.v(...p0, 0, 1, 0, p0[0] / 4, -p0[2] / 4), gb.v(...p1, 0, 1, 0, p1[0] / 4, -p1[2] / 4)];
          gb.idx.push(ids[0], ids[1], ids[2]);
        }
        if (j.cross) {
          // zebra stripes on all four approaches
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const isMainX = j.x === 1600, isMainY = j.y === -1800;
            const roadHalf = (dx !== 0 ? (isMainY ? 8.5 : 4.8) : (isMainX ? 8.5 : 4.8));
            const dist = (dx !== 0 ? (isMainX ? 8.5 : 4.8) : (isMainY ? 8.5 : 4.8)) + 2.6;
            for (let s = -roadHalf + 0.5; s < roadHalf - 0.4; s += 1.0) {
              const cx = j.x + dx * dist, cy = j.y + dy * dist;
              const ax = dx !== 0 ? 0 : 1, ay = dx !== 0 ? 1 : 0; // across the approach road
              const ux = dx, uy = dy; // along the approach
              const q = [[s, -1.5], [s + 0.5, -1.5], [s + 0.5, 1.5], [s, 1.5]].map(([a, b]) => { const x = cx + ax * a + ux * b, y = cy + ay * a + uy * b; return [x, HF.heightAt(x, y) + 0.085, -y]; });
              zb.quad(q, [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
            }
          }
        }
      }
      const jm = new THREE.Mesh(this.track(gb.build()), mat); jm.receiveShadow = true; this.group.add(jm);
      const zm = new THREE.Mesh(this.track(zb.build()), this.matPaint); zm.receiveShadow = true; this.group.add(zm);
    }
    // service pads: concrete aprons
    {
      const gb = new GB();
      for (const p of Wd.pads) {
        if (p.kind === 'dhaba') continue;
        const r = p.rect, h = p.h + 0.07;
        gb.quad([[r.x0, h, -r.y0], [r.x1, h, -r.y0], [r.x1, h, -r.y1], [r.x0, h, -r.y1]], [0, 1, 0], [[r.x0 / 5, r.y0 / 5], [r.x1 / 5, r.y0 / 5], [r.x1 / 5, r.y1 / 5], [r.x0 / 5, r.y1 / 5]]);
      }
      const m = new THREE.Mesh(this.track(gb.build()), this.park.matSlab);
      m.receiveShadow = true;
      const mat2 = this.park.matSlab.clone(); mat2.polygonOffset = true; mat2.polygonOffsetFactor = -1; mat2.polygonOffsetUnits = -3; this.track(mat2);
      m.material = mat2;
      this.group.add(m);
    }
  }

  // ---------------------------------------------------------------- sidewalks with kerbs, boulevard medians
  buildSidewalks() {
    const Wd = this.Wd, HF = Wd.HF, SM = Wd.SM;
    const top = new GB(), curb = new GB(), med = new GB(), medCurb = new GB();
    const nearJ = (x, y, pad) => Wd.junctions.some((j) => Math.hypot(j.x - x, j.y - y) < j.r + pad);
    for (const rd of Wd.roads) {
      const t = rd.type;
      const rb = rd.rb, n = rb.n;
      if (t.sidewalk) {
        for (const side of [1, -1]) {
          const o0 = side * t.half, o1 = side * (t.half + t.sidewalk);
          let run = [];
          const flush = () => {
            if (run.length < 2) { run = []; return; }
            for (let k = 0; k < run.length - 1; k++) {
              const a = run[k], b = run[k + 1];
              // top
              top.quad([[a.ix, a.hi + 0.15, -a.iy], [b.ix, b.hi + 0.15, -b.iy], [b.ox, b.ho + 0.15, -b.oy], [a.ox, a.ho + 0.15, -a.oy]], [0, 1, 0], [[a.s / 2, 0], [b.s / 2, 0], [b.s / 2, t.sidewalk / 2], [a.s / 2, t.sidewalk / 2]]);
              // kerb face toward the road
              const nx = -rb.ty[a.i] * side, ny = rb.tx[a.i] * side;
              curb.quad([[a.ix, a.hi + 0.05, -a.iy], [b.ix, b.hi + 0.05, -b.iy], [b.ix, b.hi + 0.15, -b.iy], [a.ix, a.hi + 0.15, -a.iy]], [-nx, 0, ny], [[0, 0], [1, 0], [1, 1], [0, 1]]);
              curb.quad([[a.ox, a.ho - 0.2, -a.oy], [b.ox, b.ho - 0.2, -b.oy], [b.ox, b.ho + 0.15, -b.oy], [a.ox, a.ho + 0.15, -a.oy]], [nx, 0, -ny], [[0, 0], [1, 0], [1, 1], [0, 1]]);
            }
            run = [];
          };
          for (let i = 0; i < n; i++) {
            const nx = -rb.ty[i], ny = rb.tx[i];
            const ix = rb.x[i] + nx * o0, iy = rb.y[i] + ny * o0, ox = rb.x[i] + nx * o1, oy = rb.y[i] + ny * o1;
            const mx = (ix + ox) / 2, my = (iy + oy) / 2;
            const ok = SM.get(mx, my) === S_SIDEWALK && SM.get(ix + nx * side * 0.3, iy + ny * side * 0.3) === S_SIDEWALK;
            if (!ok) { flush(); continue; }
            run.push({ i, ix, iy, ox, oy, hi: HF.heightAt(ix, iy), ho: HF.heightAt(ox, oy), s: i * rb.ds });
          }
          flush();
        }
      }
      // green median down the boulevards
      if (rd.typeName === 'boulevard') {
        let run = [];
        const w = 1.0;
        const flush = () => {
          for (let k = 0; k < run.length - 1; k++) {
            const a = run[k], b = run[k + 1];
            med.quad([[a.lx, a.h + 0.2, -a.ly], [b.lx, b.h + 0.2, -b.ly], [b.rx, b.h + 0.2, -b.ry], [a.rx, a.h + 0.2, -a.ry]], [0, 1, 0], [[0, a.s / 2], [1, b.s / 2], [1, b.s / 2], [0, a.s / 2]]);
            for (const [p, q, sgn] of [['l', 'l', 1], ['r', 'r', -1]]) {
              const ax = a[p + 'x'], ay = a[p + 'y'], bx = b[q + 'x'], by = b[q + 'y'];
              const nx = -rb.ty[a.i] * sgn, ny = rb.tx[a.i] * sgn;
              medCurb.quad([[ax, a.h + 0.05, -ay], [bx, b.h + 0.05, -by], [bx, b.h + 0.2, -by], [ax, a.h + 0.2, -ay]], [nx, 0, -ny], [[0, 0], [1, 0], [1, 0.25], [0, 0.25]]);
            }
          }
          run = [];
        };
        for (let i = 0; i < n; i++) {
          const x = rb.x[i], y = rb.y[i];
          if (nearJ(x, y, 4) || Math.hypot(x - 1600, y + 1800) < 45) { flush(); continue; }
          const nx = -rb.ty[i], ny = rb.tx[i];
          run.push({ i, lx: x + nx * w, ly: y + ny * w, rx: x - nx * w, ry: y - ny * w, h: HF.heightAt(x, y), s: i * rb.ds });
        }
        flush();
      }
    }
    for (const [gb, mat] of [[top, this.matPaver], [curb, this.matCurb], [med, this.matGreen], [medCurb, this.matCurbPaint]]) {
      if (!gb.idx.length) continue;
      const m = new THREE.Mesh(this.track(gb.build()), mat); m.receiveShadow = true; m.castShadow = false; this.group.add(m);
    }
    // roundabout island: kerb ring and a lawn
    {
      const Mn = Wd.city.monument;
      const lawn = this.track(new THREE.CircleGeometry(23, 48)); lawn.rotateX(-Math.PI / 2);
      const lm = new THREE.Mesh(lawn, this.matGreen); lm.position.set(Mn.x, Mn.h + 0.22, -Mn.y); lm.receiveShadow = true; this.group.add(lm);
      const ring = this.track(new THREE.CylinderGeometry(24.4, 24.4, 0.25, 64, 1, true));
      const rm = new THREE.Mesh(ring, this.matCurbPaint); rm.position.set(Mn.x, Mn.h + 0.1, -Mn.y); this.group.add(rm);
      const rt = this.track(new THREE.RingGeometry(23, 24.4, 64)); rt.rotateX(-Math.PI / 2);
      const rtm = new THREE.Mesh(rt, this.matCurb); rtm.position.set(Mn.x, Mn.h + 0.225, -Mn.y); this.group.add(rtm);
    }
  }

  // ---------------------------------------------------------------- city blocks
  buildCity() {
    const Wd = this.Wd, C = Wd.city;
    const atlas = TX.facadeAtlas(); this.track(atlas.map); this.track(atlas.mask);
    const mat = new THREE.MeshStandardMaterial({ map: atlas.map, roughness: 0.85, vertexColors: true, emissive: '#ffffff', emissiveIntensity: 1 });
    const uNight = this.uNight;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.tMask = { value: atlas.mask }; sh.uniforms.uCellH = { value: atlas.cellH }; sh.uniforms.uNight = uNight;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aFac; varying vec3 vFac; varying vec2 vFUv;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvFac = aFac; vFUv = uv;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        uniform sampler2D tMask; uniform float uCellH; uniform float uNight; varying vec3 vFac; varying vec2 vFUv;
        float hsh(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`)
        .replace('#include <map_fragment>', `
          float fl = floor(vFUv.y);
          float row = (vFac.y > 0.5 && fl < 0.5) ? 1.0 : 0.0;
          vec2 cell = fract(vFUv);
          vec2 auv = vec2((vFac.x + cell.x) / 4.0, row > 0.5 ? cell.y * uCellH : 1.0 - uCellH + cell.y * uCellH);
          vec2 gx = dFdx(vFUv) * vec2(0.25, uCellH), gy = dFdy(vFUv) * vec2(0.25, uCellH);
          vec4 fcol = textureGrad(map, auv, gx, gy);
          diffuseColor *= fcol;
          float lit = step(0.42, hsh(vec3(floor(vFUv), vFac.z))) * (row > 0.5 ? 1.0 : 0.85);
          vec3 glow = textureGrad(tMask, auv, gx, gy).r * lit * uNight * vec3(1.0, 0.78, 0.5) * 1.7;
        `)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = glow;');
    };
    mat.customProgramCacheKey = () => 'pakswap-facade';
    this.track(mat);
    const p = [], nrm = [], uv = [], fac = [], col = [], idx = [];
    const tints = [[1, 1, 1], [0.95, 0.9, 0.84], [1.04, 1.0, 0.92], [0.9, 0.94, 0.98], [1.0, 0.92, 0.9], [0.86, 0.86, 0.84]];
    const roof = new GB(), signs = new GB();
    const names = ['AL-MADINA TRADERS', 'KARACHI BIRYANI HOUSE', 'BISMILLAH AUTO PARTS', 'MOBILE ZONE', 'CHAI POINT', 'NEW STAR TAILORS', 'FAZAL MEDICAL STORE', 'LAHORE SWEETS & BAKERS', 'SHAHEEN ELECTRONICS', 'MASHALLAH CLOTH HOUSE', 'PUNJAB HARDWARE', 'GHOUSIA HOTEL', 'ROYAL OPTICS', 'CITY GENERAL STORE', 'HAMZA TYRE SHOP', 'NOOR JEWELLERS', 'KHAN BROTHERS', 'AL-REHMAN PHARMACY', 'PAK FAN HOUSE', 'TAJ PHOTO STUDIO', 'DATA DARBAR KABAB', 'SABRI NIHARI'];
    const signAtlas = TX.shopSignAtlas(names); this.track(signAtlas.tex);
    const wall = (ax, ay, bx, by, h0, h1, nx, ny, front, variant, id, tint) => {
      const len = Math.hypot(bx - ax, by - ay);
      const base = p.length / 3;
      const bays = Math.max(1, Math.round(len / 4));
      const pts = [[ax, h0, -ay], [bx, h0, -by], [bx, h1, -by], [ax, h1, -ay]];
      const uvs = [[0, 0], [bays, 0], [bays, (h1 - h0) / 3.2], [0, (h1 - h0) / 3.2]];
      for (let k = 0; k < 4; k++) { p.push(...pts[k]); nrm.push(nx, 0, -ny); uv.push(...uvs[k]); fac.push(variant, front ? 1 : 0, id); col.push(...tint); }
      // winding: outward normal (nx, ny) in 2D
      const e1 = [bx - ax, 0, -(by - ay)], e2 = [0, 1, 0];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (cr[0] * nx + cr[2] * -ny >= 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    let id = 0;
    for (const b of C.buildings) {
      const h0 = b.h - 0.3, h1 = b.h + b.floors * 3.2;
      const tint = tints[b.tint % tints.length];
      const faces = { S: [b.x0, b.y0, b.x1, b.y0, 0, -1], N: [b.x1, b.y1, b.x0, b.y1, 0, 1], W: [b.x0, b.y1, b.x0, b.y0, -1, 0], E: [b.x1, b.y0, b.x1, b.y1, 1, 0] };
      for (const [k, f] of Object.entries(faces)) wall(f[0], f[1], f[2], f[3], h0, h1, f[4], f[5], k === b.face, b.variant, id, tint);
      // flat roof and a parapet
      roof.quad([[b.x0, h1, -b.y0], [b.x1, h1, -b.y0], [b.x1, h1, -b.y1], [b.x0, h1, -b.y1]], [0, 1, 0], [[b.x0 / 4, b.y0 / 4], [b.x1 / 4, b.y0 / 4], [b.x1 / 4, b.y1 / 4], [b.x0 / 4, b.y1 / 4]]);
      for (const f of Object.values(faces)) {
        const [ax, ay, bx, by, nx, ny] = f;
        roof.quad([[ax, h1, -ay], [bx, h1, -by], [bx, h1 + 0.9, -by], [ax, h1 + 0.9, -ay]], [nx, 0, -ny], [[0, 0], [1, 0], [1, 0.2], [0, 0.2]]);
        roof.quad([[ax - nx * 0.2, h1, -(ay - ny * 0.2)], [bx - nx * 0.2, h1, -(by - ny * 0.2)], [bx - nx * 0.2, h1 + 0.9, -(by - ny * 0.2)], [ax - nx * 0.2, h1 + 0.9, -(ay - ny * 0.2)]], [-nx, 0, ny], [[0, 0], [1, 0], [1, 0.2], [0, 0.2]]);
      }
      // shop sign over the street front
      const f = faces[b.face];
      const len = Math.hypot(f[2] - f[0], f[3] - f[1]);
      if (len > 5) {
        const ux = (f[2] - f[0]) / len, uy = (f[3] - f[1]) / len, nx = f[4], ny = f[5];
        const w = Math.min(len - 1, 9), cx = (f[0] + f[2]) / 2 + nx * 0.06, cy = (f[1] + f[3]) / 2 + ny * 0.06;
        const [u0, v0, u1, v1] = signAtlas.uv(b.shop % names.length);
        const y0 = b.h + 2.55, y1 = b.h + 3.35;
        signs.quad([[cx - ux * w / 2, y0, -(cy - uy * w / 2)], [cx + ux * w / 2, y0, -(cy + uy * w / 2)], [cx + ux * w / 2, y1, -(cy + uy * w / 2)], [cx - ux * w / 2, y1, -(cy - uy * w / 2)]], [nx, 0, -ny], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
      }
      id++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aFac', new THREE.Float32BufferAttribute(fac, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const bm = new THREE.Mesh(this.track(g), mat); bm.castShadow = true; bm.receiveShadow = true; this.group.add(bm);
    const rm = new THREE.Mesh(this.track(roof.build()), this.matConcrete); rm.castShadow = true; rm.receiveShadow = true; this.group.add(rm);
    const signMat = this.track(new THREE.MeshStandardMaterial({ map: signAtlas.tex, emissive: '#ffffff', emissiveMap: signAtlas.tex, emissiveIntensity: 0, roughness: 0.45, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    this.signMat = signMat;
    const sm = new THREE.Mesh(this.track(signs.build()), signMat); this.group.add(sm);
    // black water tanks on the roofs
    const tg = this.track(new THREE.CylinderGeometry(0.62, 0.62, 1.15, 12)); tg.translate(0, 0.575, 0);
    const tanks = new THREE.InstancedMesh(tg, this.matBlack, C.tanks.length);
    const M = new THREE.Matrix4();
    C.tanks.forEach((t, i) => { M.makeTranslation(t.x, t.h, -t.y); tanks.setMatrixAt(i, M); });
    tanks.castShadow = true; this.group.add(tanks);
    // glass tower on the boulevard
    {
      const T = C.tower, h = T.floors * 3.6;
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256;
      const x = cv.getContext('2d');
      x.fillStyle = '#26394a'; x.fillRect(0, 0, 256, 256);
      const gr = x.createLinearGradient(0, 0, 256, 256); gr.addColorStop(0, 'rgba(160,190,220,0.35)'); gr.addColorStop(1, 'rgba(20,30,40,0.1)');
      x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
      x.strokeStyle = '#9aa3ad'; x.lineWidth = 6; x.strokeRect(0, 0, 256, 256); x.lineWidth = 3; x.beginPath(); x.moveTo(128, 0); x.lineTo(128, 256); x.stroke();
      const tt = new THREE.CanvasTexture(cv); tt.colorSpace = THREE.SRGBColorSpace; tt.wrapS = tt.wrapT = THREE.RepeatWrapping; this.track(tt);
      // offices lit here and there at night: an 8 x 8 bay pattern laid over the repeating glass
      const ce = document.createElement('canvas'); ce.width = 256; ce.height = 256;
      const xe = ce.getContext('2d');
      xe.fillStyle = '#000'; xe.fillRect(0, 0, 256, 256);
      let sd = 99;
      const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
      for (let by = 0; by < 8; by++) for (let bx = 0; bx < 8; bx++) {
        if (rnd() > 0.34) continue;
        const warm = rnd() < 0.75;
        const g2 = xe.createLinearGradient(0, by * 32, 0, by * 32 + 32);
        g2.addColorStop(0, warm ? 'rgba(255,214,150,0.95)' : 'rgba(205,225,255,0.9)'); g2.addColorStop(1, warm ? 'rgba(200,150,90,0.6)' : 'rgba(150,175,210,0.55)');
        xe.fillStyle = g2; xe.fillRect(bx * 32 + 2, by * 32 + 3, 28, 26);
        xe.fillStyle = '#000'; xe.fillRect(bx * 32 + 15, by * 32, 2, 32);
      }
      const te = new THREE.CanvasTexture(ce); te.colorSpace = THREE.SRGBColorSpace; te.wrapS = te.wrapT = THREE.RepeatWrapping; te.repeat.set(1 / 8, 1 / 8); this.track(te);
      const tm = this.track(new THREE.MeshStandardMaterial({ map: tt, roughness: 0.12, metalness: 0.65, envMapIntensity: 1.4, emissive: '#ffffff', emissiveMap: te, emissiveIntensity: 0 }));
      this.towerMat = tm;
      const bg = this.track(new THREE.BoxGeometry(T.x1 - T.x0, h, T.y1 - T.y0));
      const uvA = bg.getAttribute('uv');
      for (let i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) * ((T.x1 - T.x0) / 3.6), uvA.getY(i) * T.floors);
      const tower = new THREE.Mesh(bg, tm);
      tower.position.set((T.x0 + T.x1) / 2, T.h + h / 2, -(T.y0 + T.y1) / 2);
      tower.castShadow = true; tower.receiveShadow = true; this.group.add(tower);
      const crown = new THREE.Mesh(this.track(new THREE.BoxGeometry(T.x1 - T.x0 - 4, 3, T.y1 - T.y0 - 4)), this.matConcrete);
      crown.position.set((T.x0 + T.x1) / 2, T.h + h + 1.5, -(T.y0 + T.y1) / 2); crown.castShadow = true; this.group.add(crown);
    }
    this.buildMosque(C.mosque, 1.0, 2);
    this.buildMonument(C.monument);
  }

  buildMosque(m, scale, minarets) {
    const grp = new THREE.Group();
    const white = this.matWhite;
    const green = this.track(new THREE.MeshStandardMaterial({ color: '#2f7d53', roughness: 0.45, metalness: 0.2 }));
    const S = scale;
    const hall = new THREE.Mesh(this.track(new THREE.BoxGeometry(16 * S, 7 * S, 14 * S)), white); hall.position.y = 3.5 * S; grp.add(hall);
    const drum = new THREE.Mesh(this.track(new THREE.CylinderGeometry(4.2 * S, 4.2 * S, 1.6 * S, 24)), white); drum.position.y = 7.8 * S; grp.add(drum);
    const dome = new THREE.Mesh(this.track(new THREE.SphereGeometry(4.3 * S, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2)), green); dome.position.y = 8.6 * S; dome.scale.y = 1.25; grp.add(dome);
    const fin = new THREE.Mesh(this.track(new THREE.ConeGeometry(0.25 * S, 1.6 * S, 8)), this.matMetal); fin.position.y = 14.8 * S; grp.add(fin);
    for (let k = 0; k < minarets; k++) {
      const x = (k === 0 ? 1 : -1) * 9.5 * S;
      const mn = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.85 * S, 1.05 * S, 20 * S, 12)), white); mn.position.set(x, 10 * S, 6.5 * S); grp.add(mn);
      const bal = new THREE.Mesh(this.track(new THREE.CylinderGeometry(1.5 * S, 1.5 * S, 0.5 * S, 12)), white); bal.position.set(x, 15 * S, 6.5 * S); grp.add(bal);
      const cap = new THREE.Mesh(this.track(new THREE.SphereGeometry(1.0 * S, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)), green); cap.position.set(x, 20 * S, 6.5 * S); cap.scale.y = 1.4; grp.add(cap);
    }
    grp.position.set(m.x, m.h - 0.2, -m.y);
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(grp);
  }

  buildMonument(m) {
    const grp = new THREE.Group();
    const stone = this.track(new THREE.MeshStandardMaterial({ color: '#d8d2c4', roughness: 0.7 }));
    const steps = [[14, 1.2], [11, 1.2], [8, 1.4]];
    let y = 0;
    for (const [w, h] of steps) { const b = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, h, w)), stone); b.position.y = y + h / 2; y += h; grp.add(b); }
    const shaft = new THREE.Mesh(this.track(new THREE.CylinderGeometry(1.6, 3.2, 26, 4)), stone); shaft.rotation.y = Math.PI / 4; shaft.position.y = y + 13; grp.add(shaft);
    const top = new THREE.Mesh(this.track(new THREE.ConeGeometry(2.1, 4, 4)), stone); top.rotation.y = Math.PI / 4; top.position.y = y + 28; grp.add(top);
    grp.position.set(m.x, m.h + 0.2, -m.y);
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(grp);
  }

  // ---------------------------------------------------------------- village
  buildVillage() {
    const V = this.Wd.village;
    const gb = new GB(), roofs = new GB(), doors = new GB(), walls = new GB();
    const R = rng(12);
    for (const h of V.houses) {
      const x0 = h.x - h.w / 2, x1 = h.x + h.w / 2, y0 = h.y - h.d / 2, y1 = h.y + h.d / 2;
      const b = h.h - 0.4, t = h.h + h.floors * 3;
      const faces = [[x0, y0, x1, y0, 0, -1], [x1, y1, x0, y1, 0, 1], [x0, y1, x0, y0, -1, 0], [x1, y0, x1, y1, 1, 0]];
      for (const [ax, ay, bx, by, nx, ny] of faces) {
        const len = Math.hypot(bx - ax, by - ay);
        gb.quad([[ax, b, -ay], [bx, b, -by], [bx, t, -by], [ax, t, -ay]], [nx, 0, -ny], [[0, 0], [len / 2, 0], [len / 2, (t - b) / 2], [0, (t - b) / 2]]);
        gb.quad([[ax, t, -ay], [bx, t, -by], [bx, t + 0.5, -by], [ax, t + 0.5, -ay]], [nx, 0, -ny], [[0, 0], [len / 2, 0], [len / 2, 0.25], [0, 0.25]]);
      }
      roofs.quad([[x0, t + 0.02, -y0], [x1, t + 0.02, -y0], [x1, t + 0.02, -y1], [x0, t + 0.02, -y1]], [0, 1, 0], [[0, 0], [h.w / 2, 0], [h.w / 2, h.d / 2], [0, h.d / 2]]);
      // a wooden door and a small window on the south side
      const dx = h.x + (R() - 0.5) * (h.w - 3);
      doors.quad([[dx - 0.6, b + 0.4, -(y0 - 0.03)], [dx + 0.6, b + 0.4, -(y0 - 0.03)], [dx + 0.6, b + 2.6, -(y0 - 0.03)], [dx - 0.6, b + 2.6, -(y0 - 0.03)]], [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      const wx = dx + (dx < h.x ? 2.2 : -2.2);
      doors.quad([[wx - 0.45, b + 1.5, -(y0 - 0.03)], [wx + 0.45, b + 1.5, -(y0 - 0.03)], [wx + 0.45, b + 2.3, -(y0 - 0.03)], [wx - 0.45, b + 2.3, -(y0 - 0.03)]], [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    for (const w of V.walls) {
      const h0 = this.Wd.HF.heightAt(w.ax, w.ay) - 0.3, h1 = h0 + 2.1;
      const len = Math.hypot(w.bx - w.ax, w.by - w.ay), nx = -(w.by - w.ay) / len, ny = (w.bx - w.ax) / len, t = 0.15;
      for (const s of [1, -1]) walls.quad([[w.ax + nx * t * s, h0, -(w.ay + ny * t * s)], [w.bx + nx * t * s, h0, -(w.by + ny * t * s)], [w.bx + nx * t * s, h1, -(w.by + ny * t * s)], [w.ax + nx * t * s, h1, -(w.ay + ny * t * s)]], [nx * s, 0, -ny * s], [[0, 0], [len / 2, 0], [len / 2, 1], [0, 1]]);
      walls.quad([[w.ax + nx * t, h1, -(w.ay + ny * t)], [w.bx + nx * t, h1, -(w.by + ny * t)], [w.bx - nx * t, h1, -(w.by - ny * t)], [w.ax - nx * t, h1, -(w.ay - ny * t)]], [0, 1, 0], [[0, 0], [len / 2, 0], [len / 2, 0.1], [0, 0.1]]);
    }
    const doorMat = this.track(new THREE.MeshStandardMaterial({ color: '#4a3424', roughness: 0.8 }));
    const roofMat = this.track(new THREE.MeshStandardMaterial({ map: this.matMud.map, color: '#c8b8a0', roughness: 1 }));
    for (const [g, m] of [[gb, this.matMud], [roofs, roofMat], [doors, doorMat], [walls, this.matMud]]) {
      if (!g.idx.length) continue;
      const mesh = new THREE.Mesh(this.track(g.build()), m); mesh.castShadow = true; mesh.receiveShadow = true; this.group.add(mesh);
    }
    if (V.mosque) this.buildMosque(V.mosque, 0.55, 1);
  }

  // ---------------------------------------------------------------- motorway furniture, toll plaza, service area, dhaba, viewpoint
  extrude(pts, profile, mat, opts = {}) {
    // pts: [x, y, h]; profile: [[across, up]] in metres (across = left of travel)
    const p = [], idx = [];
    const n = pts.length, m = profile.length;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L, ny = dx / L;
      const hBase = opts.hAt ? opts.hAt(pts[i][0], pts[i][1]) : pts[i][2];
      for (const [o, u] of profile) p.push(pts[i][0] + nx * o, hBase + u, -(pts[i][1] + ny * o));
    }
    for (let i = 0; i < n - 1; i++) for (let k = 0; k < m - 1; k++) {
      const a = i * m + k, b = a + 1, c = a + m + 1, d = a + m;
      idx.push(a, b, c, a, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const mesh = new THREE.Mesh(this.track(g), mat);
    mesh.castShadow = !!opts.cast; mesh.receiveShadow = true;
    if (opts.double) { mesh.material = mat.clone(); mesh.material.side = THREE.DoubleSide; this.track(mesh.material); }
    this.group.add(mesh);
    return mesh;
  }

  buildRoadside() {
    const Wd = this.Wd, HF = Wd.HF, P = Wd.props;
    // New Jersey barrier down the motorway median
    const nj = [[-0.3, 0], [-0.18, 0.08], [-0.08, 0.82], [0.08, 0.82], [0.18, 0.08], [0.3, 0]];
    for (const m of P.medians) this.extrude(m.pts, nj, this.matConcrete, { cast: true, hAt: (x, y) => HF.heightAt(x, y) + 0.05 });
    // W-beam guard rails with posts
    const beam = [[0.0, 0.48], [0.08, 0.52], [0.0, 0.6], [0.08, 0.68], [0.0, 0.76]];
    const posts = [];
    for (const g of P.guardrails) {
      const s = g.side === 1 ? 1 : -1; // beam faces the road
      const prof = beam.map(([o, u]) => [o * -s, u]);
      this.extrude(g.pts, prof, this.matSteel, { cast: true, double: true, hAt: (x, y) => HF.heightAt(x, y) });
      for (let k = 0; k < g.pts.length; k += 1) posts.push(g.pts[k]);
    }
    const pg = this.track(new THREE.BoxGeometry(0.12, 0.8, 0.12)); pg.translate(0, 0.38, 0);
    const pm = new THREE.InstancedMesh(pg, this.matSteel, posts.length);
    const M = new THREE.Matrix4();
    posts.forEach((q, i) => { M.makeTranslation(q[0], HF.heightAt(q[0], q[1]), -q[1]); pm.setMatrixAt(i, M); });
    pm.castShadow = true; this.group.add(pm);
    // sign gantries
    for (const g of P.gantries) this.buildGantrySign(g);
    // road closed at the map edges
    for (const e of P.endBarriers) {
      const grp = new THREE.Group();
      const block = this.track(new THREE.BoxGeometry(0.6, 1.0, 28));
      const b = new THREE.Mesh(block, this.matConcrete); b.position.y = 0.5; grp.add(b);
      const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 256;
      const x = cv.getContext('2d');
      x.fillStyle = '#b81d1a'; x.fillRect(0, 0, 1024, 256); x.fillStyle = '#fff'; x.font = '800 120px "Chakra Petch", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('ROAD CLOSED', 512, 132);
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; this.track(t);
      const sm = this.track(new THREE.MeshStandardMaterial({ map: t, roughness: 0.5 }));
      const sign = new THREE.Mesh(this.track(new THREE.PlaneGeometry(12, 3)), sm); sign.position.set(-0.35, 2.6, 0); sign.rotation.y = -Math.PI / 2; grp.add(sign);
      const sign2 = sign.clone(); sign2.position.x = 0.35; sign2.rotation.y = Math.PI / 2; grp.add(sign2);
      grp.position.set(e.x, e.h, -e.y); grp.rotation.y = Math.atan2(e.ty, e.tx);
      grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.group.add(grp);
    }
    if (P.toll) this.buildToll(P.toll);
    if (P.gas) this.buildGas(P.gas);
    if (P.dhaba) this.buildDhaba(P.dhaba);
    if (P.view) this.buildView(P.view);
  }

  textSign(lines, w, h, bg = '#0b5d34', fg = '#ffffff') {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = Math.round((1024 * h) / w);
    const x = cv.getContext('2d');
    x.fillStyle = bg; x.fillRect(0, 0, cv.width, cv.height);
    x.strokeStyle = fg; x.lineWidth = 10; x.strokeRect(14, 14, cv.width - 28, cv.height - 28);
    x.fillStyle = fg; x.textBaseline = 'middle';
    lines.forEach((l, i) => {
      const fs = l.size || Math.min(110, (cv.height - 60) / lines.length * 0.75);
      x.font = `800 ${fs}px "Chakra Petch", "Arial Narrow", Arial, sans-serif`;
      x.textAlign = l.align || 'left';
      const y = 40 + ((cv.height - 80) * (i + 0.5)) / lines.length;
      x.fillText(l.t, l.align === 'center' ? cv.width / 2 : l.align === 'right' ? cv.width - 60 : 60, y);
    });
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; this.track(t);
    return this.track(new THREE.MeshStandardMaterial({ map: t, roughness: 0.5, emissive: '#ffffff', emissiveMap: t, emissiveIntensity: 0.05 }));
  }

  buildGantrySign(g) {
    const grp = new THREE.Group();
    const span = 28.4, h = 6.6;
    for (const s of [1, -1]) { const leg = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.5, h + 2.2, 0.5)), this.matSteel); leg.position.set(0, (h + 2.2) / 2, s * span / 2); grp.add(leg); }
    const beam = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.6, 0.6, span)), this.matSteel); beam.position.y = h + 2; grp.add(beam);
    // signs for each carriageway (left-hand traffic: eastbound uses the north half)
    const mk = (lines, z, faceDir) => {
      const sm = this.textSign(lines, 9, 3.2);
      const p = new THREE.Mesh(this.track(new THREE.PlaneGeometry(9, 3.2)), sm);
      p.position.set(faceDir * -0.35, h + 0.6, z); p.rotation.y = faceDir > 0 ? -Math.PI / 2 : Math.PI / 2;
      grp.add(p);
      const back = new THREE.Mesh(this.track(new THREE.PlaneGeometry(9, 3.2)), this.matSteel);
      back.position.set(faceDir * -0.25, h + 0.6, z); back.rotation.y = faceDir > 0 ? Math.PI / 2 : -Math.PI / 2; grp.add(back);
    };
    mk([{ t: 'M-9  ' + g.text[1] }, { t: '↑ ' + (g.x < 0 ? '42 km' : '18 km') }], -7, 1);
    mk([{ t: 'M-9  ' + g.text[0] }, { t: '↑ ' + (g.x < 0 ? '296 km' : '65 km') }], 7, -1);
    grp.position.set(g.x, g.h, -g.y);
    grp.rotation.y = Math.atan2(g.ty, g.tx);
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(grp);
  }

  buildToll(T) {
    const grp = new THREE.Group();
    const along = 22, across = 50, h = 6.2;
    const roof = new THREE.Mesh(this.track(new THREE.BoxGeometry(along, 1.0, across)), this.matWhite); roof.position.y = h + 0.5; grp.add(roof);
    const band = this.textSign([{ t: 'M-9 TOLL PLAZA', align: 'center' }], 30, 1.6, '#0b5d34');
    for (const s of [1, -1]) { const b = new THREE.Mesh(this.track(new THREE.PlaneGeometry(30, 1.6)), band); b.position.set(s * (along / 2 + 0.02), h + 0.5, 0); b.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2; grp.add(b); }
    const kerbM = this.matCurbPaint;
    const boothM = this.track(new THREE.MeshStandardMaterial({ color: '#e8e4da', roughness: 0.5 }));
    for (const isl of T.islands) {
      const o = isl.off;
      const k = new THREE.Mesh(this.track(new THREE.BoxGeometry(20, 0.25, 1.6)), kerbM); k.position.set(0, 0.12, -o); grp.add(k);
      const booth = new THREE.Mesh(this.track(new THREE.BoxGeometry(2.4, 2.6, 1.2)), boothM); booth.position.set(0, 1.55, -o); grp.add(booth);
      const glass = new THREE.Mesh(this.track(new THREE.BoxGeometry(2.2, 1.0, 1.25)), this.matGlass); glass.position.set(0, 2.0, -o); grp.add(glass);
      const col = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.25, 0.25, h, 10)), this.matSteel); col.position.set(6, h / 2, -o); grp.add(col);
      const col2 = col.clone(); col2.position.x = -6; grp.add(col2);
      const lamp = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.2, 0.5, 0.9)), this.emissiveLamp); lamp.position.set(-along / 2 + 0.3, h - 0.3, -o - (o > 0 ? -2.5 : 2.5)); grp.add(lamp);
    }
    grp.position.set(T.x, T.h + 0.07, -T.y);
    grp.rotation.y = Math.atan2(T.ty, T.tx);
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(grp);
    this.lamps.push(new THREE.Vector3(T.x, T.h + h, -T.y));
  }

  buildGas(G) {
    const grp = new THREE.Group();
    const c = G.canopy, h = 5.6, y = G.h + 0.07;
    const roof = new THREE.Mesh(this.track(new THREE.BoxGeometry(c.x1 - c.x0, 0.9, c.y1 - c.y0)), this.matWhite);
    roof.position.set((c.x0 + c.x1) / 2, y + h, -(c.y0 + c.y1) / 2); grp.add(roof);
    const fascia = this.textSign([{ t: 'PAK PETROL', align: 'center' }], 50, 0.9, '#0e5a35');
    for (const s of [1, -1]) { const f = new THREE.Mesh(this.track(new THREE.PlaneGeometry(c.x1 - c.x0, 0.9)), fascia); f.position.set((c.x0 + c.x1) / 2, y + h, -((c.y0 + c.y1) / 2 + s * ((c.y1 - c.y0) / 2 + 0.02))); f.rotation.y = s > 0 ? 0 : Math.PI; grp.add(f); }
    for (const px of [c.x0 + 6, (c.x0 + c.x1) / 2, c.x1 - 6]) for (const py of [c.y0 + 4, c.y1 - 4]) { const col = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.3, 0.3, h, 10)), this.matSteel); col.position.set(px, y + h / 2, -py); grp.add(col); }
    const pumpM = this.textSign([{ t: 'SUPER', align: 'center' }, { t: 'Rs 272', align: 'center' }], 1.2, 1.6, '#f2f0ea', '#0e5a35');
    for (let k = 0; k < 4; k++) {
      const x = G.rect.x0 + 38 + k * 11, yy = (G.rect.y0 + G.rect.y1) / 2;
      const p = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.2, 1.8, 2.6)), pumpM); p.position.set(x, y + 0.9, -yy); grp.add(p);
    }
    const s = G.shop;
    const shop = new THREE.Mesh(this.track(new THREE.BoxGeometry(s.x1 - s.x0, 4.5, s.y1 - s.y0)), this.matConcrete); shop.position.set((s.x0 + s.x1) / 2, y + 2.25, -(s.y0 + s.y1) / 2); grp.add(shop);
    const glass = new THREE.Mesh(this.track(new THREE.PlaneGeometry(s.x1 - s.x0 - 4, 2.6)), this.matGlass); glass.position.set((s.x0 + s.x1) / 2, y + 1.6, -(s.y1 + 0.02)); grp.add(glass);
    const sign = new THREE.Mesh(this.track(new THREE.PlaneGeometry(s.x1 - s.x0 - 2, 1.1)), this.textSign([{ t: 'TUCK SHOP  ·  CHAI  ·  ATM', align: 'center' }], 28, 1.1, '#f5b301', '#14110a'));
    sign.position.set((s.x0 + s.x1) / 2, y + 3.7, -(s.y1 + 0.03)); grp.add(sign);
    // tall price totem by the motorway
    const tot = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.5, 9, 3)), this.textSign([{ t: 'PAK', align: 'center' }, { t: 'PETROL', align: 'center' }, { t: 'Rs 272', align: 'center' }], 3, 9, '#0e5a35'));
    tot.position.set(G.rect.x0 + 8, y + 4.5, -(G.rect.y1 - 3)); grp.add(tot);
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(grp);
    this.lamps.push(new THREE.Vector3((c.x0 + c.x1) / 2, y + h - 0.5, -(c.y0 + c.y1) / 2));
    // canopy downlights
    const dl = new THREE.Mesh(this.track(new THREE.PlaneGeometry(c.x1 - c.x0 - 4, c.y1 - c.y0 - 4)), this.emissiveLamp);
    dl.rotation.x = Math.PI / 2; dl.position.set((c.x0 + c.x1) / 2, y + h - 0.46, -(c.y0 + c.y1) / 2); this.group.add(dl);
  }

  buildDhaba(D) {
    const grp = new THREE.Group();
    const h = D.hut, y = D.h;
    const walls = new THREE.Mesh(this.track(new THREE.BoxGeometry(h.x1 - h.x0, 3, h.y1 - h.y0)), this.matMud); walls.position.set((h.x0 + h.x1) / 2, y + 1.5, -(h.y0 + h.y1) / 2); grp.add(walls);
    const tin = this.track(new THREE.MeshStandardMaterial({ color: '#8d8f92', roughness: 0.45, metalness: 0.7, side: THREE.DoubleSide }));
    const roof = new THREE.Mesh(this.track(new THREE.BoxGeometry(h.x1 - h.x0 + 6, 0.08, h.y1 - h.y0 + 8)), tin); roof.position.set((h.x0 + h.x1) / 2, y + 3.4, -(h.y0 + h.y1) / 2 + 2); roof.rotation.x = 0.06; grp.add(roof);
    for (const [px, py] of [[h.x0 - 3, h.y1 + 4], [h.x1 + 3, h.y1 + 4]]) { const pole = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.08, 0.08, 3.2, 6)), this.matDarkMetal); pole.position.set(px, y + 1.6, -py); grp.add(pole); }
    const sign = new THREE.Mesh(this.track(new THREE.PlaneGeometry(10, 1.4)), this.textSign([{ t: 'SHAHEEN DHABA  ·  DAAL CHAWAL  ·  CHAI', align: 'center' }], 10, 1.4, '#b81d1a'));
    sign.position.set((h.x0 + h.x1) / 2, y + 3.9, -(h.y1 + 2.2)); grp.add(sign);
    // charpais (woven beds) out front
    const wood = this.track(new THREE.MeshStandardMaterial({ color: '#7a5634', roughness: 0.8 }));
    const weave = this.track(new THREE.MeshStandardMaterial({ color: '#c9b48a', roughness: 0.95 }));
    for (let k = 0; k < 6; k++) {
      const cx = h.x0 + 3 + (k % 3) * 6, cy = h.y1 + 7 + Math.floor(k / 3) * 4.5;
      const top = new THREE.Mesh(this.track(new THREE.BoxGeometry(2.0, 0.08, 1.0)), weave); top.position.set(cx, y + 0.55, -cy); grp.add(top);
      for (const [lx, ly] of [[-0.9, -0.42], [0.9, -0.42], [-0.9, 0.42], [0.9, 0.42]]) { const leg = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.08, 0.55, 0.08)), wood); leg.position.set(cx + lx, y + 0.27, -(cy + ly)); grp.add(leg); }
    }
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(grp);
    this.lamps.push(new THREE.Vector3((h.x0 + h.x1) / 2, y + 3.2, -(h.y1 + 3)));
  }

  buildView(V) {
    const r = V.rect, y = V.h + 0.07;
    const rail = [];
    for (let py = r.y0; py <= r.y1 + 0.01; py += 2) rail.push([r.x1 - 0.3, py, V.h]);
    this.extrude(rail, [[0, 0.95], [0.05, 1.0], [0, 1.05]], this.matSteel, { cast: true, double: true, hAt: () => y });
    const pg = this.track(new THREE.BoxGeometry(0.1, 1.05, 0.1)); pg.translate(0, 0.52, 0);
    const posts = new THREE.InstancedMesh(pg, this.matSteel, rail.length);
    const M = new THREE.Matrix4();
    rail.forEach((q, i) => { M.makeTranslation(q[0], y, -q[1]); posts.setMatrixAt(i, M); });
    this.group.add(posts);
    const sign = new THREE.Mesh(this.track(new THREE.PlaneGeometry(6, 1.6)), this.textSign([{ t: 'VIEW POINT  ·  2,240 m', align: 'center' }], 6, 1.6, '#3a2a1a'));
    sign.position.set((r.x0 + r.x1) / 2, y + 2.6, -(r.y0 - 0.5)); sign.rotation.y = Math.PI; this.group.add(sign);
    const sp = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.06, 0.06, 3.4, 6)), this.matDarkMetal); sp.position.set((r.x0 + r.x1) / 2, y + 1.7, -(r.y0 - 0.45)); this.group.add(sp);
  }

  // ---------------------------------------------------------------- electric poles with sagging wires, city street lights
  buildPoles() {
    const Wd = this.Wd, P = Wd.props, C = Wd.city;
    const conc = this.track(new THREE.MeshStandardMaterial({ color: '#9c988f', roughness: 0.85 }));
    const pg = this.track(new THREE.CylinderGeometry(0.12, 0.18, 9.5, 8)); pg.translate(0, 4.75, 0);
    const poles = new THREE.InstancedMesh(pg, conc, P.poles.length);
    const ag = this.track(new THREE.BoxGeometry(0.1, 0.12, 1.8)); ag.translate(0, 8.9, 0);
    const arms = new THREE.InstancedMesh(ag, this.matDarkMetal, P.poles.length);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
    // align crossarms across the wire direction
    const dirAt = new Map();
    for (const w of P.wires) for (let k = 0; k < w.length; k++) { const a = w[Math.max(0, k - 1)], b = w[Math.min(w.length - 1, k + 1)]; dirAt.set(`${w[k][0].toFixed(1)},${w[k][1].toFixed(1)}`, Math.atan2(b[1] - a[1], b[0] - a[0])); }
    P.poles.forEach((p, i) => {
      M.makeTranslation(p.x, p.h - 0.3, -p.y); poles.setMatrixAt(i, M);
      const ang = dirAt.get(`${p.x.toFixed(1)},${p.y.toFixed(1)}`) || 0;
      Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang); M.compose(V.set(p.x, p.h - 0.3, -p.y), Q, S); arms.setMatrixAt(i, M);
    });
    poles.castShadow = true; arms.castShadow = true;
    this.group.add(poles, arms);
    // wires: three conductors with catenary sag between poles
    const pos = [];
    for (const w of P.wires) for (let k = 0; k < w.length - 1; k++) {
      const a = w[k], b = w[k + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
      for (const o of [-0.8, 0, 0.8]) {
        const steps = 8;
        let prev = null;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = a[0] + dx * t + nx * o, y = a[1] + dy * t + ny * o;
          const h = a[2] + (b[2] - a[2]) * t + 8.95 - 0.3 - Math.sin(Math.PI * t) * (0.35 + L * 0.012);
          const cur = [x, h, -y];
          if (prev) pos.push(...prev, ...cur);
          prev = cur;
        }
      }
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const wires = new THREE.LineSegments(this.track(lg), this.track(new THREE.LineBasicMaterial({ color: '#1c1c1c', transparent: true, opacity: 0.85 })));
    this.group.add(wires);
    // city street lights: pole, arm and a head that glows at night
    const sl = C.lights;
    const sp = this.track(new THREE.CylinderGeometry(0.08, 0.12, 8, 8)); sp.translate(0, 4, 0);
    const spm = new THREE.InstancedMesh(sp, this.matSteel, sl.length);
    const hg = this.track(new THREE.BoxGeometry(1.6, 0.18, 0.45)); hg.translate(0.8, 7.9, 0);
    const hm = new THREE.InstancedMesh(hg, this.emissiveLamp, sl.length);
    sl.forEach((l, i) => {
      M.makeTranslation(l.x, l.h + 0.1, -l.y); spm.setMatrixAt(i, M);
      Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.dir); M.compose(V.set(l.x, l.h + 0.1, -l.y), Q, S); hm.setMatrixAt(i, M);
      if (i % 2 === 0) this.lamps.push(new THREE.Vector3(l.x + Math.cos(l.dir) * 1.2, l.h + 7.6, -(l.y + Math.sin(l.dir) * 1.2)));
    });
    spm.castShadow = true; hm.castShadow = true;
    this.group.add(spm, hm);
  }

  // ---------------------------------------------------------------- vegetation (instanced cards)
  buildTrees() {
    const Wd = this.Wd, R = rng(31);
    const bark = this.track(TX.barkTexture());
    const trunkMat = this.track(new THREE.MeshStandardMaterial({ map: bark, roughness: 0.95 }));
    const leafB = this.track(TX.leafTexture('broad')), leafN = this.track(TX.leafTexture('narrow')), conifer = this.track(TX.coniferTexture());
    const crownMat = (tex, rough = 0.82) => this.track(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.42, side: THREE.DoubleSide, roughness: rough, metalness: 0 }));
    const crown = (w, h, cy, cards, tilt, cone) => {
      const gb = new GB();
      for (let k = 0; k < cards; k++) {
        const a = (k / cards) * Math.PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        const t = (k % 2 ? 1 : -1) * tilt;
        const P = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => { const y = cy + v * Math.cos(t), d = v * Math.sin(t); return [ca * u - sa * d, y, sa * u + ca * d]; });
        const ids = P.map((p, i) => {
          const nx = p[0], ny = cone ? 0.6 : (p[1] - cy) * 0.8 + h * 0.15, nz = p[2], l = Math.hypot(nx, ny, nz) || 1;
          return gb.v(p[0], p[1], p[2], nx / l, ny / l, nz / l, i === 0 || i === 3 ? 0 : 1, i < 2 ? 0 : 1);
        });
        gb.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
      }
      return this.track(gb.build());
    };
    const kinds = {
      round: { crown: crown(7.2, 6.2, 6.3, 5, 0.5), trunkH: 3.6, trunkR: 0.24, mat: crownMat(leafB) },
      poplar: { crown: crown(3.2, 12.5, 8.6, 4, 0.12), trunkH: 2.6, trunkR: 0.17, mat: crownMat(leafN) },
      palm: { crown: crown(5.2, 3.2, 8.6, 6, 1.1), trunkH: 8.2, trunkR: 0.2, mat: crownMat(leafN) },
      pine: { crown: crown(6.2, 15, 8.2, 3, 0, true), trunkH: 1.5, trunkR: 0.22, mat: crownMat(conifer, 0.9) },
    };
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    for (const [name, K] of Object.entries(kinds)) {
      const list = Wd.trees.filter((t) => t.kind === name);
      if (!list.length) continue;
      const tg = this.track(new THREE.CylinderGeometry(K.trunkR * 0.7, K.trunkR, K.trunkH + 1, 6, 1, true)); tg.translate(0, (K.trunkH + 1) / 2, 0);
      const trunks = new THREE.InstancedMesh(tg, trunkMat, list.length);
      const crowns = new THREE.InstancedMesh(K.crown, K.mat, list.length);
      list.forEach((t, i) => {
        Q.setFromAxisAngle(up, R() * Math.PI * 2);
        const s = t.s;
        M.compose(P.set(t.x, t.h - 0.3, -t.y), Q, S.set(s, s * (0.9 + R() * 0.25), s));
        trunks.setMatrixAt(i, M); crowns.setMatrixAt(i, M);
        if (name === 'pine') col.setRGB(0.9 + R() * 0.25, 0.95 + R() * 0.2, 0.9 + R() * 0.2);
        else { const hue = 0.24 + (R() - 0.5) * 0.05, light = 0.82 + R() * 0.3; col.setHSL(hue, 0.25, 0.5).multiplyScalar(light * 1.6); }
        crowns.setColorAt(i, col);
      });
      trunks.castShadow = true; trunks.receiveShadow = true;
      crowns.castShadow = true; crowns.receiveShadow = true;
      trunks.userData.maxDist = 650; // a trunk is a few pixels wide beyond this; the crown carries the tree
      crowns.userData.maxDist = Infinity; // forests stay on the far hills
      this.group.add(trunks, crowns);
    }
  }

  // ---------------------------------------------------------------- truck-art trucks at the dhaba
  buildTrucks() {
    const D = this.Wd.props.dhaba;
    if (!D) return;
    const bases = ['#1f6fd1', '#e3262f'];
    bases.forEach((base, k) => {
      const grp = this.makeTruck(base);
      const x = D.rect.x0 + 30 + k * 5.5, y = D.rect.y0 + 10 + k * 22;
      grp.position.set(x, D.h, -y);
      grp.rotation.y = Math.PI / 2 + (k ? 0.12 : -0.08);
      this.group.add(grp);
    });
  }

  makeTruck(base) {
    const grp = new THREE.Group();
    const art = this.track(makeTruckArt(base));
    const artMat = this.track(new THREE.MeshStandardMaterial({ map: art, roughness: 0.45, metalness: 0.1 }));
    const cabMat = this.track(new THREE.MeshStandardMaterial({ color: base, roughness: 0.4, metalness: 0.2 }));
    const wood = this.track(new THREE.MeshStandardMaterial({ color: '#8a5a32', roughness: 0.8 }));
    // cargo body (high wooden sides with painted panels), cab, the decorated crown over the cab
    const body = new THREE.Mesh(this.track(new THREE.BoxGeometry(6.2, 2.4, 2.45)), [artMat, artMat, wood, wood, artMat, artMat]);
    body.position.set(-1.2, 2.3, 0); grp.add(body);
    const cab = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.9, 1.9, 2.3)), cabMat); cab.position.set(3.0, 1.95, 0); grp.add(cab);
    const glass = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.05, 0.8, 2.0)), this.matGlass); glass.position.set(3.97, 2.4, 0); grp.add(glass);
    const crown = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.4, 1.2, 2.5)), artMat); crown.position.set(3.25, 3.4, 0); crown.rotation.z = 0.25; grp.add(crown);
    const bump = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.25, 0.35, 2.5)), this.matSteel); bump.position.set(4.05, 0.85, 0); grp.add(bump);
    const chassis = new THREE.Mesh(this.track(new THREE.BoxGeometry(8.2, 0.35, 1.9)), this.matBlack); chassis.position.set(0, 0.9, 0); grp.add(chassis);
    const wg = this.track(new THREE.CylinderGeometry(0.52, 0.52, 0.35, 16)); wg.rotateX(Math.PI / 2);
    for (const wx of [2.9, -1.6, -2.8]) for (const s of [1, -1]) { const w = new THREE.Mesh(wg, this.matBlack); w.position.set(wx, 0.52, s * 1.05); grp.add(w); }
    // mud flaps with tassels
    for (const s of [1, -1]) { const f = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.04, 0.6, 0.55)), artMat); f.position.set(-4.0, 0.6, s * 0.95); grp.add(f); }
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return grp;
  }

  // ---------------------------------------------------------------- 3D grass tufts that follow the camera
  buildGrass() {
    const n = this.q === 'high' ? 9000 : this.q === 'medium' ? 4500 : 0;
    if (!n) return;
    const tex = this.track(TX.grassTuftTexture());
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.95 });
    const uTime = this.uTime;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace('#include <begin_vertex>', `#include <begin_vertex>
        float sway = uv.y * uv.y;
        vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        transformed.x += sin(uTime * 1.7 + ip.x * 0.31 + ip.z * 0.17) * 0.07 * sway;
        transformed.z += cos(uTime * 1.3 + ip.x * 0.23) * 0.05 * sway;`)
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = vec3(0.0, 1.0, 0.0);');
      // both faces of a card are lit like the ground beneath them
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
    };
    mat.customProgramCacheKey = () => 'pakswap-grass';
    this.track(mat);
    // two crossed cards, 0.7 m wide, 0.42 m tall
    const gb = new GB();
    for (const a of [0, Math.PI / 2]) {
      const c = Math.cos(a) * 0.35, s2 = Math.sin(a) * 0.35;
      gb.quad([[-c, 0, -s2], [c, 0, s2], [c, 0.42, s2], [-c, 0.42, -s2]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    const g = this.track(gb.build());
    const im = new THREE.InstancedMesh(g, mat, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.count = 0;
    im.receiveShadow = true;
    this.group.add(im);
    this.grass = im;
    this.grassN = n;
    this.grassCell = null;
    this.grassCol = new THREE.Color();
  }

  updateGrass(cx, cy) {
    if (!this.grass) return;
    const C = 9;
    const key = `${Math.floor(cx / C)},${Math.floor(cy / C)}`;
    if (key === this.grassCell) return;
    this.grassCell = key;
    const Wd = this.Wd, R = this.q === 'high' ? 50 : 38, step = this.q === 'high' ? 0.95 : 1.15;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let k = 0;
    const i0 = Math.floor((cx - R) / step), i1 = Math.ceil((cx + R) / step), j0 = Math.floor((cy - R) / step), j1 = Math.ceil((cy + R) / step);
    for (let j = j0; j <= j1 && k < this.grassN; j++) for (let i = i0; i <= i1 && k < this.grassN; i++) {
      // stable per-cell random numbers
      let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663);
      h = Math.imul(h ^ (h >>> 13), 1274126177); const r1 = ((h >>> 0) % 10000) / 10000;
      h = Math.imul(h ^ (h >>> 15), 2246822519); const r2 = ((h >>> 0) % 10000) / 10000;
      h = Math.imul(h ^ (h >>> 16), 3266489917); const r3 = ((h >>> 0) % 10000) / 10000;
      if (r1 > 0.85) continue;
      const x = (i + r2) * step, y = (j + r3) * step;
      const d = Math.hypot(x - cx, y - cy);
      if (d > R) continue;
      const sid = Wd.SM.get(x, y);
      if (sid !== 0) continue;
      const hh = Wd.HF.heightAt(x, y);
      if (hh < Wd.lake.level + 0.6) continue;
      const g2 = Wd.HF.gradAt(x, y);
      if (g2[0] * g2[0] + g2[1] * g2[1] > 0.3) continue;
      const s = (0.7 + r1 * 0.9) * (1 - smooth(R - 12, R, d) * 0.85);
      Q.setFromAxisAngle(up, r2 * 6.28);
      M.compose(P.set(x, hh - 0.03, -y), Q, S.set(s, s * (0.8 + r3 * 0.6), s));
      this.grass.setMatrixAt(k, M);
      const dry = r3 > 0.7 ? 0.3 : 0;
      this.grassCol.setRGB(1.0 + dry * 0.45 + r2 * 0.15, 1.05 + dry * 0.2 + r1 * 0.1, 0.92);
      this.grass.setColorAt(k, this.grassCol);
      k++;
    }
    this.grass.count = k;
    this.grass.instanceMatrix.needsUpdate = true;
    if (this.grass.instanceColor) this.grass.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- per frame
  setNight(on) {
    this.night = on;
    this.uNight.value = on ? 1 : 0;
    this.park.setNight(on);
    // lights that are off are taken out of the scene, so daytime shaders do not loop over them
    for (const l of this.park.nightLights) l.visible = on;
    this.emissiveLamp.emissiveIntensity = on ? 8 : 0;
    if (this.signMat) this.signMat.emissiveIntensity = on ? 0.55 : 0;
    if (this.towerMat) this.towerMat.emissiveIntensity = on ? 0.85 : 0;
  }

  update(dt, cx, cy, camX, camY, camera) {
    this.uTime.value += dt;
    const px = camX ?? cx, py = camY ?? cy;
    // terrain detail follows the camera; re-evaluated when it has moved, or while chunks are
    // still waiting for their turn in the build budget
    const T = this.terrainAt;
    if (T.pending || Math.abs(px - T.x) + Math.abs(py - T.y) > 12) { T.x = px; T.y = py; T.pending = this.updateTerrain(px, py); }
    this.updateGrass(px, py);
    if (camera) this.cullCells(camera, dt);
    if (this.waterNormal) { this.waterNormal.offset.x += dt * 0.004; this.waterNormal.offset.y += dt * 0.0025; }
    this.park.uTime.value += dt;
    // at night a few real lights hop to the lamps nearest the car
    const L = this.park.nightLights;
    if (!this.night) { if (this.lampsLit) { for (const l of L) l.intensity = 0; this.lampsLit = false; } return; }
    this.lampsLit = true;
    const P = this.lampPick, n = Math.min(L.length, P.idx.length), lamps = this.lamps, z = -cy;
    P.t -= dt;
    if (P.t <= 0) {
      // choose the nearest lamps a few times a second (a partial selection, no sorting, no garbage)
      P.t = 0.2;
      for (let k = 0; k < n; k++) { P.idx[k] = -1; P.d2[k] = Infinity; }
      for (let i = 0; i < lamps.length; i++) {
        const p = lamps[i], d2 = (p.x - cx) * (p.x - cx) + (p.z - z) * (p.z - z);
        if (d2 >= P.d2[n - 1]) continue;
        let k = n - 1;
        while (k > 0 && P.d2[k - 1] > d2) { P.d2[k] = P.d2[k - 1]; P.idx[k] = P.idx[k - 1]; k--; }
        P.d2[k] = d2; P.idx[k] = i;
      }
    }
    for (let k = 0; k < n; k++) {
      const pl = L[k], i = P.idx[k];
      if (i < 0) { pl.intensity = 0; continue; }
      const p = lamps[i];
      pl.position.copy(p);
      pl.intensity = 480 * Math.max(0, 1 - Math.sqrt((p.x - cx) * (p.x - cx) + (p.z - z) * (p.z - z)) / 90);
      pl.distance = 80;
    }
  }

  dispose() {
    this.park.dispose();
    for (const v of this.geoCache.values()) v.g.dispose();
    for (const d of this.disposables) d.dispose?.();
    this.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }
}
void S_ASPHALT; void S_GRASS;


// ---------------------------------------------------------------- spatial batching
const CELL = 325; // metres; the map is 16 x 16 of these
const ICELL = 650; // instanced props (trees, poles) are grouped in larger cells

function maxScale(m) {
  const e = m.elements;
  return Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
}

// Cut a geometry into one piece per map cell, by the centre of each triangle.
function splitByCell(geo, cell) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (bb.max.x - bb.min.x <= cell * 1.15 && bb.max.z - bb.min.z <= cell * 1.15) return [geo];
  const pos = geo.getAttribute('position').array;
  const index = geo.index ? geo.index.array : null;
  const nTri = Math.floor((index ? index.length : pos.length / 3) / 3);
  const ids = new Int32Array(nTri);
  const counts = new Map();
  for (let t = 0; t < nTri; t++) {
    const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : t * 3 + 1, c = index ? index[t * 3 + 2] : t * 3 + 2;
    const x = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3, z = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
    const id = (Math.floor(x / cell) + 512) * 4096 + (Math.floor(z / cell) + 512);
    ids[t] = id; counts.set(id, (counts.get(id) || 0) + 1);
  }
  if (counts.size === 1) return [geo];
  const groups = new Map();
  for (const [id, n] of counts) groups.set(id, { tris: new Uint32Array(n), k: 0 });
  for (let t = 0; t < nTri; t++) { const g = groups.get(ids[t]); g.tris[g.k++] = t; }
  const names = Object.keys(geo.attributes);
  const remap = new Int32Array(pos.length / 3).fill(-1);
  const out = [];
  for (const { tris } of groups.values()) {
    const used = [];
    const idx = new Uint32Array(tris.length * 3);
    for (let k = 0; k < tris.length; k++) for (let c = 0; c < 3; c++) {
      const vi = index ? index[tris[k] * 3 + c] : tris[k] * 3 + c;
      let ni = remap[vi];
      if (ni < 0) { ni = used.length; remap[vi] = ni; used.push(vi); }
      idx[k * 3 + c] = ni;
    }
    const g = new THREE.BufferGeometry();
    for (const name of names) {
      const a = geo.attributes[name], size = a.itemSize, src = a.array;
      const arr = new src.constructor(used.length * size);
      for (let i = 0; i < used.length; i++) { const o = used[i] * size; for (let c = 0; c < size; c++) arr[i * size + c] = src[o + c]; }
      g.setAttribute(name, new THREE.BufferAttribute(arr, size, a.normalized));
    }
    g.setIndex(new THREE.BufferAttribute(used.length > 65535 ? idx : Uint16Array.from(idx), 1));
    for (let i = 0; i < used.length; i++) remap[used[i]] = -1;
    g.computeBoundingBox(); g.computeBoundingSphere();
    out.push(g);
  }
  geo.dispose();
  return out;
}

// Bake static meshes into one mesh per material, shadow flags and size class, then cut each of
// those along the map cells. `place(mesh, x, z)` files a piece under its cell. Instanced,
// multi-material and listed meshes are left alone.
function mergeStatic(root, skip, disposables, place) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || skip.has(o) || Array.isArray(o.material) || o.userData.keep) return;
    const g = o.geometry;
    if (!g || !g.getAttribute('position') || g.morphAttributes?.position) return;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const r = g.boundingSphere.radius * maxScale(o.matrixWorld);
    const cls = r < 3.2 ? 0 : r < 16 ? 1 : 2;
    const attrs = Object.keys(g.attributes).sort().join(',');
    const key = `${o.material.uuid}|${g.index ? 'i' : 'n'}|${attrs}|${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}|${o.renderOrder}|${cls}`;
    if (!buckets.has(key)) buckets.set(key, { list: [], cls });
    buckets.get(key).list.push(o);
  });
  let removed = 0, added = 0;
  const M = new THREE.Matrix4();
  for (const { list, cls } of buckets.values()) {
    const geos = list.map((o) => { M.multiplyMatrices(inv, o.matrixWorld); const g = o.geometry.clone(); g.applyMatrix4(M); return g; });
    let merged = null;
    if (geos.length === 1) merged = geos[0];
    else {
      try { merged = mergeGeometries(geos, false); } catch (e) { merged = null; }
      for (const g of geos) g.dispose();
    }
    if (!merged) continue;
    const src = list[0];
    for (const o of list) { o.parent.remove(o); removed++; }
    for (const part of splitByCell(merged, CELL)) {
      if (!part.boundingSphere) part.computeBoundingSphere();
      if (!part.boundingBox) part.computeBoundingBox();
      const mesh = new THREE.Mesh(part, src.material);
      mesh.castShadow = src.castShadow; mesh.receiveShadow = src.receiveShadow; mesh.renderOrder = src.renderOrder;
      mesh.matrixAutoUpdate = false;
      if (cls < 2) mesh.userData.cls = cls;
      disposables.push(part);
      const c = part.boundingSphere.center;
      place(mesh, c.x, c.z);
      added++;
    }
  }
  return { removed, added };
}

// Split every instanced mesh into one instanced mesh per map cell, so frustum culling works on
// them (a single mesh holding the whole forest has a bounding sphere the size of the map).
function splitInstanced(root, skip, place) {
  const list = [];
  root.traverse((o) => { if (o.isInstancedMesh && !skip.has(o) && !o.userData.keep && o.count > 0) list.push(o); });
  const M = new THREE.Matrix4(), W = new THREE.Matrix4(), col = new THREE.Color();
  let made = 0;
  for (const im of list) {
    im.updateWorldMatrix(true, false);
    const groups = new Map();
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, M); W.multiplyMatrices(im.matrixWorld, M);
      const id = (Math.floor(W.elements[12] / ICELL) + 512) * 4096 + (Math.floor(W.elements[14] / ICELL) + 512);
      let g = groups.get(id);
      if (!g) { g = []; groups.set(id, g); }
      g.push(i);
    }
    if (!im.geometry.boundingSphere) im.geometry.computeBoundingSphere();
    const r = im.geometry.boundingSphere.radius;
    for (const ids of groups.values()) {
      const part = new THREE.InstancedMesh(im.geometry, im.material, ids.length);
      let sx = 0, sz = 0;
      for (let k = 0; k < ids.length; k++) {
        im.getMatrixAt(ids[k], M); W.multiplyMatrices(im.matrixWorld, M);
        part.setMatrixAt(k, W);
        if (im.instanceColor) { im.getColorAt(ids[k], col); part.setColorAt(k, col); }
        sx += W.elements[12]; sz += W.elements[14];
      }
      part.instanceMatrix.needsUpdate = true;
      if (part.instanceColor) part.instanceColor.needsUpdate = true;
      part.castShadow = im.castShadow; part.receiveShadow = im.receiveShadow; part.renderOrder = im.renderOrder;
      part.matrixAutoUpdate = false;
      if (im.userData.maxDist !== undefined) { if (im.userData.maxDist !== Infinity) { part.userData.cls = 9; part.userData.maxDist = im.userData.maxDist; } } else if (r < 9) part.userData.cls = r < 3.2 ? 0 : 1;
      place(part, sx / ids.length, sz / ids.length);
      made++;
    }
    im.parent.remove(im);
    im.dispose();
  }
  return { from: list.length, made };
}
