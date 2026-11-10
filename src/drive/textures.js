// Procedural, tileable textures for the drive world: asphalt, grass, gravel, concrete, kerbs,
// tyre walls, bark, leaves, billboards, the Pakistan flag, smoke and light pools.
// Everything is generated at runtime, so the app stays a single offline file.
import * as THREE from 'three';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// tileable value noise on a lattice of `cells` x `cells`
function valueNoise(size, cells, R) {
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = R();
  const out = new Float32Array(size * size);
  const k = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * k, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % cells) * cells, r1 = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const fx = x * k, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
      const c0 = x0 % cells, c1 = (x0 + 1) % cells;
      const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
      const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
      out[y * size + x] = a + (b - a) * sy;
    }
  }
  return out;
}

function fbm(size, baseCells, octaves, seed, gain = 0.5) {
  const R = rng(seed);
  const out = new Float32Array(size * size);
  let amp = 1, tot = 0, cells = baseCells;
  for (let o = 0; o < octaves && cells <= size; o++) {
    const n = valueNoise(size, cells, R);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    tot += amp; amp *= gain; cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

function dataTex(data, size, srgb, repeat = true) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// normal map (tangent space) from a tileable height field
function normalFromHeight(h, size, strength) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const xl = (x - 1 + size) % size, xr = (x + 1) % size, yu = (y - 1 + size) % size, yd = (y + 1) % size;
    const dx = (h[y * size + xr] - h[y * size + xl]) * strength;
    const dy = (h[yd * size + x] - h[yu * size + x]) * strength;
    const l = Math.hypot(dx, dy, 1);
    const o = (y * size + x) * 4;
    out[o] = ((-dx / l) * 0.5 + 0.5) * 255; out[o + 1] = ((dy / l) * 0.5 + 0.5) * 255; out[o + 2] = ((1 / l) * 0.5 + 0.5) * 255; out[o + 3] = 255;
  }
  return out;
}

function canvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}
function canvasTex(c, srgb = true, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------- asphalt (4 m tile)
export function asphaltTextures(size = 1024) {
  const R = rng(7);
  const low = fbm(size, 4, 4, 11);
  const mid = fbm(size, 32, 3, 12);
  const h = new Float32Array(size * size);
  const col = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) { col[i] = 0.25 + (low[i] - 0.5) * 0.07 + (mid[i] - 0.5) * 0.05; h[i] = mid[i] * 0.3; }
  // aggregate: light stones, dark binder pits
  const stones = Math.round(size * size * 0.055);
  for (let k = 0; k < stones; k++) {
    const x = R() * size, y = R() * size, r = 0.6 + R() * R() * 2.6;
    const bright = R();
    const v = bright < 0.18 ? 0.14 : bright < 0.8 ? 0.28 + R() * 0.09 : 0.38 + R() * 0.09;
    const hh = bright < 0.18 ? -0.6 : 0.45 + R() * 0.5;
    const ri = Math.ceil(r);
    for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
      const d = Math.hypot(dx, dy) / r;
      if (d > 1) continue;
      const px = (Math.floor(x) + dx + size) % size, py = (Math.floor(y) + dy + size) % size;
      const o = py * size + px, w = 1 - d * d;
      col[o] = col[o] * (1 - w * 0.85) + v * w * 0.85;
      h[o] = Math.max(h[o], hh * w);
    }
  }
  // a few sealed cracks
  for (let k = 0; k < 2; k++) {
    let x = R() * size, y = R() * size, a = R() * Math.PI * 2;
    const len = 60 + R() * 160;
    for (let s = 0; s < len; s++) {
      a += (R() - 0.5) * 0.5; x += Math.cos(a); y += Math.sin(a);
      for (let w = 0; w <= 1; w++) { const px = (Math.floor(x + w * Math.sin(a)) % size + size) % size, py = (Math.floor(y - w * Math.cos(a)) % size + size) % size; const o = py * size + px; col[o] *= 0.78; h[o] = -0.12; }
    }
  }
  const alb = new Uint8Array(size * size * 4), rough = new Uint8Array(size * size * 4);
  for (let i = 0; i < col.length; i++) {
    const v = Math.max(0, Math.min(1, col[i]));
    alb[i * 4] = v * 255 * 0.98; alb[i * 4 + 1] = v * 255; alb[i * 4 + 2] = v * 255 * 1.03; alb[i * 4 + 3] = 255;
    const rr = 0.78 + (1 - mid[i]) * 0.18;
    rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = rr * 255; rough[i * 4 + 3] = 255;
  }
  return { map: dataTex(alb, size, true), normalMap: dataTex(normalFromHeight(h, size, 2.2), size, false), roughnessMap: dataTex(rough, size, false) };
}

