// Procedural canvas textures: lamps, grilles, plates, liveries, tyre tread, studio floor.
import * as THREE from 'three';

const cache = new Map();

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, opts = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.needsUpdate = true;
  return t;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

// ---------------- lamps ----------------
// Returns { map, emissive } textures. Shapes: round, rect, modern90, modern, led.
export function headlightTextures(style, tint = 'white') {
  return cached(`hl-${style}-${tint}`, () => {
    const W = 512, H = 256;
    const [c, x] = canvas(W, H);
    const [ce, xe] = canvas(W, H);
    const glow = tint === 'warm' ? '#ffe2a6' : tint === 'ice' ? '#bfe6ff' : '#f4f8ff';
    x.clearRect(0, 0, W, H); xe.fillStyle = '#000'; xe.fillRect(0, 0, W, H);
    const housing = (path) => {
      path(x); x.fillStyle = '#1f252c'; x.fill();
      const hg = x.createLinearGradient(0, 0, W, 0); hg.addColorStop(0, 'rgba(210,220,230,0.25)'); hg.addColorStop(0.5, 'rgba(120,130,140,0.12)'); hg.addColorStop(1, 'rgba(230,236,242,0.3)');
      path(x); x.fillStyle = hg; x.fill();
      const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(0.5, 'rgba(255,255,255,0.05)'); g.addColorStop(1, 'rgba(255,255,255,0.18)');
      path(x); x.fillStyle = g; x.fill();
      path(x); x.lineWidth = 10; x.strokeStyle = '#2a2e33'; x.stroke();
    };
    const reflector = (cx, cy, r) => {
      const g = x.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, '#cfd6de'); g.addColorStop(0.75, '#6d7680'); g.addColorStop(1, '#2b3036');
      x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fillStyle = g; x.fill();
      x.beginPath(); x.arc(cx, cy, r * 0.42, 0, Math.PI * 2); x.fillStyle = '#e9eef4'; x.fill();
      xe.beginPath(); xe.arc(cx, cy, r * 0.5, 0, Math.PI * 2); xe.fillStyle = glow; xe.fill();
      const ge = xe.createRadialGradient(cx, cy, r * 0.4, cx, cy, r);
      ge.addColorStop(0, 'rgba(255,255,255,0.55)'); ge.addColorStop(1, 'rgba(255,255,255,0)');
      xe.beginPath(); xe.arc(cx, cy, r, 0, Math.PI * 2); xe.fillStyle = ge; xe.fill();
    };
    if (style === 'round') {
      const p = (ctx) => { ctx.beginPath(); ctx.arc(W / 2, H / 2, H * 0.46, 0, Math.PI * 2); };
      housing(p);
      reflector(W / 2, H / 2, H * 0.38);
      x.beginPath(); x.arc(W / 2, H / 2, H * 0.46, 0, Math.PI * 2); x.lineWidth = 12; x.strokeStyle = '#c9ced4'; x.stroke();
      // amber indicator separate below
    } else if (style === 'rect') {
      const p = (ctx) => rr(ctx, 14, 30, W - 28, H - 60, 14);
      housing(p);
      x.save(); rr(x, 20, 36, W - 40, H - 72, 10); x.clip();
      for (let i = 0; i < 9; i++) { x.fillStyle = i % 2 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)'; x.fillRect(20 + i * ((W - 40) / 9), 36, (W - 40) / 9, H - 72); }
      x.restore();
      reflector(W * 0.33, H / 2, H * 0.3);
      x.fillStyle = '#e88a12'; rr(x, W * 0.7, H * 0.3, W * 0.22, H * 0.4, 8); x.fill();
      xe.fillStyle = 'rgba(255,255,255,0.15)'; rr(xe, 20, 36, W * 0.6, H - 72, 10); xe.fill();
    } else if (style === 'modern90') {
      const p = (ctx) => { ctx.beginPath(); ctx.moveTo(20, H * 0.25); ctx.quadraticCurveTo(W * 0.5, 10, W - 16, H * 0.18); ctx.lineTo(W - 30, H * 0.82); ctx.quadraticCurveTo(W * 0.5, H - 6, 26, H * 0.8); ctx.closePath(); };
      housing(p);
      reflector(W * 0.3, H * 0.52, H * 0.3);
      reflector(W * 0.62, H * 0.5, H * 0.22);
      x.fillStyle = '#e88a12'; x.beginPath(); x.ellipse(W * 0.86, H * 0.5, W * 0.06, H * 0.2, 0, 0, Math.PI * 2); x.fill();
    } else {
      const slim = style === 'led';
      const top = slim ? H * 0.22 : H * 0.12;
      const bot = slim ? H * 0.78 : H * 0.88;
      const p = (ctx) => {
        ctx.beginPath();
        ctx.moveTo(18, top + 20); ctx.quadraticCurveTo(W * 0.4, top - 6, W - 14, top);
        ctx.quadraticCurveTo(W - 4, (top + bot) / 2, W - 40, bot - 10);
        ctx.quadraticCurveTo(W * 0.45, bot + 4, 40, bot);
        ctx.quadraticCurveTo(8, (top + bot) / 2, 18, top + 20);
        ctx.closePath();
      };
      housing(p);
      const cy = (top + bot) / 2 + 4;
      const pr = slim ? H * 0.14 : H * 0.2;
      for (const px of slim ? [W * 0.42, W * 0.6] : [W * 0.36, W * 0.62]) {
        const g = x.createRadialGradient(px, cy, 2, px, cy, pr);
        g.addColorStop(0, '#ffffff'); g.addColorStop(0.3, '#9fb4c8'); g.addColorStop(0.7, '#1c242c'); g.addColorStop(1, '#3a434c');
        x.beginPath(); x.arc(px, cy, pr, 0, Math.PI * 2); x.fillStyle = g; x.fill();
        xe.beginPath(); xe.arc(px, cy, pr * 0.6, 0, Math.PI * 2); xe.fillStyle = glow; xe.fill();
      }
      // DRL signature
      x.lineCap = 'round';
      x.lineWidth = slim ? 12 : 10; x.strokeStyle = '#f2f7ff';
      x.beginPath(); x.moveTo(40, bot - 22); x.quadraticCurveTo(W * 0.5, bot - 6, W - 50, bot - 30); x.stroke();
      xe.lineCap = 'round'; xe.lineWidth = slim ? 18 : 16; xe.strokeStyle = '#ffffff';
      xe.beginPath(); xe.moveTo(40, bot - 22); xe.quadraticCurveTo(W * 0.5, bot - 6, W - 50, bot - 30); xe.stroke();
      if (slim) { x.strokeStyle = '#f2f7ff'; x.lineWidth = 8; x.beginPath(); x.moveTo(30, top + 26); x.lineTo(W * 0.28, top + 10); x.stroke(); xe.lineWidth = 12; xe.beginPath(); xe.moveTo(30, top + 26); xe.lineTo(W * 0.28, top + 10); xe.stroke(); }
      x.fillStyle = '#d9821a'; x.globalAlpha = 0.6; x.fillRect(W * 0.8, cy - 10, W * 0.12, 20); x.globalAlpha = 1;
    }
    return { map: tex(c), emissive: tex(ce) };
  });
}

