// Three.js scene for the drive world, built from the pure layout in track.js.
// World 2D (x east, y north) maps to three.js as (x, height, -y).
import * as THREE from 'three';
import * as TX from './textures.js';
import { S_GRASS, S_ASPHALT, S_KERB, S_GRAVEL, S_CONCRETE, S_DIRT, PAD, TRACK_HALF } from './track.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- geometry builder
export class GB {
  constructor(color = false) { this.p = []; this.n = []; this.uv = []; this.c = color ? [] : null; this.idx = []; }
  v(x, y, z, nx, ny, nz, u, w, col) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, w);
    if (this.c) this.c.push(col ? col[0] : 1, col ? col[1] : 1, col ? col[2] : 1);
    return this.p.length / 3 - 1;
  }
  // quad from four corners [x,y,z], facing normal n; uvs [[u,v] x4]; winding fixed automatically
  quad(P, n, uvs, col) {
    const [a, b, c] = P;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const flip = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] < 0;
    const ids = P.map((p, i) => this.v(p[0], p[1], p[2], n[0], n[1], n[2], uvs[i][0], uvs[i][1], col));
    if (flip) this.idx.push(ids[0], ids[2], ids[1], ids[0], ids[3], ids[2]);
    else this.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.c) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// strip along a ribbon: offsets [o0..on] (left positive) with heights; indices i0..i1 of samples
export function ribbonStrip(rb, i0, i1, offs, heights, uvFn, colFn, closed) {
  const gb = new GB(!!colFn);
  const N = rb.n;
  const rows = [];
  for (let k = i0; k <= i1; k++) {
    const i = ((k % N) + N) % N;
    const nx = -rb.ty[i], ny = rb.tx[i];
    const row = [];
    offs.forEach((o, j) => {
      const x = rb.x[i] + nx * o, y = rb.y[i] + ny * o;
      const uv = uvFn(x, y, k, j, o);
      row.push(gb.v(x, heights[j], -y, 0, 1, 0, uv[0], uv[1], colFn ? colFn(k, o) : null));
    });
    rows.push(row);
  }
  for (let r = 0; r < rows.length - 1; r++) for (let j = 0; j < offs.length - 1; j++) {
    const a = rows[r][j], b = rows[r][j + 1], c = rows[r + 1][j + 1], d = rows[r + 1][j];
    // CCW seen from above (+y): travel direction x forward, left offsets larger
    gb.idx.push(a, d, c, a, c, b);
  }
  void closed;
  const g = gb.build();
  // fix normals for the raised profiles
  g.computeVertexNormals();
  return g;
}

export function setShadows(o, cast, receive) { o.traverse((m) => { if (m.isMesh) { m.castShadow = cast; m.receiveShadow = receive; } }); return o; }

export function parkMacroTexture(L, quality) {
const R = rng(77);
const S = quality === 'low' ? 1024 : 2048, half = 512; // macro covers x,y in [-512, 512]
  const data = new Uint8Array(S * S * 4);
  const mpp = (2 * half) / S;
  // patchy colour variation (dry patches, greener hollows)
  const N = 256, lat = new Float32Array(N * N);
  for (let i = 0; i < lat.length; i++) lat[i] = R();
  const smoothN = (x, y, cells) => {
    const fx = (x / (2 * half) + 0.5) * cells, fy = (y / (2 * half) + 0.5) * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const g = (a, b) => lat[((b % N) + N) % N * N + ((a % N) + N) % N];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx) * (1 - sy) + (g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx) * sy;
  };
  const B = L.bounds;
  for (let j = 0; j < S; j++) {
    const y = half - (j + 0.5) * mpp;
    for (let i = 0; i < S; i++) {
      const x = -half + (i + 0.5) * mpp;
      const cx = Math.floor((x - B.x0) / L.cell), cy = Math.floor((y - B.y0) / L.cell);
      const inside = cx >= 0 && cy >= 0 && cx < L.W && cy < L.H;
      const s = inside ? L.grid[cy * L.W + cx] : S_GRASS;
      const o = (j * S + i) * 4;
      const n1 = smoothN(x, y, 24), n2 = smoothN(x + 300, y - 200, 90);
      let r = 1, g = 1, b = 1, a = 0;
      if (s === S_GRAVEL) { a = 255; const v = 0.92 + n2 * 0.14; r = v; g = v * 0.98; b = v * 0.95; }
      else if (s === S_DIRT) { a = 100; const v = 0.86 + n2 * 0.2; r = v; g = v; b = v; }
      else if (s === S_GRASS) {
        const dry = Math.max(0, n1 - 0.55) * 1.6;
        const v = 0.86 + n2 * 0.22;
        r = v * (1 + dry * 0.35); g = v * (1 + dry * 0.1); b = v * (1 - dry * 0.2);
        // mown stripes inside the walls
        if (inside && x > B.x0 + 14 && x < B.x1 - 14 && y > B.y0 + 14 && y < B.y1 - 14) { const st = Math.floor((y + 1000) / 9) % 2; const k = st ? 1.07 : 0.94; r *= k; g *= k; b *= k; }
      } else { r = g = b = 0.55; } // under tarmac: dark so edges never glow
      data[o] = Math.min(255, r * 200); data[o + 1] = Math.min(255, g * 200); data[o + 2] = Math.min(255, b * 200); data[o + 3] = a;
    }
  }
  // soften the gravel/dirt mask edges
  const blurA = () => {
    const tmp = new Uint8Array(S * S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      let s = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const jj = j + dj, ii = i + di; if (jj < 0 || ii < 0 || jj >= S || ii >= S) continue; s += data[(jj * S + ii) * 4 + 3]; n++; }
      tmp[j * S + i] = s / n;
    }
    for (let k = 0; k < S * S; k++) data[k * 4 + 3] = tmp[k];
  };
  blurA();
  const macro = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  macro.flipY = false; macro.magFilter = THREE.LinearFilter; macro.minFilter = THREE.LinearMipmapLinearFilter; macro.generateMipmaps = true;
  macro.colorSpace = THREE.NoColorSpace; macro.needsUpdate = true;
  return { tex: macro, half };
}

export class WorldView {
  constructor(layout, opts = {}) {
    this.L = layout;
    this.q = opts.quality || 'high';
    this.group = new THREE.Group();
    this.group.name = 'drive-world';
    this.disposables = [];
    this.uTime = { value: 0 };
    this.R = rng(1234);
    this.buildMaterials();
    if (opts.ground !== false) this.buildGround();
    this.buildTarmac();
    this.buildMarkings();
    this.buildWalls();
    this.buildTyreWalls();
    this.buildBuildings();
    this.buildGrandstand();
    this.buildGantry();
    this.buildLights();
    this.buildBoards();
    this.buildFlags();
    if (opts.trees !== false) this.buildTrees();
    this.buildCones();
    this.setNight(false);
  }

  track(o) { this.disposables.push(o); return o; }