// ---------------------------------------------------------------- grass detail (3 m tile) and gravel (2 m tile)
export function grassTextures(size = 1024) {
  const R = rng(21);
  const [c, x] = canvas(size, size);
  const base = fbm(size, 8, 4, 31);
  const img = x.createImageData(size, size);
  for (let i = 0; i < base.length; i++) {
    const v = base[i];
    img.data[i * 4] = 80 + v * 34; img.data[i * 4 + 1] = 88 + v * 36; img.data[i * 4 + 2] = 50 + v * 18; img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  // blades: thousands of short strokes, drawn three times shifted so the tile wraps
  x.lineCap = 'round';
  const blades = Math.round(size * size * 0.045);
  for (let k = 0; k < blades; k++) {
    const px = R() * size, py = R() * size, len = 3 + R() * 9, a = -Math.PI / 2 + (R() - 0.5) * 1.6;
    const g = R();
    const col = g < 0.24 ? `rgba(${140 + R() * 45},${128 + R() * 34},${78 + R() * 22},0.85)` : `rgba(${64 + g * 48},${84 + g * 56},${38 + g * 22},0.9)`;
    x.strokeStyle = col; x.lineWidth = 0.8 + R() * 1.2;
    for (const ox of [0, -size, size]) for (const oy of [0, -size, size]) {
      if ((ox && px > 16 && px < size - 16) || (oy && py > 16 && py < size - 16)) continue;
      x.beginPath(); x.moveTo(px + ox, py + oy); x.lineTo(px + ox + Math.cos(a) * len, py + oy + Math.sin(a) * len); x.stroke();
    }
  }
  const data = x.getImageData(0, 0, size, size).data;
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = (data[i * 4] + data[i * 4 + 1] * 1.4 + data[i * 4 + 2] * 0.3) / (255 * 2.7);
  const map = canvasTex(c);
  return { map, normalMap: dataTex(normalFromHeight(h, size, 3), size, false) };
}

export function gravelTextures(size = 512) {
  const R = rng(41);
  const col = new Float32Array(size * size * 3);
  const h = new Float32Array(size * size);
  const base = fbm(size, 8, 3, 43);
  for (let i = 0; i < size * size; i++) { const v = 0.55 + (base[i] - 0.5) * 0.1; col[i * 3] = v * 0.98; col[i * 3 + 1] = v * 0.9; col[i * 3 + 2] = v * 0.76; }
  const pebbles = Math.round(size * size * 0.06);
  for (let k = 0; k < pebbles; k++) {
    const x = R() * size, y = R() * size, r = 1.2 + R() * 3.2;
    const tone = 0.42 + R() * 0.45, warm = R() * 0.12;
    const ri = Math.ceil(r);
    for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
      const d = Math.hypot(dx, dy * 1.2) / r;
      if (d > 1) continue;
      const px = (Math.floor(x) + dx + size) % size, py = (Math.floor(y) + dy + size) % size;
      const o = py * size + px;
      const shade = tone * (1.05 - d * 0.35) - (dy > 0 ? d * 0.12 : 0);
      col[o * 3] = shade * (1 + warm); col[o * 3 + 1] = shade * (0.95 + warm * 0.5); col[o * 3 + 2] = shade * 0.85;
      h[o] = Math.max(h[o], Math.sqrt(1 - d * d));
    }
  }
  const alb = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) { alb[i * 4] = Math.min(255, col[i * 3] * 255); alb[i * 4 + 1] = Math.min(255, col[i * 3 + 1] * 255); alb[i * 4 + 2] = Math.min(255, col[i * 3 + 2] * 255); alb[i * 4 + 3] = 255; }
  return { map: dataTex(alb, size, true), normalMap: dataTex(normalFromHeight(h, size, 3.5), size, false) };
}

// ---------------------------------------------------------------- concrete (paddock, walls)
export function concreteTextures(size = 512, seed = 5) {
  const R = rng(seed);
  const n1 = fbm(size, 4, 5, seed + 1), n2 = fbm(size, 64, 2, seed + 2);
  const alb = new Uint8Array(size * size * 4), h = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    let v = 0.66 + (n1[i] - 0.5) * 0.16 + (n2[i] - 0.5) * 0.08;
    if (R() < 0.004) v -= 0.12;
    alb[i * 4] = v * 248; alb[i * 4 + 1] = v * 246; alb[i * 4 + 2] = v * 240; alb[i * 4 + 3] = 255;
    h[i] = n2[i] * 0.5 + n1[i] * 0.2;
  }
  return { map: dataTex(alb, size, true), normalMap: dataTex(normalFromHeight(h, size, 1.6), size, false) };
}

// paddock slab: concrete with saw-cut joints every 5 m (one tile = 5 m)
export function slabTexture(size = 512) {
  const t = concreteTextures(size, 9);
  const d = t.map.image.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (x < 2 || y < 2) { const o = (y * size + x) * 4; d[o] *= 0.55; d[o + 1] *= 0.55; d[o + 2] *= 0.55; }
  }
  t.map.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- kerb: red/white painted concrete, 3 m tile along the track