export function taillightTextures(style) {
  return cached(`tl-${style}`, () => {
    const W = 512, H = 256;
    const [c, x] = canvas(W, H);
    const [ce, xe] = canvas(W, H);
    xe.fillStyle = '#000'; xe.fillRect(0, 0, W, H);
    let path;
    if (style === 'round') path = (ctx) => { ctx.beginPath(); ctx.arc(W / 2, H / 2, H * 0.45, 0, Math.PI * 2); };
    else if (style === 'rect' || style === 'modern90') path = (ctx) => rr(ctx, 16, 20, W - 32, H - 40, style === 'rect' ? 8 : 40);
    else path = (ctx) => { ctx.beginPath(); ctx.moveTo(14, H * 0.3); ctx.quadraticCurveTo(W * 0.5, H * 0.08, W - 12, H * 0.22); ctx.lineTo(W - 24, H * 0.76); ctx.quadraticCurveTo(W * 0.5, H * 0.92, 22, H * 0.74); ctx.closePath(); };
    path(x);
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#7a0b12'); g.addColorStop(0.5, '#b0141d'); g.addColorStop(1, '#5a070c');
    x.fillStyle = g; x.fill();
    x.lineWidth = 10; x.strokeStyle = '#2a0508'; x.stroke();
    x.save(); path(x); x.clip();
    if (style === 'rect' || style === 'round') {
      x.fillStyle = '#e88a12'; x.fillRect(W * 0.66, 0, W * 0.34, H);
      x.fillStyle = '#e9e9e9'; x.fillRect(W * 0.5, 0, W * 0.16, H);
      for (let i = 0; i < 14; i++) { x.fillStyle = 'rgba(255,255,255,0.08)'; x.fillRect(i * 38, 0, 3, H); }
    } else {
      x.fillStyle = 'rgba(30,0,0,0.55)'; x.fillRect(0, H * 0.45, W, H * 0.14);
      x.fillStyle = '#d9d9d9'; x.fillRect(W * 0.62, H * 0.47, W * 0.16, H * 0.1);
    }
    x.restore();
    xe.save(); path(xe); xe.clip();
    xe.fillStyle = 'rgba(255,40,40,0.55)'; xe.fillRect(0, 0, W, H);
    xe.strokeStyle = '#ff3b3b'; xe.lineWidth = 16; xe.lineCap = 'round';
    xe.beginPath(); xe.moveTo(36, H * 0.34); xe.quadraticCurveTo(W * 0.5, H * 0.18, W - 40, H * 0.3); xe.stroke();
    xe.restore();
    return { map: tex(c), emissive: tex(ce) };
  });
}

