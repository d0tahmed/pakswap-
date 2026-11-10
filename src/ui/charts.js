// Canvas charts and gauges, styled from CSS custom properties.
import { torqueAt, K_HP } from '../sim/powertrain.js';

// Theme colours are read from the style sheet once and remembered: asking the browser for a
// computed style on every gauge frame forces a style recalculation each time.
const cssCache = new Map();
function css(name) {
  let v = cssCache.get(name);
  if (v === undefined) { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#999'; cssCache.set(name, v); }
  return v;
}
export function resetChartColors() { cssCache.clear(); }

export function prep(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const x = canvas.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, h);
  return { x, w, h };
}

function niceStep(range, target) {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

const FONT = '"Chakra Petch", "Archivo", system-ui, sans-serif';

// Power (solid) and torque (dashed) against rpm for stock and build.
export function drawDyno(canvas, stock, build, hover) {
  const { x, w, h } = prep(canvas);
  const pad = { l: 44, r: 46, t: 14, b: 30 };
  const curves = [{ c: stock, col: css('--stock') }, { c: build, col: css('--accent') }];
  const maxR = Math.max(...curves.map((k) => (k.c.ev ? k.c.maxRpm : k.c.redline + 200)));
  let maxT = 0, maxP = 0;
  const pts = curves.map((k) => {
    const arr = [];
    const lim = k.c.ev ? k.c.maxRpm : k.c.redline + 150;
    for (let r = k.c.ev ? 0 : 800; r <= lim; r += maxR / 160) {
      const T = torqueAt(k.c, r, true); const P = (T * r) / K_HP;
      arr.push([r, T, P]); maxT = Math.max(maxT, T); maxP = Math.max(maxP, P);
    }
    return arr;
  });
  maxT *= 1.12; maxP *= 1.12;
  const X = (r) => pad.l + (r / maxR) * (w - pad.l - pad.r);
  const YT = (t) => h - pad.b - (t / maxT) * (h - pad.t - pad.b);
  const YP = (p) => h - pad.b - (p / maxP) * (h - pad.t - pad.b);
  x.font = `11px ${FONT}`; x.fillStyle = css('--muted'); x.strokeStyle = css('--grid'); x.lineWidth = 1;
  const sr = niceStep(maxR, 6);
  x.textAlign = 'center'; x.textBaseline = 'top';
  for (let r = 0; r <= maxR; r += sr) { x.beginPath(); x.moveTo(X(r), pad.t); x.lineTo(X(r), h - pad.b); x.stroke(); x.fillText(r >= 1000 ? `${r / 1000}k` : `${r}`, X(r), h - pad.b + 6); }
  const st = niceStep(maxT, 4);
  x.textAlign = 'right'; x.textBaseline = 'middle';
  for (let t = 0; t <= maxT; t += st) { x.beginPath(); x.moveTo(pad.l, YT(t)); x.lineTo(w - pad.r, YT(t)); x.stroke(); x.fillText(`${Math.round(t)}`, pad.l - 6, YT(t)); }
  const sp = niceStep(maxP, 4);
  x.textAlign = 'left';
  for (let p = 0; p <= maxP; p += sp) x.fillText(`${Math.round(p)}`, w - pad.r + 6, YP(p));
  x.save(); x.translate(10, h / 2); x.rotate(-Math.PI / 2); x.textAlign = 'center'; x.fillText('Torque Nm', 0, 0); x.restore();
  x.save(); x.translate(w - 8, h / 2); x.rotate(Math.PI / 2); x.textAlign = 'center'; x.fillText('Power hp', 0, 0); x.restore();
  x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  pts.forEach((arr, i) => {
    const col = curves[i].col;
    x.strokeStyle = col; x.lineWidth = i ? 2.4 : 1.8;
    x.setLineDash([]);
    x.beginPath(); arr.forEach(([r, , P], k) => (k ? x.lineTo(X(r), YP(P)) : x.moveTo(X(r), YP(P)))); x.stroke();
    x.setLineDash([5, 4]); x.lineWidth = i ? 2 : 1.5;
    x.beginPath(); arr.forEach(([r, T], k) => (k ? x.lineTo(X(r), YT(T)) : x.moveTo(X(r), YT(T)))); x.stroke();
    x.setLineDash([]);
    // peak marker
    let pk = arr[0]; for (const a of arr) if (a[2] > pk[2]) pk = a;
    x.fillStyle = col; x.beginPath(); x.arc(X(pk[0]), YP(pk[2]), i ? 4 : 3, 0, Math.PI * 2); x.fill();
  });
  if (hover != null) {
    const r = ((hover - pad.l) / (w - pad.l - pad.r)) * maxR;
    if (r > 0 && r < maxR) {
      x.strokeStyle = css('--fg'); x.globalAlpha = 0.4; x.beginPath(); x.moveTo(X(r), pad.t); x.lineTo(X(r), h - pad.b); x.stroke(); x.globalAlpha = 1;
      const lines = curves.map((k, i) => { const lim = k.c.ev ? k.c.maxRpm : k.c.redline + 150; if (r > lim) return null; const T = torqueAt(k.c, r, true); return [i ? 'Build' : 'Stock', Math.round((T * r) / K_HP), Math.round(T), k.col]; }).filter(Boolean);
      const bx = Math.min(X(r) + 10, w - pad.r - 128);
      x.fillStyle = css('--panel-2'); x.globalAlpha = 0.94; x.fillRect(bx, pad.t + 4, 124, 18 + lines.length * 16); x.globalAlpha = 1;
      x.fillStyle = css('--fg'); x.textAlign = 'left'; x.font = `600 11px ${FONT}`; x.fillText(`${Math.round(r)} rpm`, bx + 8, pad.t + 17);
      x.font = `11px ${FONT}`;
      lines.forEach((l, k) => { x.fillStyle = l[3]; x.fillText(`${l[0]} ${l[1]} hp  ${l[2]} Nm`, bx + 8, pad.t + 33 + k * 16); });
    }
  }
}

// Speed against time for both runs.
export function drawAccel(canvas, stockRun, buildRun) {
  const { x, w, h } = prep(canvas);
  const pad = { l: 40, r: 14, t: 14, b: 30 };
  const tMax = Math.min(32, Math.max(10, (buildRun.marks.t200 || buildRun.marks.t150 || buildRun.marks.t100 || 20) * 1.25, Math.min(32, (stockRun.marks.t100 || 20) * 1.6)));
  let vMax = 0;
  for (const r of [stockRun, buildRun]) for (let i = 0; i < r.t.length && r.t[i] <= tMax; i++) vMax = Math.max(vMax, r.v[i] * 3.6);
  vMax = Math.max(120, Math.ceil((vMax * 1.08) / 20) * 20);
  const X = (t) => pad.l + (t / tMax) * (w - pad.l - pad.r);
  const Y = (v) => h - pad.b - (v / vMax) * (h - pad.t - pad.b);
  x.font = `11px ${FONT}`; x.fillStyle = css('--muted'); x.strokeStyle = css('--grid'); x.lineWidth = 1;
  const stt = niceStep(tMax, 6);
  x.textAlign = 'center'; x.textBaseline = 'top';
  for (let t = 0; t <= tMax + 1e-6; t += stt) { x.beginPath(); x.moveTo(X(t), pad.t); x.lineTo(X(t), h - pad.b); x.stroke(); x.fillText(`${t}s`, X(t), h - pad.b + 6); }
  const sv = niceStep(vMax, 5);
  x.textAlign = 'right'; x.textBaseline = 'middle';
  for (let v = 0; v <= vMax; v += sv) { x.beginPath(); x.moveTo(pad.l, Y(v)); x.lineTo(w - pad.r, Y(v)); x.stroke(); x.fillText(`${v}`, pad.l - 6, Y(v)); }
  x.strokeStyle = css('--fg'); x.globalAlpha = 0.3; x.setLineDash([3, 4]); x.beginPath(); x.moveTo(pad.l, Y(100)); x.lineTo(w - pad.r, Y(100)); x.stroke(); x.setLineDash([]); x.globalAlpha = 1;
  [[stockRun, css('--stock'), 1.8], [buildRun, css('--accent'), 2.6]].forEach(([r, col, lw]) => {
    x.strokeStyle = col; x.lineWidth = lw; x.beginPath();
    let first = true;
    for (let i = 0; i < r.t.length && r.t[i] <= tMax; i++) { const px = X(r.t[i]), py = Y(r.v[i] * 3.6); if (first) { x.moveTo(px, py); first = false; } else x.lineTo(px, py); }
    x.stroke();
    if (r.marks.t100 && r.marks.t100 <= tMax) { x.fillStyle = col; x.beginPath(); x.arc(X(r.marks.t100), Y(100), 4, 0, Math.PI * 2); x.fill(); }
  });
  x.fillStyle = css('--muted'); x.textAlign = 'left'; x.textBaseline = 'top'; x.fillText('km/h', pad.l + 4, pad.t + 2);
}

// Tachometer with speed and gear readout.
export function drawTacho(canvas, s) {
  const { x, w, h } = prep(canvas);
  const cx = w / 2, cy = h * 0.56, R = Math.min(w, h * 1.5) * 0.44;
  const a0 = Math.PI * 0.78, a1 = Math.PI * 2.22;
  const max = s.maxRpm;
  const A = (r) => a0 + (Math.min(r, max) / max) * (a1 - a0);
  x.lineCap = 'round';
  x.strokeStyle = css('--grid'); x.lineWidth = 6; x.beginPath(); x.arc(cx, cy, R, a0, a1); x.stroke();
  if (!s.ev) { x.strokeStyle = css('--bad'); x.lineWidth = 6; x.beginPath(); x.arc(cx, cy, R, A(s.redline), a1); x.stroke(); }
  // live arc
  const frac = Math.max(0, Math.min(1, s.rpm / max));
  const g = x.createLinearGradient(cx - R, 0, cx + R, 0); g.addColorStop(0, css('--accent')); g.addColorStop(1, css('--accent-2'));
  x.strokeStyle = g; x.lineWidth = 6; x.beginPath(); x.arc(cx, cy, R, a0, a0 + frac * (a1 - a0)); x.stroke();
  // ticks
  const step = max > 12000 ? 2000 : 1000;
  x.fillStyle = css('--muted'); x.font = `600 10px ${FONT}`; x.textAlign = 'center'; x.textBaseline = 'middle';
  for (let r = 0; r <= max + 1; r += step) {
    const a = A(r);
    x.strokeStyle = r >= s.redline && !s.ev ? css('--bad') : css('--muted'); x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(cx + Math.cos(a) * (R - 12), cy + Math.sin(a) * (R - 12)); x.lineTo(cx + Math.cos(a) * (R - 4), cy + Math.sin(a) * (R - 4)); x.stroke();
    x.fillText(`${r / 1000}`, cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24));
  }
  // needle
  const an = A(s.rpm);
  x.strokeStyle = css('--accent-2'); x.lineWidth = 3;
  x.beginPath(); x.moveTo(cx - Math.cos(an) * 10, cy - Math.sin(an) * 10); x.lineTo(cx + Math.cos(an) * (R - 8), cy + Math.sin(an) * (R - 8)); x.stroke();
  x.fillStyle = css('--fg'); x.beginPath(); x.arc(cx, cy, 5, 0, Math.PI * 2); x.fill();
  // readouts
  x.fillStyle = css('--fg'); x.font = `700 ${Math.round(R * 0.42)}px ${FONT}`; x.textBaseline = 'alphabetic';
  x.fillText(`${Math.round(s.speed)}`, cx, cy + R * 0.5);
  x.font = `600 10px ${FONT}`; x.fillStyle = css('--muted');
  x.fillText('KM/H', cx, cy + R * 0.66);
  x.font = `700 ${Math.round(R * 0.22)}px ${FONT}`; x.fillStyle = css('--accent-2');
  x.fillText(s.ev ? 'D' : s.gear ? String(s.gear) : 'N', cx, cy - R * 0.32);
  x.font = `600 10px ${FONT}`; x.fillStyle = css('--muted');
  x.fillText(`${Math.round(s.rpm)} rpm`, cx, cy - R * 0.08);
  if (s.boostOn) {
    const bw = R * 1.1, bx = cx - bw / 2, by = h - 8;
    x.fillStyle = css('--grid'); x.fillRect(bx, by, bw, 3);
    x.fillStyle = css('--accent'); x.fillRect(bx, by, bw * Math.max(0, Math.min(1, s.boost)), 3);
  }
}