export function kerbTexture() {
  const [c, x] = canvas(128, 512);
  const R = rng(3);
  for (let i = 0; i < 2; i++) { x.fillStyle = i ? '#eeeae2' : '#c4211c'; x.fillRect(0, i * 256, 128, 256); }
  // worn paint and rubber pick-up
  for (let k = 0; k < 2600; k++) { x.fillStyle = `rgba(${R() < 0.5 ? '40,38,36' : '120,110,100'},${R() * 0.18})`; x.fillRect(R() * 128, R() * 512, 1 + R() * 3, 1 + R() * 3); }
  for (let k = 0; k < 40; k++) { x.fillStyle = 'rgba(25,25,25,0.12)'; x.fillRect(0, R() * 512, 128, 2 + R() * 6); }
  return canvasTex(c);
}

// ---------------------------------------------------------------- walls: concrete with a painted top band (8 m x 2 m)
export function wallTexture() {
  const [c, x] = canvas(512, 128);
  const R = rng(17);
  const n = fbm(128, 4, 4, 18);
  const img = x.createImageData(512, 128);
  for (let y = 0; y < 128; y++) for (let xx = 0; xx < 512; xx++) {
    const v = 0.72 + (n[(y % 128) * 128 + (xx % 128)] - 0.5) * 0.2;
    const o = (y * 512 + xx) * 4; img.data[o] = v * 235; img.data[o + 1] = v * 233; img.data[o + 2] = v * 228; img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  // top band: alternating red and white blocks, each 2 m
  for (let i = 0; i < 4; i++) { x.fillStyle = i % 2 ? '#e9e5dc' : '#b81d1a'; x.fillRect(i * 128, 0, 128, 30); }
  // grime at the bottom, tyre rubs
  const g = x.createLinearGradient(0, 128, 0, 80); g.addColorStop(0, 'rgba(60,55,45,0.45)'); g.addColorStop(1, 'rgba(60,55,45,0)');
  x.fillStyle = g; x.fillRect(0, 80, 512, 48);
  for (let k = 0; k < 14; k++) { x.fillStyle = `rgba(20,20,20,${0.15 + R() * 0.3})`; x.fillRect(R() * 512, 70 + R() * 40, 20 + R() * 90, 2 + R() * 5); }
  // panel joints every 4 m
  x.fillStyle = 'rgba(40,40,40,0.5)'; x.fillRect(0, 0, 2, 128); x.fillRect(256, 0, 2, 128);
  return canvasTex(c);
}

// tyre stack side (three tyres, wraps around a cylinder)
// tyre stack side (three tyres, wraps around a cylinder); grey mask tinted per instance
export function tyreStackTexture() {
  const [c, x] = canvas(256, 256);
  x.fillStyle = '#404040'; x.fillRect(0, 0, 256, 256);
  for (let t = 0; t < 3; t++) {
    const y0 = t * 85 + 2, hgt = 81;
    const g = x.createLinearGradient(0, y0, 0, y0 + hgt);
    g.addColorStop(0, '#3a3a3a'); g.addColorStop(0.2, '#c8c8c8'); g.addColorStop(0.5, '#ffffff'); g.addColorStop(0.8, '#bdbdbd'); g.addColorStop(1, '#353535');
    x.fillStyle = g; x.fillRect(0, y0, 256, hgt);
    x.fillStyle = 'rgba(0,0,0,0.35)';
    for (let k = 0; k < 64; k++) x.fillRect(k * 4, y0 + 18, 2, hgt - 36);
  }
  return canvasTex(c);
}

// ---------------------------------------------------------------- trees: bark and leaf clusters (alpha)
export function barkTexture() {
  const [c, x] = canvas(128, 256);
  const R = rng(51);
  x.fillStyle = '#5a4b3c'; x.fillRect(0, 0, 128, 256);
  for (let k = 0; k < 500; k++) {
    const px = R() * 128, w = 1 + R() * 4, l = 10 + R() * 60, py = R() * 256;
    x.fillStyle = R() < 0.5 ? `rgba(40,32,25,${0.3 + R() * 0.5})` : `rgba(140,128,112,${0.2 + R() * 0.3})`;
    x.fillRect(px, py, w, l); x.fillRect(px, py - 256, w, l);
  }
  return canvasTex(c);
}

export function leafTexture(kind = 'broad') {
  const S = 512;
  const [c, x] = canvas(S, S);
  const R = rng(kind === 'broad' ? 61 : 62);
  x.clearRect(0, 0, S, S);
  // clusters of leaves; darker inside, lit edges
  const clusters = kind === 'broad' ? 46 : 60;
  for (let k = 0; k < clusters; k++) {
    const cx = S * (0.12 + R() * 0.76), cy = S * (0.1 + R() * 0.8);
    const dx = (cx - S / 2) / (S / 2), dy = (cy - S / 2) / (S / 2);
    if (dx * dx + dy * dy > 0.92) continue;
    const rad = S * (0.06 + R() * 0.07);
    const n = kind === 'broad' ? 70 : 90;
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2, d = Math.sqrt(R()) * rad;
      const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d;
      const lit = 0.55 + 0.45 * (1 - d / rad) * 0.4 + (py < cy ? 0.25 : -0.1) + (R() - 0.5) * 0.3;
      const r0 = kind === 'broad' ? 46 + R() * 30 : 52 + R() * 26, g0 = kind === 'broad' ? 78 + R() * 40 : 86 + R() * 38, b0 = 30 + R() * 18;
      x.fillStyle = `rgb(${Math.min(255, r0 * lit)},${Math.min(255, g0 * lit)},${Math.min(255, b0 * lit)})`;
      x.save(); x.translate(px, py); x.rotate(R() * Math.PI);
      x.beginPath(); x.ellipse(0, 0, kind === 'broad' ? 7 + R() * 5 : 3 + R() * 2, kind === 'broad' ? 3.5 + R() * 2 : 8 + R() * 5, 0, 0, Math.PI * 2); x.fill();
      x.restore();
    }
  }
  // twigs
  x.strokeStyle = 'rgba(60,45,30,0.9)'; x.lineWidth = 2;
  for (let k = 0; k < 12; k++) { x.beginPath(); x.moveTo(S / 2, S * 0.95); x.quadraticCurveTo(S * (0.2 + R() * 0.6), S * 0.6, S * (0.1 + R() * 0.8), S * (0.15 + R() * 0.5)); x.stroke(); }
  const t = canvasTex(c, true, false);
  t.premultiplyAlpha = false;
  return t;
}