export function grilleTexture(style, chrome = false) {
  return cached(`gr-${style}-${chrome}`, () => {
    const W = 512, H = 192;
    const [c, x] = canvas(W, H);
    const shape = (ctx) => rr(ctx, 8, 8, W - 16, H - 16, style === 'closed' ? 60 : 36);
    if (style === 'closed') {
      shape(x); x.fillStyle = 'rgba(0,0,0,0)'; x.fill();
      x.fillStyle = 'rgba(20,22,26,0.85)';
      for (let i = 0; i < 4; i++) rr(x, 60, H * 0.55 + i * 14, W - 120, 5, 3), x.fill();
      return tex(c);
    }
    shape(x); x.fillStyle = '#0a0b0d'; x.fill();
    x.save(); shape(x); x.clip();
    if (style === 'honeycomb') {
      const r = 13;
      for (let row = 0; row < 12; row++) for (let col = 0; col < 26; col++) {
        const cx = col * r * 1.75 + (row % 2 ? r * 0.87 : 0), cy = row * r * 1.5;
        x.beginPath();
        for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3; x.lineTo(cx + Math.cos(a) * r * 0.82, cy + Math.sin(a) * r * 0.82); }
        x.closePath(); x.fillStyle = '#1d2024'; x.fill(); x.strokeStyle = '#33373d'; x.lineWidth = 2; x.stroke();
      }
    } else if (style === 'mesh') {
      x.strokeStyle = '#2b2f35'; x.lineWidth = 5;
      for (let i = -H; i < W; i += 22) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + H, H); x.stroke(); x.beginPath(); x.moveTo(i + H, 0); x.lineTo(i, H); x.stroke(); }
    } else if (style === 'bars') {
      for (let i = 0; i < 6; i++) { const g = x.createLinearGradient(0, 0, 0, 20); g.addColorStop(0, '#3a3f45'); g.addColorStop(1, '#121417'); x.fillStyle = g; x.fillRect(0, 20 + i * 28, W, 14); }
    } else if (style === 'chrome') {
      for (let i = 0; i < 5; i++) { const y = 26 + i * 30; const g = x.createLinearGradient(0, y, 0, y + 14); g.addColorStop(0, '#f6f8fa'); g.addColorStop(0.5, '#8b939b'); g.addColorStop(1, '#e3e7eb'); x.fillStyle = g; x.fillRect(0, y, W, 12); }
    }
    x.restore();
    shape(x); x.lineWidth = chrome || style === 'chrome' ? 14 : 8; x.strokeStyle = chrome || style === 'chrome' ? '#d9dee3' : '#25292e'; x.stroke();
    return tex(c);
  });
}