  // ---------------------------------------------------------------- materials
  buildMaterials() {
    const A = TX.asphaltTextures(this.q === 'low' ? 512 : 1024);
    this.asphaltTex = A;
    this.matAsphalt = this.track(new THREE.MeshStandardMaterial({ map: A.map, normalMap: A.normalMap, roughnessMap: A.roughnessMap, normalScale: new THREE.Vector2(0.7, 0.7), vertexColors: true, roughness: 1, metalness: 0 }));
    this.matAsphaltTop = this.track(this.matAsphalt.clone());
    this.matAsphaltTop.polygonOffset = true; this.matAsphaltTop.polygonOffsetFactor = -1; this.matAsphaltTop.polygonOffsetUnits = -2;
    const C = TX.slabTexture(512);
    this.matSlab = this.track(new THREE.MeshStandardMaterial({ map: C.map, normalMap: C.normalMap, normalScale: new THREE.Vector2(0.4, 0.4), roughness: 0.82 }));
    const C2 = TX.concreteTextures(512, 23);
    this.matConcrete = this.track(new THREE.MeshStandardMaterial({ map: C2.map, normalMap: C2.normalMap, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.88 }));
    this.matKerb = this.track(new THREE.MeshStandardMaterial({ map: TX.kerbTexture(), roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    this.matPaint = this.track(new THREE.MeshStandardMaterial({ color: '#e7e5de', roughness: 0.62, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
    this.matWall = this.track(new THREE.MeshStandardMaterial({ map: TX.wallTexture(), roughness: 0.85 }));
    this.matMetal = this.track(new THREE.MeshStandardMaterial({ color: '#5d6166', roughness: 0.45, metalness: 0.75 }));
    this.matDarkMetal = this.track(new THREE.MeshStandardMaterial({ color: '#2b2e33', roughness: 0.5, metalness: 0.6 }));
  }

  // ---------------------------------------------------------------- ground: grass, gravel and dirt in one shader
  buildGround() {
    const { tex: macro, half } = parkMacroTexture(this.L, this.q);
    this.track(macro);
    const grass = TX.grassTextures(this.q === 'low' ? 512 : 1024), gravel = TX.gravelTextures(512);
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.96, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { tGrass: { value: grass.map }, tGrassN: { value: grass.normalMap }, tGravel: { value: gravel.map }, tGravelN: { value: gravel.normalMap }, tMacro: { value: macro }, uMacro: { value: new THREE.Vector4(-half, -half, 2 * half, 2 * half) } });
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; uniform sampler2D tGrass, tGrassN, tGravel, tGravelN, tMacro; uniform vec4 uMacro;')
        .replace('#include <map_fragment>', `
          vec2 wp = vec2(vWPos.x, -vWPos.z);
          vec2 muv = (wp - uMacro.xy) / uMacro.zw;
          muv.y = 1.0 - muv.y;
          vec4 macro = vec4(0.93, 0.93, 0.93, 0.0);
          if (muv.x > 0.0 && muv.x < 1.0 && muv.y > 0.0 && muv.y < 1.0) macro = texture2D(tMacro, muv) * vec4(1.275, 1.275, 1.275, 1.0);
          float gm = smoothstep(0.6, 0.9, macro.a);
          float dm = smoothstep(0.18, 0.4, macro.a) * (1.0 - gm);
          vec3 gr1 = texture2D(tGrass, wp / 3.1).rgb;
          vec3 gr2 = texture2D(tGrass, wp / 41.0 + 0.37).rgb;
          vec3 grassC = gr1 * mix(vec3(1.0), gr2 * 1.9, 0.45);
          vec3 gravC = texture2D(tGravel, wp / 2.3).rgb;
          vec3 col = mix(grassC, gravC, gm);
          col = mix(col, gravC * vec3(0.82, 0.66, 0.5), dm);
          diffuseColor.rgb *= col * macro.rgb;
        `)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness - gm * 0.05;')
        .replace('#include <normal_fragment_maps>', `
          vec3 nG = texture2D(tGrassN, wp / 3.1).xyz * 2.0 - 1.0;
          vec3 nV = texture2D(tGravelN, wp / 2.3).xyz * 2.0 - 1.0;
          vec3 tn = normalize(mix(nG, nV, max(gm, dm)));
          vec3 nW = normalize(vec3(tn.x * 0.9, tn.z, -tn.y * 0.9));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        `);
    };
    this.track(mat);
    const g = this.track(new THREE.PlaneGeometry(9000, 9000, 1, 1));
    g.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(g, mat);
    ground.receiveShadow = true;
    this.group.add(ground);
    this.ground = ground;
  }

  // ---------------------------------------------------------------- tarmac: circuit, pad, road, paddock
  buildTarmac() {
    const L = this.L, c = L.circuit, hw = TRACK_HALF;
    const W4 = (x, y) => [x / 4, y / 4];
    // rubbered-in racing line drifts toward the inside of corners
    const n = c.n, shift = new Float32Array(n);
    for (let i = 0; i < n; i++) { let a = 0; for (let k = -16; k <= 16; k++) a += Math.max(-1, Math.min(1, c.ks[(i + k + n) % n] * 140)); shift[i] = (a / 33) * hw * 0.55; }
    const R = rng(5);
    const wobble = Array.from({ length: n }, () => (R() - 0.5) * 0.05);
    const offs = [-hw, -hw * 0.66, -hw * 0.33, 0, hw * 0.33, hw * 0.66, hw];
    const colFn = (k, o) => {
      const i = ((k % n) + n) % n;
      const d = (o - shift[i]) / 2.6;
      const v = 1 - 0.16 * Math.exp(-d * d) - (Math.abs(o) > hw - 0.6 ? -0.04 : 0) + wobble[i];
      return [v, v, v];
    };
    const geo = ribbonStrip(c, 0, n, offs, offs.map(() => 0.03), (x, y) => W4(x, y), colFn, true);
    this.track(geo);
    const track = new THREE.Mesh(geo, this.matAsphaltTop);
    track.receiveShadow = true;
    this.group.add(track);
    // drift pad, paddock, road and the paddock exits
    const flat = (x0, y0, x1, y1, h, mat, uvScale = 4) => {
      const gb = new GB(true);
      gb.quad([[x0, h, -y0], [x1, h, -y0], [x1, h, -y1], [x0, h, -y1]], [0, 1, 0], [[x0 / uvScale, y0 / uvScale], [x1 / uvScale, y0 / uvScale], [x1 / uvScale, y1 / uvScale], [x0 / uvScale, y1 / uvScale]], [1, 1, 1]);
      const m = new THREE.Mesh(this.track(gb.build()), mat);
      m.receiveShadow = true; this.group.add(m);
      return m;
    };
    flat(L.pad.x0, L.pad.y0, L.pad.x1, L.pad.y1, 0.02, this.matAsphalt);
    flat(L.paddock.x0, L.paddock.y0, L.paddock.x1, L.paddock.y1, 0.025, this.matSlab, 5);
    for (const [x0, x1] of [[-222, -196], [86, 112]]) flat(x0, -235, x1, -213, 0.022, this.matSlab, 5);
    const rd = L.road;
    const rg = ribbonStrip(rd, 0, rd.n - 1, [-rd.half, 0, rd.half], [0.021, 0.021, 0.021], (x, y) => W4(x, y), () => [1, 1, 1]);
    const road = new THREE.Mesh(this.track(rg), this.matAsphalt); road.receiveShadow = true; this.group.add(road);
    // kerbs: raised, sloped strips with red and white paint
    const kerbRuns = (flags, side) => {
      const runs = [];
      let start = -1;
      for (let k = 0; k <= n; k++) {
        const on = k < n && flags[k];
        if (on && start < 0) start = k;
        if (!on && start >= 0) { runs.push([start, k]); start = -1; }
      }
      // merge a run that wraps past the spline origin
      if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === n) { const last = runs.pop(); runs[0] = [last[0], n + runs[0][1]]; }
      for (const [a, b] of runs) {
        const s = side;
        const offs2 = s > 0 ? [hw - 0.02, hw + 0.55, hw + 1.25, hw + 1.3] : [-(hw + 1.3), -(hw + 1.25), -(hw + 0.55), -hw + 0.02];
        const hs = s > 0 ? [0.03, 0.075, 0.06, 0.0] : [0.0, 0.06, 0.075, 0.03];
        const g2 = ribbonStrip(c, a, b, offs2, hs, (x, y, k, j) => [s > 0 ? j / 3 : 1 - j / 3, (k * c.ds) / 3], null);
        const m = new THREE.Mesh(this.track(g2), this.matKerb);
        m.receiveShadow = true; m.castShadow = false;
        this.group.add(m);
      }
    };
    kerbRuns(c.kerbL, 1); kerbRuns(c.kerbR, -1);
  }

  // ---------------------------------------------------------------- paint: edge lines, start line, grid, pad circles, logo
  buildMarkings() {
    const L = this.L, c = L.circuit, hw = TRACK_HALF;
    const lines = [];
    for (const s of [1, -1]) {
      const o0 = s * (hw - 0.45), o1 = s * (hw - 0.25);
      lines.push(ribbonStrip(c, 0, c.n, s > 0 ? [o0, o1] : [o1, o0], [0.035, 0.035], () => [0, 0], null));
    }
    // grid boxes behind the start line
    const gb = new GB();
    const at = (i, o) => [c.x[i] - c.ty[i] * o, c.y[i] + c.tx[i] * o];
    for (let k = 0; k < 10; k++) {
      const i = (L.iStart - 6 - k * 4 + c.n) % c.n;
      const side = k % 2 ? -1 : 1;
      const o0 = side * 1.0, o1 = side * (hw - 1.2);
      const p0 = at(i, o0), p1 = at(i, o1);
      const tx = c.tx[i], ty = c.ty[i];
      const w = 0.25;
      gb.quad([[p0[0], 0.036, -p0[1]], [p1[0], 0.036, -p1[1]], [p1[0] + tx * w, 0.036, -(p1[1] + ty * w)], [p0[0] + tx * w, 0.036, -(p0[1] + ty * w)]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    lines.push(gb.build());
    // drift pad: boundary line and skidpad rings
    const pad = new GB();
    const P = L.pad, inset = 0.8, lw = 0.22;
    const rect = (x0, y0, x1, y1) => pad.quad([[x0, 0.036, -y0], [x1, 0.036, -y0], [x1, 0.036, -y1], [x0, 0.036, -y1]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    rect(P.x0 + inset, P.y0 + inset, P.x1 - inset, P.y0 + inset + lw); rect(P.x0 + inset, P.y1 - inset - lw, P.x1 - inset, P.y1 - inset);
    rect(P.x0 + inset, P.y0 + inset, P.x0 + inset + lw, P.y1 - inset); rect(P.x1 - inset - lw, P.y0 + inset, P.x1 - inset, P.y1 - inset);
    for (const rg of L.rings) for (const r of [rg.r - 7, rg.r + 6]) {
      const seg = 96;
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
        const p = (a, rr) => [rg.x + Math.cos(a) * rr, 0.036, -(rg.y + Math.sin(a) * rr)];
        pad.quad([p(a0, r - lw / 2), p(a1, r - lw / 2), p(a1, r + lw / 2), p(a0, r + lw / 2)], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      }
    }
    lines.push(pad.build());
    for (const g of lines) { this.track(g); const m = new THREE.Mesh(g, this.matPaint); m.receiveShadow = true; this.group.add(m); }
    // chequered start/finish band
    {
        const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 64; const cx = cv.getContext('2d');
      for (let i = 0; i < 26; i++) for (let j = 0; j < 3; j++) { cx.fillStyle = (i + j) % 2 ? '#111' : '#eee'; cx.fillRect(i * 512 / 26, j * 64 / 3, 512 / 26 + 1, 64 / 3 + 1); }
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      const mat = this.track(new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
      const i = L.iStart;
      const g3 = new GB();
      const a0 = at(i, -hw), a1 = at(i, hw), tx = c.tx[i], ty = c.ty[i], w = 1.4;
      g3.quad([[a0[0], 0.037, -a0[1]], [a1[0], 0.037, -a1[1]], [a1[0] + tx * w, 0.037, -(a1[1] + ty * w)], [a0[0] + tx * w, 0.037, -(a0[1] + ty * w)]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      const m = new THREE.Mesh(this.track(g3.build()), mat); m.receiveShadow = true; this.group.add(m);
    }
    // old rubber on the drift pad
    {
      const tex = this.track(TX.padMarksTexture(P, L.rings));
      const mat = this.track(new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
      const g4 = new GB();
      g4.quad([[P.x0, 0.03, -P.y0], [P.x1, 0.03, -P.y0], [P.x1, 0.03, -P.y1], [P.x0, 0.03, -P.y1]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      const m = new THREE.Mesh(this.track(g4.build()), mat); m.receiveShadow = true; m.renderOrder = 1; this.group.add(m);
    }
    // painted logo on the pad
    {
      const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 256;
      const x = cv.getContext('2d');
      x.fillStyle = 'rgba(235,233,226,0.9)'; x.font = '800 190px "Chakra Petch", "Arial Narrow", Arial, sans-serif'; x.textBaseline = 'middle'; x.textAlign = 'center';
      x.fillText('PAKSWAP DRIFT PARK', 1024, 132);
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      const mat = this.track(new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
      const g5 = new GB();
      const cx = (P.x0 + P.x1) / 2, cy = P.y0 + 44, w = 96, h = 12;
      g5.quad([[cx - w / 2, 0.037, -(cy - h / 2)], [cx + w / 2, 0.037, -(cy - h / 2)], [cx + w / 2, 0.037, -(cy + h / 2)], [cx - w / 2, 0.037, -(cy + h / 2)]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      const m = new THREE.Mesh(this.track(g5.build()), mat); m.renderOrder = 2; m.receiveShadow = true; this.group.add(m);
    }
  }

  // ---------------------------------------------------------------- concrete walls with catch fences
  buildWalls() {
    const L = this.L;
    const gb = new GB();
    let s0 = 0;
    const box = (w) => {
      const dx = w.bx - w.ax, dy = w.by - w.ay, len = Math.hypot(dx, dy);
      if (len < 0.01) return;
      const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
      const t = w.t, h = w.h;
      const ax = w.ax - ux * t * 0.6, ay = w.ay - uy * t * 0.6, bx = w.bx + ux * t * 0.6, by = w.by + uy * t * 0.6;
      const L2 = len + t * 1.2;
      for (const sd of [1, -1]) {
        const ox = nx * t * sd, oy = ny * t * sd;
        gb.quad([[ax + ox, 0, -(ay + oy)], [bx + ox, 0, -(by + oy)], [bx + ox, h, -(by + oy)], [ax + ox, h, -(ay + oy)]], [nx * sd, 0, -ny * sd],
          [[s0 / 8, 1 - h / 2], [(s0 + L2) / 8, 1 - h / 2], [(s0 + L2) / 8, 1], [s0 / 8, 1]]);
      }
      gb.quad([[ax + nx * t, h, -(ay + ny * t)], [bx + nx * t, h, -(by + ny * t)], [bx - nx * t, h, -(by - ny * t)], [ax - nx * t, h, -(ay - ny * t)]], [0, 1, 0],
        [[s0 / 8, 0.99], [(s0 + L2) / 8, 0.99], [(s0 + L2) / 8, 0.97], [s0 / 8, 0.97]]);
      s0 += len;
    };
    for (const w of L.walls) if (w.kind === 'concrete' || w.kind === 'pitwall') box(w);
    const m = new THREE.Mesh(this.track(gb.build()), this.matWall);
    m.castShadow = true; m.receiveShadow = true;
    this.group.add(m);
    // catch fence on the grandstand wall: posts and a translucent mesh panel
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const x = cv.getContext('2d');
    x.strokeStyle = 'rgba(200,204,208,1)'; x.lineWidth = 3;
    x.beginPath(); x.moveTo(0, 0); x.lineTo(64, 64); x.moveTo(64, 0); x.lineTo(0, 64); x.stroke();
    const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const fm = this.track(new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity: 0.75, alphaTest: 0.05, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.6, depthWrite: false }));
    const fb = new GB();
    const pts = L.gWall;
    let sAcc = 0;
    const postPos = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      const nx = -(by - ay) / len, ny = (bx - ax) / len;
      fb.quad([[ax, 1.2, -ay], [bx, 1.2, -by], [bx, 4.6, -by], [ax, 4.6, -ay]], [nx, 0, -ny], [[sAcc / 0.45, 0], [(sAcc + len) / 0.45, 0], [(sAcc + len) / 0.45, 3.4 / 0.45], [sAcc / 0.45, 3.4 / 0.45]]);
      if (i % 2 === 0) postPos.push([ax, ay]);
      sAcc += len;
    }
    const fence = new THREE.Mesh(this.track(fb.build()), fm); fence.renderOrder = 3; this.group.add(fence);
    const pg = this.track(new THREE.CylinderGeometry(0.06, 0.06, 4.6, 6)); pg.translate(0, 2.3, 0);
    const posts = new THREE.InstancedMesh(pg, this.matMetal, postPos.length);
    const M = new THREE.Matrix4();
    postPos.forEach(([px, py], i) => { M.makeTranslation(px, 0, -py); posts.setMatrixAt(i, M); });
    posts.castShadow = true; this.group.add(posts);
  }

  // ---------------------------------------------------------------- tyre walls (two rows of stacks, some painted)
  buildTyreWalls() {
    const L = this.L;
    const tex = this.track(TX.tyreStackTexture());
    const mat = this.track(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 }));
    const g = this.track(new THREE.CylinderGeometry(0.31, 0.31, 0.95, 12, 1));
    g.translate(0, 0.475, 0);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1), P = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const R = rng(9);
    const paint = [new THREE.Color('#e9e7e1'), new THREE.Color('#b81c18'), new THREE.Color('#1d4fa0')];
    const black = new THREE.Color('#2a2a2a');
    const rows = this.q === 'low' ? [0.3] : [0.3, -0.32];
    const addRun = (pts, openSign) => {
      const items = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.01) continue;
        const ux = (bx - ax) / len, uy = (by - ay) / len, nx = -uy * openSign, ny = ux * openSign;
        for (let s = 0; s < len; s += 0.63) for (const off of rows) items.push([ax + ux * s + nx * off, ay + uy * s + ny * off, off > 0]);
      }
      const im = new THREE.InstancedMesh(g, mat, items.length);
      items.forEach(([x, y, front], k) => {
        Q.setFromAxisAngle(up, R() * Math.PI * 2);
        P.set(x, 0, -y);
        M.compose(P, Q, S);
        im.setMatrixAt(k, M);
        im.setColorAt(k, front && k % 5 === 0 ? paint[(k / 5) % 3 | 0] : black);
      });
      im.castShadow = true; im.receiveShadow = true;
      im.computeBoundingSphere();
      this.group.add(im);
    };
    for (const br of L.barrierRuns) addRun(br.pts, br.side === 1 ? -1 : 1);
    // tyre-stack islands on the drift pad
    const isl = [];
    for (const [x, y] of L.islands) for (const [r, nn] of [[0, 1], [0.62, 6], [1.24, 12]]) for (let k = 0; k < nn; k++) { const a = (k / nn) * Math.PI * 2; isl.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); }
    const im = new THREE.InstancedMesh(g, mat, isl.length);
    isl.forEach(([x, y], k) => { Q.setFromAxisAngle(up, R() * 6.28); P.set(x, 0, -y); M.compose(P, Q, S); im.setMatrixAt(k, M); im.setColorAt(k, k % 3 === 0 ? paint[0] : black); });
    im.castShadow = true; im.receiveShadow = true;
    this.group.add(im);
  }

  // ---------------------------------------------------------------- paddock garages
  buildBuildings() {
    const L = this.L;
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 448;
    const x = cv.getContext('2d');
    // one 10 m bay: concrete frame, roller door, glazing above
    x.fillStyle = '#c9c6bf'; x.fillRect(0, 0, 512, 448);
    x.fillStyle = '#b5b2ab'; x.fillRect(0, 0, 26, 448); x.fillRect(486, 0, 26, 448);
    const dg = x.createLinearGradient(0, 0, 0, 220); dg.addColorStop(0, '#2b3442'); dg.addColorStop(1, '#151a22');
    x.fillStyle = dg; x.fillRect(40, 30, 432, 120);
    x.strokeStyle = '#8d9096'; x.lineWidth = 4; for (let i = 0; i <= 4; i++) { x.beginPath(); x.moveTo(40 + i * 108, 30); x.lineTo(40 + i * 108, 150); x.stroke(); }
    x.fillStyle = 'rgba(255,255,255,0.06)'; x.beginPath(); x.moveTo(60, 30); x.lineTo(160, 30); x.lineTo(90, 150); x.lineTo(40, 150); x.fill();
    x.fillStyle = '#0e5a35'; x.fillRect(26, 172, 460, 30);
    x.fillStyle = '#9fa2a6'; x.fillRect(66, 218, 380, 230);
    for (let i = 0; i < 46; i++) { x.fillStyle = i % 2 ? '#8b8e93' : '#b0b3b7'; x.fillRect(66, 218 + i * 5, 380, 2); }
    x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(66, 440, 380, 8);
    const facade = new THREE.CanvasTexture(cv); facade.colorSpace = THREE.SRGBColorSpace; facade.wrapS = THREE.RepeatWrapping; facade.anisotropy = 8;
    const fMat = this.track(new THREE.MeshStandardMaterial({ map: facade, roughness: 0.6, metalness: 0.15 }));
    const roofMat = this.track(new THREE.MeshStandardMaterial({ color: '#53575c', roughness: 0.9 }));
    for (const gr of L.garages) {
      const h = 8.5;
      const front = new GB(), rest = new GB(), roof = new GB();
      const { x0, x1, y0, y1 } = gr;
      const w = x1 - x0;
      front.quad([[x0, 0, -y0], [x1, 0, -y0], [x1, h, -y0], [x0, h, -y0]], [0, 0, 1], [[0, 0], [w / 10, 0], [w / 10, 1], [0, 1]]);
      rest.quad([[x0, 0, -y1], [x1, 0, -y1], [x1, h, -y1], [x0, h, -y1]], [0, 0, -1], [[0, 0], [w / 8, 0], [w / 8, h / 8], [0, h / 8]]);
      rest.quad([[x0, 0, -y0], [x0, 0, -y1], [x0, h, -y1], [x0, h, -y0]], [-1, 0, 0], [[0, 0], [2, 0], [2, 1], [0, 1]]);
      rest.quad([[x1, 0, -y0], [x1, 0, -y1], [x1, h, -y1], [x1, h, -y0]], [1, 0, 0], [[0, 0], [2, 0], [2, 1], [0, 1]]);
      roof.quad([[x0, h, -y0], [x1, h, -y0], [x1, h, -y1], [x0, h, -y1]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      // parapet
      roof.quad([[x0, h, -y0 + 0.01], [x1, h, -y0 + 0.01], [x1, h + 0.9, -y0 + 0.01], [x0, h + 0.9, -y0 + 0.01]], [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      for (const [gg, mm] of [[front, fMat], [rest, this.matConcrete], [roof, roofMat]]) {
        const m = new THREE.Mesh(this.track(gg.build()), mm); m.castShadow = true; m.receiveShadow = true; this.group.add(m);
      }
      // canopy over the doors
      const can = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, 0.25, 3.2)), this.matDarkMetal);
      can.position.set((x0 + x1) / 2, 5.0, -(y0 - 1.6)); can.castShadow = true; can.receiveShadow = true; this.group.add(can);
    }
    // a banner across the garage roofs
    const bc = document.createElement('canvas'); bc.width = 2048; bc.height = 160;
    const bx = bc.getContext('2d');
    bx.fillStyle = '#121417'; bx.fillRect(0, 0, 2048, 160);
    bx.fillStyle = '#f5b301'; bx.fillRect(0, 140, 2048, 20);
    bx.fillStyle = '#f2f0ea'; bx.font = '800 96px "Chakra Petch", "Arial Narrow", Arial, sans-serif'; bx.textBaseline = 'middle';
    bx.fillText('PAKSWAP DRIFT PARK', 60, 74);
    bx.fillStyle = '#9aa0a6'; bx.font = '600 48px "Archivo", Arial, sans-serif'; bx.textAlign = 'right'; bx.fillText('PADDOCK  ·  PIT LANE  ·  DRIFT PAD', 1990, 78);
    const bt = new THREE.CanvasTexture(bc); bt.colorSpace = THREE.SRGBColorSpace; bt.anisotropy = 8;
    const bm = this.track(new THREE.MeshStandardMaterial({ map: bt, roughness: 0.5, emissive: '#ffffff', emissiveMap: bt, emissiveIntensity: 0 }));
    this.bannerMat = bm;
    const g0 = L.garages[0];
    const banner = new THREE.Mesh(this.track(new THREE.PlaneGeometry(52, 4)), bm);
    banner.position.set(g0.x0 + 40, 11.3, -(g0.y0 - 0.05));
    this.group.add(banner);
  }

  // ---------------------------------------------------------------- grandstand facing the main straight
  buildGrandstand() {
    const pts = this.L.stand.a;
    if (pts.length < 2) return;
    const xa = Math.min(pts[0][0], pts[pts.length - 1][0]), xb = Math.max(pts[0][0], pts[pts.length - 1][0]);
    const yF = pts.reduce((s, p) => s + p[1], 0) / pts.length; // front edge (north side of the stand)
    const tiers = 10, depth = 0.85, rise = 0.42, base = 1.6;
    const gb = new GB();
    for (let k = 0; k < tiers; k++) {
      const y0 = yF - k * depth, y1 = y0 - depth, h0 = base + k * rise, h1 = h0 + rise;
      // riser (faces north) and tread
      gb.quad([[xa, h0, -y0], [xb, h0, -y0], [xb, h1, -y0], [xa, h1, -y0]], [0, 0, -1], [[xa / 8, h0 / 8], [xb / 8, h0 / 8], [xb / 8, h1 / 8], [xa / 8, h1 / 8]]);
      gb.quad([[xa, h1, -y0], [xb, h1, -y0], [xb, h1, -y1], [xa, h1, -y1]], [0, 1, 0], [[xa / 8, y0 / 8], [xb / 8, y0 / 8], [xb / 8, y1 / 8], [xa / 8, y1 / 8]]);
    }
    const yBack = yF - tiers * depth, hTop = base + tiers * rise;
    gb.quad([[xa, 0, -yF], [xb, 0, -yF], [xb, base, -yF], [xa, base, -yF]], [0, 0, -1], [[0, 0], [1, 0], [1, 0.2], [0, 0.2]]);
    gb.quad([[xa, 0, -yBack], [xb, 0, -yBack], [xb, hTop + 3.2, -yBack], [xa, hTop + 3.2, -yBack]], [0, 0, 1], [[0, 0], [(xb - xa) / 8, 0], [(xb - xa) / 8, 1], [0, 1]]);
    for (const xe of [xa, xb]) gb.quad([[xe, 0, -yF], [xe, 0, -yBack], [xe, hTop + 3.2, -yBack], [xe, base, -yF]], [xe === xa ? -1 : 1, 0, 0], [[0, 0], [1, 0], [1, 1], [0, 0.2]]);
    const stand = new THREE.Mesh(this.track(gb.build()), this.matConcrete);
    stand.castShadow = true; stand.receiveShadow = true;
    this.group.add(stand);
    // roof on columns
    const roofMat = this.track(new THREE.MeshStandardMaterial({ color: '#d9dcdf', roughness: 0.4, metalness: 0.6, side: THREE.DoubleSide }));
    const roof = new THREE.Mesh(this.track(new THREE.BoxGeometry(xb - xa + 4, 0.3, tiers * depth + 4)), roofMat);
    roof.position.set((xa + xb) / 2, hTop + 3.4, -(yF - (tiers * depth) / 2 + 1.5));
    roof.rotation.x = -0.06;
    roof.castShadow = true; roof.receiveShadow = true;
    this.group.add(roof);
    const colG = this.track(new THREE.CylinderGeometry(0.22, 0.22, hTop + 3.4, 8)); colG.translate(0, (hTop + 3.4) / 2, 0);
    const nCol = Math.floor((xb - xa) / 15) + 1;
    const cols = new THREE.InstancedMesh(colG, this.matMetal, nCol);
    const M = new THREE.Matrix4();
    for (let i = 0; i < nCol; i++) { M.makeTranslation(xa + i * 15, 0, -(yBack + 0.4)); cols.setMatrixAt(i, M); }
    cols.castShadow = true; this.group.add(cols);
    // seats in Pakistan green and white blocks
    if (this.q !== 'low') {
      const sg = this.track(new THREE.BoxGeometry(0.46, 0.42, 0.44)); sg.translate(0, 0.21, 0);
      const seatMat = this.track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55 }));
      const items = [];
      for (let k = 0; k < tiers; k++) for (let xx = xa + 1; xx < xb - 1; xx += 0.56) { if (((xx - xa) % 36) < 1.5) continue; items.push([xx, base + (k + 1) * rise, yF - k * depth - depth * 0.62, Math.floor((xx - xa) / 36) % 2]); }
      const seats = new THREE.InstancedMesh(sg, seatMat, items.length);
      const green = new THREE.Color('#0d6a3b'), white = new THREE.Color('#e9e8e2');
      items.forEach(([sx, sh, sy, w], i) => { M.makeTranslation(sx, sh, -sy); seats.setMatrixAt(i, M); seats.setColorAt(i, w ? white : green); });
      seats.receiveShadow = true;
      this.group.add(seats);
    }
  }

  // ---------------------------------------------------------------- start/finish gantry
  buildGantry() {
    const G = this.L.gantry;
    const span = G.span + 1, h = 6.4;
    const grp = new THREE.Group();
    const leg = this.track(new THREE.BoxGeometry(0.7, h + 1.3, 0.7));
    for (const s of [1, -1]) { const m = new THREE.Mesh(leg, this.matDarkMetal); m.position.set(0, (h + 1.3) / 2, s * (span / 2)); grp.add(m); }
    const beam = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.1, 1.3, span + 0.7)), this.matDarkMetal);
    beam.position.set(0, h + 0.65, 0); grp.add(beam);
    // light board facing the grid and a sign facing the finish
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 128;
    const x = cv.getContext('2d');
    x.fillStyle = '#0b0c0e'; x.fillRect(0, 0, 1024, 128);
    x.fillStyle = '#f2f0ea'; x.font = '800 74px "Chakra Petch", "Arial Narrow", Arial, sans-serif'; x.textBaseline = 'middle'; x.textAlign = 'center';
    x.fillText('START  ·  FINISH', 512, 66);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const signMat = this.track(new THREE.MeshStandardMaterial({ map: t, emissive: '#ffffff', emissiveMap: t, emissiveIntensity: 0.25, roughness: 0.4 }));
    const sign = new THREE.Mesh(this.track(new THREE.PlaneGeometry(span * 0.8, span * 0.1)), signMat);
    sign.position.set(0.56, h + 0.65, 0); sign.rotation.y = Math.PI / 2; grp.add(sign);
    const sign2 = sign.clone(); sign2.position.x = -0.56; sign2.rotation.y = -Math.PI / 2; grp.add(sign2);
    this.startLights = [];
    for (let k = 0; k < 5; k++) {
      const lm = this.track(new THREE.MeshStandardMaterial({ color: '#220000', emissive: '#ff2a1a', emissiveIntensity: 0, roughness: 0.3 }));
      const l = new THREE.Mesh(this.track(new THREE.CircleGeometry(0.22, 16)), lm);
      l.position.set(-0.57, h - 0.25, (k - 2) * 0.8); l.rotation.y = -Math.PI / 2;
      grp.add(l); this.startLights.push(lm);
    }
    grp.position.set(G.x, 0, -G.y);
    grp.rotation.y = Math.atan2(G.ty, G.tx);
    setShadows(grp, true, true);
    this.group.add(grp);
  }

  // ---------------------------------------------------------------- floodlights (heads glow at night, fake light pools)
  buildLights() {
    const L = this.L;
    const towers = L.lamps;
    const poleG = this.track(new THREE.CylinderGeometry(0.16, 0.26, 1, 8)); poleG.translate(0, 0.5, 0);
    const poles = new THREE.InstancedMesh(poleG, this.matMetal, towers.length);
    const headG = this.track(new THREE.BoxGeometry(1, 1, 1));
    this.headMat = this.track(new THREE.MeshStandardMaterial({ color: '#d8d8d2', emissive: '#fff4e0', emissiveIntensity: 0, roughness: 0.3 }));
    const heads = new THREE.InstancedMesh(headG, this.headMat, towers.length);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3();
    const e = new THREE.Euler();
    this.lampHeads = [];
    towers.forEach((l, i) => {
      M.compose(P.set(l.x, 0, -l.y), Q.identity(), S.set(l.kind === 'tower' ? 1.6 : 1, l.h, l.kind === 'tower' ? 1.6 : 1));
      poles.setMatrixAt(i, M);
      const ang = Math.atan2(l.aim[1] - l.y, l.aim[0] - l.x);
      e.set(0, ang, 0.35);
      Q.setFromEuler(e);
      M.compose(P.set(l.x, l.h, -l.y), Q, S.set(l.kind === 'tower' ? 1.2 : 0.7, l.kind === 'tower' ? 0.5 : 0.3, l.kind === 'tower' ? 3.4 : 1.4));
      heads.setMatrixAt(i, M);
      this.lampHeads.push(new THREE.Vector3(l.x, l.h - 0.6, -l.y));
    });
    poles.castShadow = true; heads.castShadow = true;
    this.group.add(poles, heads);
    // pools of light on the ground (night only)
    const glow = this.track(TX.glowTexture('rgba(255,226,180,1)', 'rgba(255,210,160,0)'));
    const pm = this.track(new THREE.MeshBasicMaterial({ map: glow, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.32, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, toneMapped: true }));
    const pg = this.track(new THREE.PlaneGeometry(1, 1)); pg.rotateX(-Math.PI / 2);
    const pools = new THREE.InstancedMesh(pg, pm, towers.length);
    towers.forEach((l, i) => {
      const ax = l.x + (l.aim[0] - l.x) * (l.kind === 'tower' ? 0.3 : 0.55), ay = l.y + (l.aim[1] - l.y) * (l.kind === 'tower' ? 0.3 : 0.55);
      const r = l.kind === 'tower' ? 70 : 34;
      M.compose(P.set(ax, 0.05, -ay), Q.identity(), S.set(r, 1, r));
      pools.setMatrixAt(i, M);
    });
    pools.renderOrder = 4;
    this.pools = pools;
    this.group.add(pools);
    // a few real lights travel to the lamps nearest the car at night
    this.nightLights = [];
    for (let k = 0; k < 4; k++) { const pl = new THREE.PointLight('#ffe6c4', 0, 75, 1.6); this.nightLights.push(pl); this.group.add(pl); }
  }

  // ---------------------------------------------------------------- billboards and brake boards
  buildBoards() {
    const L = this.L;
    const texts = [...new Set(L.boards.map((b) => b.text))];
    const atlas = TX.billboardAtlas(texts);
    this.track(atlas.tex);
    const faceMat = this.track(new THREE.MeshStandardMaterial({ map: atlas.tex, roughness: 0.55, emissive: '#ffffff', emissiveMap: atlas.tex, emissiveIntensity: 0 }));
    this.boardMat = faceMat;
    const face = new GB(), back = new GB();
    const postItems = [];
    for (const b of L.boards) {
      const i = texts.indexOf(b.text);
      const [u0, v0, u1, v1] = atlas.uv(i);
      const fx = b.dx, fy = b.dy; // facing direction (towards the track)
      const rx = fy, ry = -fx; // right along the board as seen from the track
      const y0 = 1.3, y1 = y0 + b.h, hw = b.w / 2, d = 0.12;
      const cx = b.x + fx * d, cy = b.y + fy * d;
      face.quad([[cx - rx * hw, y0, -(cy - ry * hw)], [cx + rx * hw, y0, -(cy + ry * hw)], [cx + rx * hw, y1, -(cy + ry * hw)], [cx - rx * hw, y1, -(cy - ry * hw)]], [fx, 0, -fy], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
      const bx = b.x - fx * d, by = b.y - fy * d;
      back.quad([[bx - rx * hw, y0, -(by - ry * hw)], [bx + rx * hw, y0, -(by + ry * hw)], [bx + rx * hw, y1, -(by + ry * hw)], [bx - rx * hw, y1, -(by - ry * hw)]], [-fx, 0, fy], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      for (const s of [-1, 1]) back.quad([[cx + s * rx * hw, y0, -(cy + s * ry * hw)], [bx + s * rx * hw, y0, -(by + s * ry * hw)], [bx + s * rx * hw, y1, -(by + s * ry * hw)], [cx + s * rx * hw, y1, -(cy + s * ry * hw)]], [s * rx, 0, -s * ry], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      back.quad([[cx - rx * hw, y1, -(cy - ry * hw)], [cx + rx * hw, y1, -(cy + ry * hw)], [bx + rx * hw, y1, -(by + ry * hw)], [bx - rx * hw, y1, -(by - ry * hw)]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      postItems.push([b.x - rx * (hw - 1), b.y - ry * (hw - 1)], [b.x + rx * (hw - 1), b.y + ry * (hw - 1)]);
    }
    const fm = new THREE.Mesh(this.track(face.build()), faceMat); fm.castShadow = true; fm.receiveShadow = true;
    const bm = new THREE.Mesh(this.track(back.build()), this.matDarkMetal); bm.castShadow = true; bm.receiveShadow = true;
    this.group.add(fm, bm);
    const pg = this.track(new THREE.CylinderGeometry(0.1, 0.1, 1.4, 6)); pg.translate(0, 0.7, 0);
    const posts = new THREE.InstancedMesh(pg, this.matMetal, postItems.length);
    const M = new THREE.Matrix4();
    postItems.forEach(([x, y], i) => { M.makeTranslation(x, 0, -y); posts.setMatrixAt(i, M); });
    posts.castShadow = true; this.group.add(posts);
    // brake boards before turn 1 (300, 200, 100 m)
    const c = L.circuit;
    const iT1 = Math.round(475 / c.ds);
    const bbG = new GB();
    const cv = document.createElement('canvas'); cv.width = 768; cv.height = 256;
    const x = cv.getContext('2d');
    ['300', '200', '100'].forEach((t, k) => { x.fillStyle = '#f2f0ea'; x.fillRect(k * 256, 0, 256, 256); x.strokeStyle = '#111'; x.lineWidth = 14; x.strokeRect(k * 256 + 10, 10, 236, 236); x.fillStyle = '#111'; x.font = '800 120px "Chakra Petch", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(t, k * 256 + 128, 134); });
    const bt = new THREE.CanvasTexture(cv); bt.colorSpace = THREE.SRGBColorSpace;
    const bbm = this.track(new THREE.MeshStandardMaterial({ map: bt, roughness: 0.6 }));
    [300, 200, 100].forEach((d, k) => {
      const i = iT1 - Math.round(d / c.ds);
      const o = TRACK_HALF + 3.5; // right side (outside of turn 1, which goes left)
      const px = c.x[i] + c.ty[i] * o, py = c.y[i] - c.tx[i] * o;
      const fx = -c.tx[i], fy = -c.ty[i]; // facing oncoming cars
      const rx = fy, ry = -fx, hw = 0.6;
      bbG.quad([[px - rx * hw, 0.4, -(py - ry * hw)], [px + rx * hw, 0.4, -(py + ry * hw)], [px + rx * hw, 1.6, -(py + ry * hw)], [px - rx * hw, 1.6, -(py - ry * hw)]], [fx, 0, -fy], [[k / 3, 0], [(k + 1) / 3, 0], [(k + 1) / 3, 1], [k / 3, 1]]);
    });
    const bb = new THREE.Mesh(this.track(bbG.build()), bbm); bb.castShadow = true; this.group.add(bb);
  }

  // ---------------------------------------------------------------- Pakistan flags, gently waving
  buildFlags() {
    const L = this.L;
    const tex = this.track(TX.flagTexture());
    const mat = this.track(new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.75 }));
    const uTime = this.uTime;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace('#include <begin_vertex>', `#include <begin_vertex>
        float k = uv.x;
        float ph = position.x * 2.4 - uTime * 6.0 + instanceMatrix[3][0] * 0.3;
        transformed.z += sin(ph) * 0.16 * k + sin(ph * 2.3 + 1.0) * 0.05 * k;
        transformed.y -= k * k * 0.12;`);
    };
    const fg = this.track(new THREE.PlaneGeometry(2.4, 1.6, 16, 6)); fg.translate(1.2, -0.8, 0);
    const flags = new THREE.InstancedMesh(fg, mat, L.flags.length);
    const pg = this.track(new THREE.CylinderGeometry(0.05, 0.07, 1, 6)); pg.translate(0, 0.5, 0);
    const poles = new THREE.InstancedMesh(pg, this.matMetal, L.flags.length);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3();
    const wind = 0.5; // flags stream toward the east-north-east
    L.flags.forEach((f, i) => {
      M.compose(P.set(f.x, 0, -f.y), Q.identity(), S.set(1, f.h, 1)); poles.setMatrixAt(i, M);
      Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), wind);
      M.compose(P.set(f.x, f.h - 0.1, -f.y), Q, S.set(1, 1, 1)); flags.setMatrixAt(i, M);
    });
    flags.castShadow = true; poles.castShadow = true;
    this.group.add(flags, poles);
  }

  // ---------------------------------------------------------------- trees: card crowns with leaf textures
  buildTrees() {
    const L = this.L, R = rng(31);
    const bark = this.track(TX.barkTexture());
    const trunkMat = this.track(new THREE.MeshStandardMaterial({ map: bark, roughness: 0.95 }));
    const leafB = this.track(TX.leafTexture('broad')), leafN = this.track(TX.leafTexture('narrow'));
    const crownMat = (tex) => this.track(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.82, metalness: 0 }));
    const mB = crownMat(leafB), mN = crownMat(leafN);
    // crown geometry: crossed cards with normals bent outward from the crown centre
    const crown = (w, h, cy, cards, tilt) => {
      const gb = new GB();
      for (let k = 0; k < cards; k++) {
        const a = (k / cards) * Math.PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        const t = (k % 2 ? 1 : -1) * tilt;
        const P = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => {
          const y = cy + v * Math.cos(t), d = v * Math.sin(t);
          return [ca * u - sa * d, y, sa * u + ca * d];
        });
        const ids = P.map((p, i) => {
          const nx = p[0], ny = (p[1] - cy) * 0.8 + h * 0.15, nz = p[2], l = Math.hypot(nx, ny, nz) || 1;
          return gb.v(p[0], p[1], p[2], nx / l, ny / l, nz / l, i === 0 || i === 3 ? 0 : 1, i < 2 ? 0 : 1);
        });
        gb.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
      }
      return gb.build();
    };
    const kinds = {
      round: { crown: this.track(crown(7.2, 6.2, 6.3, 5, 0.5)), trunkH: 3.6, trunkR: 0.24, mat: mB },
      poplar: { crown: this.track(crown(3.2, 12.5, 8.6, 4, 0.12)), trunkH: 2.6, trunkR: 0.17, mat: mN },
      palm: { crown: this.track(crown(5.2, 3.2, 8.6, 6, 1.1)), trunkH: 8.2, trunkR: 0.2, mat: mN },
    };
    const trees = this.q === 'low' ? L.trees.filter((t, i) => t.inside || i % 3 === 0) : L.trees;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    for (const [name, K] of Object.entries(kinds)) {
      const list = trees.filter((t) => t.kind === name);
      if (!list.length) continue;
      const tg = this.track(new THREE.CylinderGeometry(K.trunkR * 0.7, K.trunkR, K.trunkH + 1, 7)); tg.translate(0, (K.trunkH + 1) / 2, 0);
      const trunks = new THREE.InstancedMesh(tg, trunkMat, list.length);
      const crowns = new THREE.InstancedMesh(K.crown, K.mat, list.length);
      list.forEach((t, i) => {
        Q.setFromAxisAngle(up, R() * Math.PI * 2);
        const s = t.s;
        M.compose(P.set(t.x, 0, -t.y), Q, S.set(s, s * (0.9 + R() * 0.25), s));
        trunks.setMatrixAt(i, M); crowns.setMatrixAt(i, M);
        const hue = 0.24 + (R() - 0.5) * 0.05, light = 0.82 + R() * 0.3;
        col.setHSL(hue, 0.25, 0.5).multiplyScalar(light * 1.6);
        crowns.setColorAt(i, col);
      });
      trunks.castShadow = true; trunks.receiveShadow = true;
      crowns.castShadow = true; crowns.receiveShadow = true;
      this.group.add(trunks, crowns);
    }
  }

  // ---------------------------------------------------------------- cones (instanced, knocked over by the car)
  buildCones() {
    const L = this.L;
    const base = new THREE.BoxGeometry(0.4, 0.035, 0.4); base.translate(0, 0.0175, 0);
    const cone = new THREE.CylinderGeometry(0.03, 0.15, 0.56, 16, 4, true); cone.translate(0, 0.31, 0);
    const paint = (g, fn) => { const p = g.getAttribute('position'); const c = []; for (let i = 0; i < p.count; i++) c.push(...fn(p.getY(i))); g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3)); };
    const orange = [1, 0.32, 0.04], white = [0.95, 0.95, 0.95];
    paint(base, () => orange);
    paint(cone, (y) => (y > 0.3 && y < 0.42 ? white : orange));
    const merged = new GB();
    void merged;
    const geos = [base.toNonIndexed(), cone.toNonIndexed()];
    const pos = [], nor = [], colr = [];
    for (const g of geos) { pos.push(...g.getAttribute('position').array); nor.push(...g.getAttribute('normal').array); colr.push(...g.getAttribute('color').array); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    base.dispose(); cone.dispose(); geos.forEach((x) => x.dispose());
    this.track(g);
    const mat = this.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }));
    this.cones = new THREE.InstancedMesh(g, mat, L.cones.length);
    this.cones.castShadow = true; this.cones.receiveShadow = true;
    this.cones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cones.frustumCulled = false;
    this.group.add(this.cones);
    this.coneM = new THREE.Matrix4(); this.coneQ = new THREE.Quaternion(); this.coneQ2 = new THREE.Quaternion(); this.coneP = new THREE.Vector3(); this.coneS = new THREE.Vector3(1, 1, 1);
  }

  syncCones(list) {
    const M = this.coneM, Q = this.coneQ, Q2 = this.coneQ2, P = this.coneP;
    const up = new THREE.Vector3(0, 1, 0), ax = new THREE.Vector3();
    list.forEach((c, i) => {
      Q.setFromAxisAngle(up, c.yaw);
      if (c.tip > 0) {
        // fall over sideways, away from the hit
        ax.set(-Math.sin(c.tipDir), 0, -Math.cos(c.tipDir));
        Q2.setFromAxisAngle(ax, -c.tip);
        Q.premultiply(Q2);
      }
      P.set(c.x, c.z + Math.sin(c.tip) * 0.15, -c.y);
      M.compose(P, Q, this.coneS);
      this.cones.setMatrixAt(i, M);
    });
    this.cones.instanceMatrix.needsUpdate = true;
  }

  setNight(on) {
    this.night = on;
    this.headMat.emissiveIntensity = on ? 9 : 0;
    this.pools.visible = on;
    if (this.boardMat) this.boardMat.emissiveIntensity = on ? 0.42 : 0;
    if (this.bannerMat) this.bannerMat.emissiveIntensity = on ? 0.6 : 0;
    for (const l of this.nightLights) l.intensity = 0;
  }

  // night: move the few real lights to the lamps nearest the car, fading by distance
  update(dt, carX, carZ) {
    this.uTime.value += dt;
    if (!this.night) return;
    const near = this.lampHeads.map((p, i) => [i, (p.x - carX) ** 2 + (p.z - carZ) ** 2]).sort((a, b) => a[1] - b[1]).slice(0, this.nightLights.length);
    near.forEach(([i, d2], k) => {
      const pl = this.nightLights[k];
      pl.position.copy(this.lampHeads[i]);
      const d = Math.sqrt(d2);
      pl.intensity = 560 * Math.max(0, 1 - d / 90);
      pl.distance = 80;
    });
  }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
    this.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    this.disposables = [];
  }
}