// ---------------------------------------------------------------- billboards (atlas of 12 boards, 1024 x 256 each)
export function billboardAtlas(texts) {
  const BW = 1024, BH = 256, cols = 2, CH = 2048, rows = Math.ceil(texts.length / cols);
  const [c, x] = canvas(BW * cols, CH);
  const H = BH * rows;
  const styles = [
    { bg: ['#0e5a35', '#063d22'], fg: '#ffffff', accent: '#f5b301' },
    { bg: ['#f5b301', '#d99500'], fg: '#14110a', accent: '#b81d1a' },
    { bg: ['#14161a', '#24272d'], fg: '#f2f2ee', accent: '#2cc3b3' },
    { bg: ['#b81d1a', '#7d1210'], fg: '#ffffff', accent: '#f5f0e6' },
    { bg: ['#1f4fa8', '#13306a'], fg: '#ffffff', accent: '#f5b301' },
    { bg: ['#f2f0ea', '#d9d5cc'], fg: '#0e5a35', accent: '#b81d1a' },
  ];
  const tag = ['Since 1987', 'Lahore · Karachi · Pindi', 'Feel the boost', 'Doodh patti, kadak', 'Built for the Karakoram', 'Sunday drift nights', 'Gears that last', 'Spark every time', 'Louder is better', 'Cool in Jacobabad heat', 'Forged in Peshawar', 'Hands on the wheel'];
  texts.forEach((t, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const ox = col * BW, oy = row * BH;
    const s = styles[i % styles.length];
    const g = x.createLinearGradient(ox, oy, ox, oy + BH); g.addColorStop(0, s.bg[0]); g.addColorStop(1, s.bg[1]);
    x.fillStyle = g; x.fillRect(ox, oy, BW, BH);
    x.fillStyle = s.accent; x.fillRect(ox, oy + BH - 26, BW, 26);
    x.fillStyle = s.accent; x.beginPath(); x.moveTo(ox + BW - 260, oy); x.lineTo(ox + BW, oy); x.lineTo(ox + BW, oy + BH - 26); x.lineTo(ox + BW - 120, oy + BH - 26); x.closePath(); x.globalAlpha = 0.35; x.fill(); x.globalAlpha = 1;
    x.fillStyle = s.fg; x.textBaseline = 'middle';
    let fs = 104; x.font = `800 ${fs}px "Chakra Petch", "Arial Narrow", Arial, sans-serif`;
    while (x.measureText(t).width > BW - 120 && fs > 40) { fs -= 4; x.font = `800 ${fs}px "Chakra Petch", "Arial Narrow", Arial, sans-serif`; }
    x.fillText(t, ox + 50, oy + BH / 2 - 22);
    x.font = `600 34px "Archivo", Arial, sans-serif`; x.globalAlpha = 0.85;
    x.fillText(tag[i % tag.length], ox + 54, oy + BH / 2 + 52); x.globalAlpha = 1;
  });
  // weathering
  const R = rng(77);
  for (let k = 0; k < 9000; k++) { x.fillStyle = `rgba(${R() < 0.5 ? '0,0,0' : '255,255,255'},${R() * 0.05})`; x.fillRect(R() * BW * cols, R() * H, 2, 2); }
  const tex = canvasTex(c, true, false);
  // UV rectangle of board i: [u0, v0, u1, v1] (canvas textures are flipped, v = 1 at the top)
  const uv = (i) => { const col = i % cols, row = Math.floor(i / cols); return [col / cols, 1 - ((row + 1) * BH) / CH, (col + 1) / cols, 1 - (row * BH) / CH]; };
  return { tex, uv, count: texts.length };
}