export function intakeTexture() {
  return cached('intake', () => {
    const W = 512, H = 128;
    const [c, x] = canvas(W, H);
    rr(x, 6, 6, W - 12, H - 12, 40); x.fillStyle = '#070809'; x.fill();
    x.save(); rr(x, 6, 6, W - 12, H - 12, 40); x.clip();
    x.strokeStyle = '#24272b'; x.lineWidth = 4;
    for (let i = -H; i < W; i += 18) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + H, H); x.stroke(); x.beginPath(); x.moveTo(i + H, 0); x.lineTo(i, H); x.stroke(); }
    x.restore();
    return tex(c);
  });
}

export function ventTexture() {
  return cached('vent', () => {
    const W = 256, H = 128;
    const [c, x] = canvas(W, H);
    rr(x, 4, 4, W - 8, H - 8, 26); x.fillStyle = '#0c0d0f'; x.fill();
    x.fillStyle = '#2a2d31';
    for (let i = 0; i < 6; i++) rr(x, 18, 16 + i * 17, W - 36, 8, 4), x.fill();
    return tex(c);
  });
}

export function windowTexture() {
  return cached('rearwin', () => {
    const W = 256, H = 160;
    const [c, x] = canvas(W, H);
    rr(x, 4, 4, W - 8, H - 8, 18); x.fillStyle = '#0e1318'; x.fill();
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(0.5, 'rgba(255,255,255,0.02)'); g.addColorStop(1, 'rgba(255,255,255,0.1)');
    rr(x, 4, 4, W - 8, H - 8, 18); x.fillStyle = g; x.fill();
    return tex(c);
  });
}

// ---------------- number plate ----------------
// Plates are shared between the front and rear decals and across rebuilds. They are reference
// counted so a texture is freed as soon as no decal shows that text any more.
const plates = new Map();
export function plateTexture(text) {
  const t = (text || '').toUpperCase().slice(0, 10);
  let e = plates.get(t);
  if (e) { e.refs++; return e.tex; }
  const W = 512, H = 128;
  const [c, x] = canvas(W, H);
  rr(x, 2, 2, W - 4, H - 4, 12); x.fillStyle = '#f7f7f2'; x.fill();
  x.lineWidth = 6; x.strokeStyle = '#141414'; rr(x, 8, 8, W - 16, H - 16, 9); x.stroke();
  x.fillStyle = '#01633a'; rr(x, 14, 14, 62, H - 28, 6); x.fill();
  x.fillStyle = '#ffffff'; x.font = '700 22px "Chakra Petch", "Arial Black", sans-serif'; x.textAlign = 'center';
  x.fillText('PK', 45, H / 2 + 8);
  x.beginPath(); x.arc(45, 34, 9, 0.6, 5.7); x.lineWidth = 3; x.strokeStyle = '#fff'; x.stroke();
  x.fillStyle = '#121212';
  let size = 78;
  x.font = `700 ${size}px "Chakra Petch", "Arial Black", sans-serif`;
  while (x.measureText(t).width > W - 120 && size > 30) { size -= 4; x.font = `700 ${size}px "Chakra Petch", "Arial Black", sans-serif`; }
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(t, (W + 76) / 2, H / 2 + 4);
  e = { tex: tex(c), refs: 1 };
  e.tex.userData.plate = t;
  plates.set(t, e);
  return e.tex;
}
export function releasePlate(texture) {
  if (!texture || texture.userData.plate == null) return;
  const e = plates.get(texture.userData.plate);
  if (!e || e.tex !== texture) return;
  if (--e.refs <= 0) { plates.delete(texture.userData.plate); texture.dispose(); }
}