// Two-lane drag strip.
export function drawDrag(canvas, lanes, t) {
  const { x, w, h } = prep(canvas);
  const pad = 14, lh = (h - pad * 2) / lanes.length;
  const dist = 402.336;
  x.fillStyle = css('--panel-2'); x.fillRect(0, 0, w, h);
  x.strokeStyle = css('--grid'); x.lineWidth = 1;
  for (let i = 0; i <= lanes.length; i++) { x.beginPath(); x.moveTo(pad, pad + i * lh); x.lineTo(w - pad, pad + i * lh); x.stroke(); }
  x.setLineDash([2, 6]);
  for (let m = 100; m < dist; m += 100) { const px = pad + (m / dist) * (w - pad * 2 - 40); x.beginPath(); x.moveTo(px, pad); x.lineTo(px, h - pad); x.stroke(); }
  x.setLineDash([]);
  const fx = pad + (w - pad * 2 - 40);
  for (let k = 0; k < 8; k++) { x.fillStyle = k % 2 ? css('--fg') : css('--bg'); x.fillRect(fx, pad + (k * (h - pad * 2)) / 8, 6, (h - pad * 2) / 8); }
  lanes.forEach((ln, i) => {
    const r = ln.run;
    let j = 0; while (j < r.t.length - 1 && r.t[j + 1] < t) j++;
    const xp = Math.min(dist, r.x[j] || 0);
    const px = pad + (xp / dist) * (w - pad * 2 - 40);
    const cy = pad + i * lh + lh / 2;
    x.fillStyle = ln.color;
    const cw = 34, ch = Math.min(14, lh * 0.4);
    x.beginPath(); x.roundRect ? x.roundRect(px, cy - ch / 2, cw, ch, 4) : x.rect(px, cy - ch / 2, cw, ch); x.fill();
    x.fillStyle = css('--bg'); x.fillRect(px + cw * 0.55, cy - ch / 2 + 2, cw * 0.22, ch - 4);
    x.fillStyle = css('--fg'); x.font = `600 11px ${FONT}`; x.textAlign = 'left'; x.textBaseline = 'bottom';
    x.fillText(ln.label, pad + 4, pad + i * lh + lh * 0.32);
    x.textAlign = 'right'; x.fillStyle = css('--muted');
    x.fillText(`${Math.round((r.v[j] || 0) * 3.6)} km/h`, w - pad - 46, pad + i * lh + lh * 0.32);
  });
}