// ---------------------------------------------------------------- Pakistan flag (3:2, white hoist band, crescent and star)
export function flagTexture() {
  const W = 600, H = 400;
  const [c, x] = canvas(W, H);
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W * 0.25, H);
  x.fillStyle = '#01411c'; x.fillRect(W * 0.25, 0, W * 0.75, H);
  const cx = W * 0.625, cy = H * 0.5;
  x.fillStyle = '#ffffff';
  x.beginPath(); x.arc(cx, cy, H * 0.3, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#01411c';
  x.beginPath(); x.arc(cx + H * 0.075, cy - H * 0.06, H * 0.275, 0, Math.PI * 2); x.fill();
  // five-pointed star
  const sx = cx + H * 0.1, sy = cy - H * 0.09, ro = H * 0.1, ri = ro * 0.382;
  x.fillStyle = '#ffffff'; x.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5 + 0.62; const r = i % 2 ? ri : ro; x.lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r); }
  x.closePath(); x.fill();
  return canvasTex(c, true, false);
}

// ---------------------------------------------------------------- effects sprites
export function smokeTexture() {
  const S = 128;
  const [c, x] = canvas(S, S);
  const n = fbm(S, 4, 4, 91);
  const img = x.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let xx = 0; xx < S; xx++) {
    const dx = (xx - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
    const d = Math.sqrt(dx * dx + dy * dy);
    const fall = Math.max(0, 1 - d);
    const a = Math.pow(fall, 1.4) * (0.55 + n[y * S + xx] * 0.75);
    const o = (y * S + xx) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = 255; img.data[o + 3] = Math.min(255, a * 255);
  }
  x.putImageData(img, 0, 0);
  return canvasTex(c, true, false);
}

export function glowTexture(inner = 'rgba(255,236,200,1)', outer = 'rgba(255,200,140,0)') {
  const S = 128;
  const [c, x] = canvas(S, S);
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, inner); g.addColorStop(0.35, inner.replace(/,[\d.]+\)$/, ',0.45)')); g.addColorStop(1, outer);
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  return canvasTex(c, true, false);
}

// rubber marks already laid on the drift pad (transparent overlay, whole pad)
export function padMarksTexture(pad, rings, seed = 5) {
  const S = 2048;
  const [c, x] = canvas(S, S);
  const R = rng(seed);
  const W = pad.x1 - pad.x0, H = pad.y1 - pad.y0;
  const px = (X) => ((X - pad.x0) / W) * S, py = (Y) => S - ((Y - pad.y0) / H) * S;
  const m = S / W; // px per metre (x)
  x.lineCap = 'round';
  const tyrePair = (pts, alpha, track) => {
    for (const side of [-1, 1]) {
      x.strokeStyle = `rgba(12,12,12,${alpha})`; x.lineWidth = 0.24 * m;
      x.beginPath();
      pts.forEach(([X, Y, nx, ny], i) => { const qx = px(X + nx * side * track / 2), qy = py(Y + ny * side * track / 2); if (i) x.lineTo(qx, qy); else x.moveTo(qx, qy); });
      x.stroke();
    }
  };
  // donuts and circles around the skidpad rings
  for (const rg of rings) for (let k = 0; k < 26; k++) {
    const r = rg.r + (R() - 0.5) * 8, a0 = R() * Math.PI * 2, span = 0.6 + R() * 3.5;
    const pts = [];
    for (let i = 0; i <= 40; i++) { const a = a0 + (span * i) / 40; pts.push([rg.x + Math.cos(a) * r, rg.y + Math.sin(a) * r, Math.cos(a), Math.sin(a)]); }
    tyrePair(pts, 0.05 + R() * 0.12, 1.5);
  }
  // long figure-eight style arcs over the open pad
  for (let k = 0; k < 60; k++) {
    let X = pad.x0 + 20 + R() * (W - 40), Y = pad.y0 + 20 + R() * (H - 40), a = R() * Math.PI * 2;
    const curv = (R() - 0.5) * 0.09, len = 30 + R() * 90;
    const pts = [];
    for (let s = 0; s < len; s += 1.5) { a += curv * 1.5; X += Math.cos(a) * 1.5; Y += Math.sin(a) * 1.5; pts.push([X, Y, -Math.sin(a), Math.cos(a)]); }
    tyrePair(pts, 0.03 + R() * 0.09, 1.5);
  }
  // oil stains and patch repairs
  for (let k = 0; k < 40; k++) { x.fillStyle = `rgba(10,10,10,${0.04 + R() * 0.08})`; x.beginPath(); x.ellipse(R() * S, R() * S, 4 + R() * 30, 3 + R() * 20, R() * 3, 0, Math.PI * 2); x.fill(); }
  const t = canvasTex(c, true, false);
  return t;
}