// ---------------- liveries ----------------
let truckArt = null;
export function truckArtTexture(base) {
  if (truckArt && truckArt.base === base) return truckArt.tex;
  if (truckArt) truckArt.tex.dispose();
  truckArt = { base, tex: makeTruckArt(base) };
  return truckArt.tex;
}
// An unshared truck-art texture; the caller owns it and disposes it.
export function makeTruckArt(base) {
  {
    const W = 1024, H = 512;
    const [c, x] = canvas(W, H);
    x.fillStyle = base; x.fillRect(0, 0, W, H);
    const pal = ['#e3262f', '#f6c21b', '#11a36b', '#1f6fd1', '#ffffff', '#f2751a', '#d61f8c'];
    // top scalloped border
    for (let i = 0; i < W / 32; i++) {
      x.fillStyle = pal[i % pal.length];
      x.beginPath(); x.arc(i * 32 + 16, 16, 16, 0, Math.PI); x.fill();
      x.fillStyle = '#ffffff'; x.beginPath(); x.arc(i * 32 + 16, 16, 4, 0, Math.PI * 2); x.fill();
    }
    // chevron band
    const band = (y, h, a, b) => {
      for (let i = -1; i < W / h + 1; i++) {
        x.fillStyle = i % 2 ? a : b;
        x.beginPath(); x.moveTo(i * h, y); x.lineTo(i * h + h / 2, y + h); x.lineTo(i * h + h, y); x.closePath(); x.fill();
      }
    };
    x.fillStyle = '#16161a'; x.fillRect(0, 38, W, 30);
    band(40, 26, '#f6c21b', '#e3262f');
    x.fillStyle = '#16161a'; x.fillRect(0, H - 70, W, 34);
    band(H - 68, 30, '#11a36b', '#f6c21b');
    // floral medallions
    const flower = (cx, cy, r, k) => {
      const petals = 8 + (k % 3) * 2;
      for (let p = 0; p < petals; p++) {
        const a = (p / petals) * Math.PI * 2;
        x.fillStyle = pal[(k + p) % pal.length];
        x.beginPath(); x.ellipse(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55, r * 0.42, r * 0.18, a, 0, Math.PI * 2); x.fill();
      }
      x.fillStyle = pal[(k + 3) % pal.length]; x.beginPath(); x.arc(cx, cy, r * 0.32, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#ffffff'; x.beginPath(); x.arc(cx, cy, r * 0.14, 0, Math.PI * 2); x.fill();
      x.strokeStyle = '#16161a'; x.lineWidth = 3; x.beginPath(); x.arc(cx, cy, r * 1.02, 0, Math.PI * 2); x.stroke();
    };
    for (let i = 0; i < 6; i++) flower(90 + i * 170, 210, 62, i);
    // vines and leaves
    x.strokeStyle = '#11a36b'; x.lineWidth = 6;
    x.beginPath();
    for (let i = 0; i <= W; i += 8) x.lineTo(i, 330 + Math.sin(i / 40) * 22);
    x.stroke();
    for (let i = 20; i < W; i += 80) {
      x.fillStyle = i % 160 ? '#11a36b' : '#f6c21b';
      x.beginPath(); x.ellipse(i, 330 + Math.sin(i / 40) * 22 - 18, 16, 7, -0.6, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#e3262f'; x.beginPath(); x.arc(i + 40, 330 + Math.sin((i + 40) / 40) * 22 + 16, 9, 0, Math.PI * 2); x.fill();
    }
    // mirror dots
    for (let i = 0; i < 64; i++) { x.fillStyle = '#ffffff'; x.beginPath(); x.arc(8 + i * 16, 392, 4, 0, Math.PI * 2); x.fill(); x.fillStyle = '#1f6fd1'; x.beginPath(); x.arc(16 + i * 16, 404, 3, 0, Math.PI * 2); x.fill(); }
    return tex(c, { repeat: true });
  }
}

export function camoTexture() {
  return cached('camo', () => {
    const W = 512, H = 512;
    const [c, x] = canvas(W, H);
    x.fillStyle = '#58613f'; x.fillRect(0, 0, W, H);
    const cols = ['#3c4430', '#7c7452', '#2a2d24', '#8a8a62'];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 140; i++) {
      x.fillStyle = cols[i % cols.length];
      const cx = rnd() * W, cy = rnd() * H, r = 18 + rnd() * 46;
      for (const ox of [-W, 0, W]) for (const oy of [-H, 0, H]) {
        x.beginPath();
        for (let k = 0; k < 9; k++) { const a = (k / 9) * Math.PI * 2; const rr2 = r * (0.6 + 0.4 * Math.sin(k * 2.3 + i)); x.lineTo(cx + ox + Math.cos(a) * rr2 * 1.4, cy + oy + Math.sin(a) * rr2); }
        x.closePath(); x.fill();
      }
    }
    return tex(c, { repeat: true });
  });
}

export function carbonTexture() {
  return cached('carbon', () => {
    const S = 256;
    const [c, x] = canvas(S, S);
    const n = 8, s = S / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const horiz = (i + j) % 2 === 0;
      const g = horiz ? x.createLinearGradient(i * s, 0, i * s + s, 0) : x.createLinearGradient(0, j * s, 0, j * s + s);
      g.addColorStop(0, '#0d0e10'); g.addColorStop(0.5, '#3a3d42'); g.addColorStop(1, '#0d0e10');
      x.fillStyle = g; x.fillRect(i * s, j * s, s, s);
    }
    return tex(c, { repeat: true });
  });
}