// ---------------------------------------------------------------- rock for steep mountain slopes (5 m tile)
export function rockTextures(size = 512) {
  const R = rng(131);
  const base = fbm(size, 6, 5, 132), strata = fbm(size, 16, 3, 133);
  const h = new Float32Array(size * size), alb = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    // layered bedding planes, broken by noise
    const band = 0.5 + 0.5 * Math.sin((y / size) * Math.PI * 2 * 9 + base[i] * 9);
    const v = 0.27 + base[i] * 0.17 + band * 0.05 + (strata[i] - 0.5) * 0.1;
    h[i] = base[i] * 0.8 + band * 0.25 + strata[i] * 0.3;
    alb[i * 4] = Math.min(255, v * 255 * 1.08); alb[i * 4 + 1] = Math.min(255, v * 255 * 0.98); alb[i * 4 + 2] = Math.min(255, v * 255 * 0.84); alb[i * 4 + 3] = 255;
  }
  // cracks
  for (let k = 0; k < 40; k++) {
    let x = R() * size, y = R() * size, a = R() * Math.PI * 2;
    for (let s = 0; s < 40 + R() * 120; s++) {
      a += (R() - 0.5) * 0.6; x = (x + Math.cos(a) + size) % size; y = (y + Math.sin(a) + size) % size;
      const o = (Math.floor(y) * size + Math.floor(x));
      h[o] -= 0.5; alb[o * 4] *= 0.6; alb[o * 4 + 1] *= 0.6; alb[o * 4 + 2] *= 0.6;
    }
  }
  return { map: dataTex(alb, size, true), normalMap: dataTex(normalFromHeight(h, size, 3.2), size, false) };
}

// ---------------------------------------------------------------- road paint: lines across the road (u) and along it (v = 12 m)
// lines: [{ o: lateral offset (m, left positive), w: width (m), dash: true/false, col }]
export function roadMarkTexture(half, lines, extra) {
  const W = 1024, H = 256;
  const [c, x] = canvas(W, H);
  x.clearRect(0, 0, W, H);
  const U = (o) => ((o + half) / (2 * half)) * W;
  if (extra) extra(x, W, H, U);
  for (const l of lines) {
    const x0 = U(l.o - l.w / 2), x1 = U(l.o + l.w / 2);
    x.fillStyle = l.col || 'rgba(238,236,228,0.95)';
    if (l.dash) { const d = (l.dash / 12) * H; for (let y = 0; y < H; y += H / (l.per || 1)) x.fillRect(x0, y, Math.max(2, x1 - x0), d / (l.per || 1)); }
    else x.fillRect(x0, 0, Math.max(2, x1 - x0), H);
  }
  // wear: break up the paint a little
  const R = rng(17);
  const img = x.getImageData(0, 0, W, H);
  for (let i = 0; i < W * H; i++) if (img.data[i * 4 + 3] > 0 && R() < 0.18) img.data[i * 4 + 3] *= 0.55 + R() * 0.3;
  x.putImageData(img, 0, 0);
  const t = canvasTex(c, true, true);
  t.wrapS = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------------------------------------------------------------- pavers for city sidewalks (2 m tile)
export function paverTexture() {
  const S = 512;
  const [c, x] = canvas(S, S);
  const R = rng(55);
  x.fillStyle = '#8f8a80'; x.fillRect(0, 0, S, S);
  const n = 8, cs = S / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = 150 + R() * 40;
    x.fillStyle = `rgb(${v},${v * 0.96},${v * 0.9})`;
    x.fillRect(i * cs + 2, j * cs + 2, cs - 4, cs - 4);
    for (let k = 0; k < 30; k++) { x.fillStyle = `rgba(0,0,0,${R() * 0.12})`; x.fillRect(i * cs + R() * cs, j * cs + R() * cs, 2, 2); }
  }
  return canvasTex(c);
}

// ---------------------------------------------------------------- city facades: 4 styles x (shop floor, upper floor)
// One cell is a 4 m bay by 3.2 m storey. Returns the colour atlas and a window mask for night.
export function facadeAtlas() {
  const CW = 512, CH = 410, W = CW * 4, H = 1024;
  const [c, x] = canvas(W, H);
  const [m, mx] = canvas(W, H);
  mx.fillStyle = '#000'; mx.fillRect(0, 0, W, H);
  const R = rng(808);
  const walls = ['#d9cdb5', '#b9714f', '#c8d3c0', '#e6e3dc'];
  // canvas row 0 (top) = upper floor, row 1 (bottom) = ground floor shops
  for (let v = 0; v < 4; v++) {
    const ox = v * CW;
    for (const row of [0, 1]) {
      const oy = row === 0 ? 0 : H - CH;
      x.fillStyle = walls[v]; x.fillRect(ox, oy, CW, CH);
      // plaster texture and stains
      for (let k = 0; k < 1400; k++) { x.fillStyle = `rgba(${R() < 0.5 ? '0,0,0' : '255,255,255'},${R() * 0.05})`; x.fillRect(ox + R() * CW, oy + R() * CH, 2 + R() * 6, 2 + R() * 6); }
      const g = x.createLinearGradient(0, oy, 0, oy + CH); g.addColorStop(0, 'rgba(60,50,40,0.18)'); g.addColorStop(0.1, 'rgba(60,50,40,0)'); g.addColorStop(1, 'rgba(60,50,40,0.1)');
      x.fillStyle = g; x.fillRect(ox, oy, CW, CH);
      if (v === 1) { // brick courses
        for (let yy = 0; yy < CH; yy += 10) for (let xx = (yy / 10) % 2 ? 0 : 16; xx < CW; xx += 32) { x.fillStyle = `rgba(90,40,25,${0.15 + R() * 0.15})`; x.fillRect(ox + xx, oy + yy, 30, 8); }
      }
      // floor slab line
      x.fillStyle = 'rgba(0,0,0,0.22)'; x.fillRect(ox, oy + CH - 10, CW, 10);
      if (row === 0) {
        // windows with steel grilles, balcony on style 2, AC unit
        const wins = v === 3 ? [[40, 60, 432, 240]] : [[70, 80, 150, 200], [292, 80, 150, 200]];
        for (const [wx, wy, ww, wh] of wins) {
          const gg = x.createLinearGradient(0, oy + wy, 0, oy + wy + wh); gg.addColorStop(0, '#3a4654'); gg.addColorStop(1, '#1b222b');
          x.fillStyle = gg; x.fillRect(ox + wx, oy + wy, ww, wh);
          x.fillStyle = 'rgba(255,255,255,0.08)'; x.beginPath(); x.moveTo(ox + wx, oy + wy); x.lineTo(ox + wx + ww * 0.4, oy + wy); x.lineTo(ox + wx, oy + wy + wh * 0.6); x.fill();
          if (v !== 3) { x.strokeStyle = '#2c2c2c'; x.lineWidth = 4; for (let k = 1; k < 6; k++) { x.beginPath(); x.moveTo(ox + wx + (ww * k) / 6, oy + wy); x.lineTo(ox + wx + (ww * k) / 6, oy + wy + wh); x.stroke(); } x.beginPath(); x.moveTo(ox + wx, oy + wy + wh / 2); x.lineTo(ox + wx + ww, oy + wy + wh / 2); x.stroke(); }
          x.fillStyle = 'rgba(0,0,0,0.3)'; x.fillRect(ox + wx - 8, oy + wy + wh, ww + 16, 10);
          // night window glow mask
          mx.fillStyle = '#fff'; mx.fillRect(ox + wx + 6, oy + wy + 6, ww - 12, wh - 12);
        }
        if (v === 2) { x.fillStyle = '#9aa39a'; x.fillRect(ox + 40, oy + 270, 432, 22); x.strokeStyle = '#2a2a2a'; x.lineWidth = 3; for (let k = 0; k <= 24; k++) { x.beginPath(); x.moveTo(ox + 40 + k * 18, oy + 205); x.lineTo(ox + 40 + k * 18, oy + 270); x.stroke(); } x.beginPath(); x.moveTo(ox + 40, oy + 205); x.lineTo(ox + 472, oy + 205); x.stroke(); }
        if (v !== 3) { x.fillStyle = '#e8e8e2'; x.fillRect(ox + 420, oy + 300, 70, 46); x.fillStyle = '#9a9a96'; for (let k = 0; k < 6; k++) x.fillRect(ox + 426, oy + 306 + k * 7, 58, 3); }
      } else {
        // shop: rolling shutter half up, lit interior, signboard band on top
        x.fillStyle = '#2a2622'; x.fillRect(ox + 30, oy + 120, 452, 290);
        const lit = x.createLinearGradient(0, oy + 200, 0, oy + 410); lit.addColorStop(0, '#f3dfb0'); lit.addColorStop(1, '#8a7650');
        x.fillStyle = lit; x.fillRect(ox + 40, oy + 210, 432, 200);
        for (let k = 0; k < 5; k++) { x.fillStyle = `hsl(${R() * 360},45%,${35 + R() * 20}%)`; x.fillRect(ox + 50 + k * 86, oy + 240 + R() * 40, 60, 120); }
        x.fillStyle = '#7c7f84'; x.fillRect(ox + 30, oy + 120, 452, 90);
        for (let k = 0; k < 18; k++) { x.fillStyle = k % 2 ? '#6b6e73' : '#8d9095'; x.fillRect(ox + 30, oy + 120 + k * 5, 452, 3); }
        x.fillStyle = ['#0e5a35', '#b81d1a', '#1f4fa8', '#f5b301'][v]; x.fillRect(ox + 10, oy + 30, 492, 80);
        x.fillStyle = 'rgba(255,255,255,0.85)'; for (let k = 0; k < 9; k++) x.fillRect(ox + 40 + k * 50, oy + 52, 30 + R() * 12, 34);
        mx.fillStyle = '#fff'; mx.fillRect(ox + 40, oy + 210, 432, 200); mx.fillStyle = '#888'; mx.fillRect(ox + 10, oy + 30, 492, 80);
      }
    }
  }
  const map = canvasTex(c, true, false), mask = canvasTex(m, false, false);
  return { map, mask, cols: 4, cellH: CH / H };
}