export function checkerTexture() {
  return cached('checker', () => {
    const S = 256;
    const [c, x] = canvas(S, S);
    const n = 8, s = S / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { x.fillStyle = (i + j) % 2 ? '#111214' : '#f3f3ef'; x.fillRect(i * s, j * s, s, s); }
    return tex(c, { repeat: true });
  });
}

// ---------------- tyres and studio ----------------
// Height map for a tyre: u runs round the circumference, v across the section
// (inboard sidewall 0 to 0.3, tread 0.3 to 0.7, outboard sidewall 0.7 to 1). The outboard sidewall
// carries raised lettering with the real size of the tyre that is fitted.
const tyres = new Map();
let tyreStamp = 0;
export function tyreTexture(kind, label) {
  const key = `${kind}|${label}`;
  let e = tyres.get(key);
  if (e) { e.refs++; e.used = ++tyreStamp; return e.tex; }
  const W = 2048, H = 256;
  const [c, x] = canvas(W, H);
  const base = '#7c7c7c';
  x.fillStyle = base; x.fillRect(0, 0, W, H);
  // canvas rows: 0 = outboard bead ... 0.3H = outboard shoulder ... 0.7H = inboard shoulder ... H = inboard bead
  const t0 = H * 0.3, t1 = H * 0.7, th = t1 - t0;
  x.fillStyle = '#c4c4c4'; x.fillRect(0, t0, W, th);
  const groove = '#3c3c3c';
  if (kind === 'at') {
    // chunky staggered blocks with open shoulders
    x.fillStyle = groove; x.fillRect(0, t0, W, th);
    x.fillStyle = '#d8d8d8';
    const n = 56, bw = W / n;
    for (let i = 0; i < n; i++) {
      const off = i % 2 ? bw * 0.5 : 0;
      x.fillRect(i * bw + 3, t0 + 2, bw - 9, th * 0.24);
      x.fillRect(i * bw + off + 3, t0 + th * 0.31, bw - 10, th * 0.17);
      x.fillRect(i * bw + (off ? 0 : bw * 0.5) + 3, t0 + th * 0.53, bw - 10, th * 0.17);
      x.fillRect(i * bw + 3, t0 + th * 0.76, bw - 9, th * 0.24 - 2);
    }
    // sidewall lugs
    x.fillStyle = '#9a9a9a';
    for (let i = 0; i < n; i++) { x.fillRect(i * bw + 6, t0 - 16, bw * 0.5, 16); x.fillRect(i * bw + 6, t1, bw * 0.5, 16); }
  } else if (kind === 'drag') {
    // slick with two shallow wear grooves
    x.fillStyle = '#b8b8b8'; x.fillRect(0, t0, W, th);
    x.fillStyle = '#7a7a7a'; x.fillRect(0, t0 + th * 0.33, W, 3); x.fillRect(0, t0 + th * 0.66, W, 3);
  } else if (kind === 'semislick') {
    x.fillStyle = groove; x.fillRect(0, t0 + th * 0.36, W, 6); x.fillRect(0, t0 + th * 0.62, W, 6);
    x.strokeStyle = groove; x.lineWidth = 5;
    for (let i = 0; i < W; i += 64) { x.beginPath(); x.moveTo(i, t0 + 2); x.lineTo(i + 30, t0 + th * 0.2); x.stroke(); x.beginPath(); x.moveTo(i + 32, t1 - 2); x.lineTo(i + 2, t1 - th * 0.2); x.stroke(); }
  } else {
    // road tyre: four circumferential grooves and angled sipes on the shoulders
    x.fillStyle = groove;
    for (const f of [0.2, 0.4, 0.6, 0.8]) x.fillRect(0, t0 + th * f - 4, W, 8);
    x.strokeStyle = groove; x.lineWidth = 4;
    for (let i = 0; i < W; i += 26) {
      x.beginPath(); x.moveTo(i, t0); x.lineTo(i + 14, t0 + th * 0.17); x.stroke();
      x.beginPath(); x.moveTo(i + 13, t1); x.lineTo(i - 1, t1 - th * 0.17); x.stroke();
      x.beginPath(); x.moveTo(i + 4, t0 + th * 0.43); x.lineTo(i + 16, t0 + th * 0.57); x.stroke();
    }
  }
  // shoulder blend and sidewall rings
  for (const [y, d] of [[t0, -1], [t1, 1]]) {
    const g = x.createLinearGradient(0, y, 0, y + d * 12);
    g.addColorStop(0, 'rgba(124,124,124,0.9)'); g.addColorStop(1, 'rgba(124,124,124,0)');
    x.fillStyle = g; x.fillRect(0, Math.min(y, y + d * 12), W, 12);
  }
  x.fillStyle = '#929292';
  for (const y of [H * 0.035, H * 0.255, H * 0.745, H * 0.965]) x.fillRect(0, y - 1.5, W, 3);
  // raised lettering on the outboard sidewall, twice round the tyre
  const band = t0 - H * 0.07, cy = H * 0.05 + band / 2;
  x.fillStyle = '#d6d6d6'; x.textAlign = 'center'; x.textBaseline = 'middle';
  const draw = (txt, cx, px, weight = 700) => {
    x.save(); x.translate(cx, cy); x.scale(1.75, -1);
    x.font = `${weight} ${px}px "Chakra Petch", "Arial Narrow", Arial, sans-serif`;
    x.fillText(txt, 0, 1); x.restore();
  };
  for (let k = 0; k < 2; k++) {
    const o = k * W / 2;
    draw('PAKSWAP', o + W * 0.115, band * 0.78);
    draw(label, o + W * 0.36, band * 0.62, 600);
  }
  const tx = tex(c, { linear: true });
  tx.wrapS = THREE.RepeatWrapping;
  tx.anisotropy = 8;
  tx.userData.tyreKey = key;
  e = { tex: tx, refs: 1, used: ++tyreStamp };
  tyres.set(key, e);
  return tx;
}
export function releaseTyreTexture(texture) {
  const e = tyres.get(texture.userData.tyreKey);
  if (!e || e.tex !== texture) return;
  e.refs = Math.max(0, e.refs - 1);
  // keep a couple of idle sizes so stepping back and forth through rim sizes is instant
  const idle = [...tyres.entries()].filter(([, v]) => v.refs === 0).sort((p, q) => p[1].used - q[1].used);
  for (const [k, v] of idle.slice(0, Math.max(0, idle.length - 3))) { v.tex.dispose(); tyres.delete(k); }
}