export function shopSignAtlas(names) {
  const BW = 1024, BH = 128, rows = Math.ceil(names.length / 2);
  const [c, x] = canvas(BW * 2, 2048);
  const bgs = ['#0e5a35', '#b81d1a', '#1f4fa8', '#f5b301', '#14161a', '#7a1fa2', '#e86a10'];
  names.forEach((n, i) => {
    const ox = (i % 2) * BW, oy = Math.floor(i / 2) * BH;
    x.fillStyle = bgs[i % bgs.length]; x.fillRect(ox, oy, BW, BH);
    x.fillStyle = 'rgba(255,255,255,0.12)'; x.fillRect(ox, oy, BW, 10);
    x.fillStyle = bgs[i % bgs.length] === '#f5b301' ? '#14110a' : '#ffffff';
    let fs = 78; x.font = `800 ${fs}px "Chakra Petch", "Arial Narrow", Arial, sans-serif`;
    while (x.measureText(n).width > BW - 60 && fs > 30) { fs -= 4; x.font = `800 ${fs}px "Chakra Petch", "Arial Narrow", Arial, sans-serif`; }
    x.textBaseline = 'middle'; x.textAlign = 'center'; x.fillText(n, ox + BW / 2, oy + BH / 2 + 4);
  });
  void rows;
  const t = canvasTex(c, true, false);
  const uv = (i) => { const col = i % 2, row = Math.floor(i / 2); return [col / 2, 1 - ((row + 1) * BH) / 2048, (col + 1) / 2, 1 - (row * BH) / 2048]; };
  return { tex: t, uv };
}

// sun-dried mud plaster for village houses (2 m tile)
export function mudTexture() {
  const S = 512;
  const [c, x] = canvas(S, S);
  const R = rng(66);
  const n = fbm(S, 8, 4, 67);
  const img = x.createImageData(S, S);
  for (let i = 0; i < S * S; i++) { const v = 0.58 + (n[i] - 0.5) * 0.25; img.data[i * 4] = v * 236; img.data[i * 4 + 1] = v * 190; img.data[i * 4 + 2] = v * 140; img.data[i * 4 + 3] = 255; }
  x.putImageData(img, 0, 0);
  for (let k = 0; k < 900; k++) { x.strokeStyle = `rgba(${R() < 0.5 ? '230,200,150' : '90,60,40'},${0.2 + R() * 0.2})`; x.lineWidth = 1; const px = R() * S, py = R() * S, a = R() * 3; x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * 6, py + Math.sin(a) * 6); x.stroke(); }
  return canvasTex(c);
}

// slowly rolling ripples for the lake (tileable normal map)
export function waterNormal(size = 256) {
  const n1 = fbm(size, 8, 4, 141), n2 = fbm(size, 16, 3, 142);
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = n1[i] * 0.7 + n2[i] * 0.3;
  return dataTex(normalFromHeight(h, size, 2.5), size, false);
}

// spruce/pine silhouette for crossed-card conifers (alpha)
export function coniferTexture() {
  const W = 256, H = 512;
  const [c, x] = canvas(W, H);
  const R = rng(171);
  x.clearRect(0, 0, W, H);
  // trunk
  x.fillStyle = '#4a3a2c'; x.fillRect(W / 2 - 5, H * 0.1, 10, H * 0.9);
  // tiers of drooping branches, wider toward the bottom
  const tiers = 15;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y = H * (0.04 + f * 0.86);
    const half = W * (0.06 + f * 0.42) * (0.85 + R() * 0.25);
    for (let k = 0; k < 160; k++) {
      const side = R() < 0.5 ? -1 : 1, d = Math.pow(R(), 0.7) * half;
      const px = W / 2 + side * d, py = y + d * 0.28 + (R() - 0.5) * 16;
      const shade = 0.55 + (1 - d / half) * 0.25 + (R() - 0.5) * 0.3 - f * 0.1;
      x.fillStyle = `rgb(${Math.max(0, 34 * shade)},${Math.max(0, 66 * shade + 10)},${Math.max(0, 40 * shade)})`;
      x.beginPath(); x.ellipse(px, py, 3 + R() * 4, 1.5 + R() * 2, side * 0.35, 0, Math.PI * 2); x.fill();
    }
  }
  const t = canvasTex(c, true, false);
  return t;
}


// grass tuft card (alpha): a clump of blades for the 3D grass around the camera
export function grassTuftTexture() {
  const W = 256, H = 256;
  const [c, x] = canvas(W, H);
  const R = rng(212);
  x.clearRect(0, 0, W, H);
  for (let k = 0; k < 140; k++) {
    const bx = W * (0.1 + R() * 0.8), h = H * (0.35 + R() * 0.6), lean = (R() - 0.5) * 60;
    const g = R();
    x.strokeStyle = g < 0.22 ? `rgb(${150 + R() * 40},${136 + R() * 30},${80 + R() * 20})` : `rgb(${58 + g * 50},${80 + g * 60},${34 + g * 22})`;
    x.lineWidth = 2 + R() * 3;
    x.beginPath(); x.moveTo(bx, H); x.quadraticCurveTo(bx + lean * 0.3, H - h * 0.6, bx + lean, H - h); x.stroke();
  }
  return canvasTex(c, true, false);
}