export function shadowTexture() {
  return cached('shadow', () => {
    const S = 256;
    const [c, x] = canvas(S, S);
    const g = x.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.85)'); g.addColorStop(0.55, 'rgba(0,0,0,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    return tex(c, { linear: true });
  });
}

export function glowTexture() {
  return cached('glow', () => {
    const S = 256;
    const [c, x] = canvas(S, S);
    const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    return tex(c, { linear: true });
  });
}

export function flameTexture() {
  return cached('flame', () => {
    const W = 128, H = 256;
    const [c, x] = canvas(W, H);
    const g = x.createRadialGradient(W / 2, H * 0.15, 2, W / 2, H * 0.4, H * 0.55);
    g.addColorStop(0, 'rgba(200,230,255,1)'); g.addColorStop(0.15, 'rgba(255,240,170,1)'); g.addColorStop(0.45, 'rgba(255,130,20,0.85)'); g.addColorStop(1, 'rgba(255,40,0,0)');
    x.fillStyle = g; x.beginPath(); x.ellipse(W / 2, H * 0.45, W * 0.42, H * 0.45, 0, 0, Math.PI * 2); x.fill();
    return tex(c);
  });
}

export function floorTexture(night) {
  return cached(`floor-${night}`, () => {
    const S = 1024;
    const [c, x] = canvas(S, S);
    const g = x.createRadialGradient(S / 2, S / 2, S * 0.04, S / 2, S / 2, S / 2);
    if (night) { g.addColorStop(0, '#262a31'); g.addColorStop(0.32, '#171a20'); g.addColorStop(0.7, '#0c0e12'); g.addColorStop(1, '#07080b'); }
    else { g.addColorStop(0, '#f4f5f6'); g.addColorStop(0.5, '#e2e4e7'); g.addColorStop(1, '#d0d3d7'); }
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    // polished epoxy speckle
    let seed = 3;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 9000; i++) { x.fillStyle = night ? `rgba(255,255,255,${rnd() * 0.03})` : `rgba(0,0,0,${rnd() * 0.03})`; x.fillRect(rnd() * S, rnd() * S, 2, 2); }
    // turntable: a fine ring with degree ticks, and a wider guide circle
    const ring = night ? 'rgba(120,214,255,' : 'rgba(40,52,66,';
    x.strokeStyle = `${ring}0.26)`; x.lineWidth = 2.5;
    x.beginPath(); x.arc(S / 2, S / 2, S * 0.29, 0, Math.PI * 2); x.stroke();
    x.strokeStyle = `${ring}0.12)`; x.lineWidth = 1.2;
    x.beginPath(); x.arc(S / 2, S / 2, S * 0.3, 0, Math.PI * 2); x.stroke();
    x.beginPath(); x.arc(S / 2, S / 2, S * 0.4, 0, Math.PI * 2); x.stroke();
    x.strokeStyle = `${ring}0.2)`; x.lineWidth = 1.5;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const r0 = S * 0.3, r1 = S * (i % 6 === 0 ? 0.316 : 0.307);
      x.beginPath(); x.moveTo(S / 2 + Math.cos(a) * r0, S / 2 + Math.sin(a) * r0); x.lineTo(S / 2 + Math.cos(a) * r1, S / 2 + Math.sin(a) * r1); x.stroke();
    }
    return tex(c);
  });
}

export function backgroundTexture(night) {
  return cached(`bg-${night}`, () => {
    const W = 64, H = 512;
    const [c, x] = canvas(W, H);
    const g = x.createLinearGradient(0, 0, 0, H);
    if (night) { g.addColorStop(0, '#04060a'); g.addColorStop(0.5, '#0b0e14'); g.addColorStop(0.62, '#10141c'); g.addColorStop(1, '#090b10'); }
    else { g.addColorStop(0, '#c4c8ce'); g.addColorStop(0.55, '#e7e9ec'); g.addColorStop(1, '#d9dce0'); }
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    return tex(c);
  });
}

export function hoseTexture() {
  return cached('hose', () => {
    const [c, x] = canvas(64, 64);
    x.fillStyle = '#ff6a00'; x.fillRect(0, 0, 64, 64);
    return tex(c);
  });
}
