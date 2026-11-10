// Drive HUD: instrument cluster, minimap, lap and drift panels, messages, menu and touch controls.
const fmtTime = (t) => {
  if (t == null || !isFinite(t)) return '-:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};
const fmtDelta = (d) => (d == null || !isFinite(d) ? '' : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(3)}`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6v12M15 6v12"/></svg>',
  exit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5V14"/><path d="M12 17.2v.1"/></svg>',
};

export class DriveHud {
  constructor(host, opts) {
    this.host = host;
    this.opts = opts;
    const el = document.createElement('div');
    el.className = 'dv';
    el.innerHTML = `
      <div class="dv-top">
        <div class="dv-panel dv-session">
          <div class="dv-area"><b class="dv-areaname">Drift Park</b><span class="dv-road"></span></div>
          <div class="dv-lap" hidden>
            <div class="dv-row big"><span class="k">Lap <b class="dv-lapn">1</b></span><span class="v dv-cur">-:--.---</span></div>
            <div class="dv-row"><span class="k">Last</span><span class="v dv-last">-:--.---</span></div>
            <div class="dv-row"><span class="k">Best</span><span class="v dv-best">-:--.---</span></div>
            <div class="dv-row"><span class="k">Delta</span><span class="v dv-delta"></span></div>
            <div class="dv-flag" hidden>Lap invalid</div>
          </div>
          <div class="dv-drift">
            <div class="dv-row big"><span class="k">Drift</span><span class="v dv-chain">0</span></div>
            <div class="dv-row"><span class="k">Best run</span><span class="v dv-dbest">0</span></div>
            <div class="dv-row"><span class="k">Session</span><span class="v dv-total">0</span></div>
          </div>
        </div>
        <div class="dv-center">
          <div class="dv-angle" hidden><canvas class="dv-anglecv" width="220" height="70"></canvas><div class="dv-angletxt"><b class="dv-deg">0&deg;</b><span class="dv-mult">x1</span><span class="dv-pts">0</span></div></div>
          <div class="dv-msg" aria-live="polite"></div>
        </div>
        <div class="dv-tools">
          <button type="button" class="dv-btn" data-dv="camera" aria-label="Change camera (C)">${ICON.cam}<span class="dv-camname">Chase</span></button>
          <button type="button" class="dv-btn icon" data-dv="help" aria-label="Controls (F1)">${ICON.help}</button>
          <button type="button" class="dv-btn icon" data-dv="full" aria-label="Fullscreen (F)">${ICON.full}</button>
          <button type="button" class="dv-btn icon" data-dv="menu" aria-label="Pause menu (Esc)">${ICON.menu}</button>
          <button type="button" class="dv-btn icon" data-dv="exit" aria-label="Back to garage">${ICON.exit}</button>
        </div>
      </div>
      <canvas class="dv-map" width="190" height="190" aria-label="Radar map"></canvas>
      <div class="dv-cluster"><canvas class="dv-tach" width="250" height="250" aria-label="Speed and revs"></canvas>
        <div class="dv-lamps"><span data-l="abs">ABS</span><span data-l="tcs">TCS</span><span data-l="esc">ESC</span><span data-l="nos">NOS</span><span data-l="mode">AUTO</span></div>
      </div>
      <div class="dv-help" hidden>
        <div class="dv-help-in">
          <h3>Controls</h3>
          <div class="dv-keys">
            <span><kbd>W</kbd> <kbd>&uarr;</kbd></span><span>Throttle</span>
            <span><kbd>S</kbd> <kbd>&darr;</kbd></span><span>Brake, hold to reverse</span>
            <span><kbd>A</kbd> <kbd>D</kbd> <kbd>&larr;</kbd> <kbd>&rarr;</kbd></span><span>Steer</span>
            <span><kbd>Space</kbd></span><span>Handbrake</span>
            <span><kbd>E</kbd> <kbd>Q</kbd></span><span>Gear up / down (manual)</span>
            <span><kbd>M</kbd></span><span>Manual or automatic gearbox</span>
            <span><kbd>N</kbd></span><span>Nitrous (if fitted)</span>
            <span><kbd>C</kbd> <kbd>V</kbd></span><span>Camera / look back</span>
            <span><kbd>R</kbd></span><span>Reset the car</span>
            <span><kbd>H</kbd> <kbd>L</kbd></span><span>Horn / headlights</span>
            <span><kbd>I</kbd></span><span>Engine on / off</span>
            <span><kbd>Esc</kbd></span><span>Pause menu</span>
          </div>
          <p>Gamepad: right trigger throttle, left trigger brake, left stick steer, A handbrake, bumpers shift, X nitrous, Y camera, B horn, right stick look around.</p>
          <p>Mouse: drag the view to look around the car.</p>
          <button type="button" class="dv-btn primary" data-dv="help">Got it</button>
        </div>
      </div>
      <div class="dv-menu" hidden>
        <div class="dv-menu-in" role="dialog" aria-modal="true" aria-label="Pause menu">
          <div class="dv-menu-head"><h3>Paused</h3><span class="dv-build"></span></div>
          <div class="dv-sec dv-mapsec"><div class="dv-lbl">Map: tap a place to drive there</div><div class="dv-wmapwrap"><canvas class="dv-wmap" width="520" height="520" aria-label="World map"></canvas></div><div class="dv-opts" data-grp="loc"></div></div>
          <div class="dv-sec"><div class="dv-lbl">Time of day</div><div class="dv-opts" data-grp="time">
            <button type="button" data-dv="time" data-v="day">Afternoon</button><button type="button" data-dv="time" data-v="evening">Sunset</button><button type="button" data-dv="time" data-v="night">Night</button></div></div>
          <div class="dv-sec"><div class="dv-lbl">Driving aids</div><div class="dv-opts" data-grp="aids">
            <button type="button" data-dv="aids" data-v="drift">Drift<small>Holds the slide, no traction control</small></button>
            <button type="button" data-dv="aids" data-v="grip">Grip<small>Traction and stability control</small></button>
            <button type="button" data-dv="aids" data-v="sim">Off<small>No help, pure physics</small></button></div></div>
          <div class="dv-sec"><div class="dv-lbl">Gearbox</div><div class="dv-opts" data-grp="gear">
            <button type="button" data-dv="gear" data-v="auto">Automatic</button><button type="button" data-dv="gear" data-v="manual">Manual (E / Q)</button></div></div>
          <div class="dv-sec"><div class="dv-lbl">Camera</div><div class="dv-opts" data-grp="cam"></div></div>
          <div class="dv-sec dv-row2"><label class="dv-vol">Volume <input type="range" min="0" max="1" step="0.01" class="dv-volin"></label></div>
          <div class="dv-menu-foot">
            <button type="button" class="dv-btn" data-dv="reset">Reset car</button>
            <button type="button" class="dv-btn" data-dv="exit">Back to garage</button>
            <button type="button" class="dv-btn primary" data-dv="menu">Resume</button>
          </div>
        </div>
      </div>
      <div class="dv-touch" hidden>
        <div class="dv-tl"><button type="button" data-t="left" aria-label="Steer left">&#9664;</button><button type="button" data-t="right" aria-label="Steer right">&#9654;</button></div>
        <div class="dv-tr">
          <div class="dv-tcol"><button type="button" data-t="hand" class="sm">HB</button><button type="button" data-t="nos" class="sm">NOS</button></div>
          <button type="button" data-t="brake" class="ped">BRAKE</button><button type="button" data-t="gas" class="ped gas">GAS</button>
        </div>
      </div>
      <div class="dv-loading"><div><b>Building the drift park</b><span>Track, lights and sky</span><i></i></div></div>`;
    host.appendChild(el);
    this.el = el;
    const q = (s) => el.querySelector(s);
    this.$ = q;
    this.tach = q('.dv-tach'); this.tctx = this.tach.getContext('2d');
    this.map = q('.dv-map'); this.mctx = this.map.getContext('2d');
    this.anglecv = q('.dv-anglecv'); this.actx = this.anglecv.getContext('2d');
    this.msgEl = q('.dv-msg');
    this.msgT = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [this.tach, this.map, this.anglecv]) { const w = c.width, h = c.height; c.style.width = w + 'px'; c.style.height = h + 'px'; c.width = w * this.dpr; c.height = h * this.dpr; c.getContext('2d').setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-dv]');
      if (!b) return;
      opts.onAction?.(b.dataset.dv, b.dataset.v);
    });
    const vol = q('.dv-volin');
    vol.addEventListener('input', () => opts.onAction?.('volume', +vol.value));
    this.lastTach = 0;
  }

  loading(on) { this.$('.dv-loading').hidden = !on; this.$('.dv-loading').classList.toggle('show', on); }

  setMode(loc) {
    for (const b of this.el.querySelectorAll('[data-dv="loc"]')) b.setAttribute('aria-pressed', String(b.dataset.v === loc));
  }

  setArea(name, road, onCircuit) {
    if (this._area !== name) { this.$('.dv-areaname').textContent = name; this._area = name; }
    if (this._road !== road) { this.$('.dv-road').textContent = road || ''; this._road = road; }
    if (this._circ !== onCircuit) { this.$('.dv-lap').hidden = !onCircuit; this._circ = onCircuit; }
  }

  setLocations(list) {
    this.locs = list;
    this.$('[data-grp="loc"]').innerHTML = list.map((l) => `<button type="button" data-dv="loc" data-v="${l.id}">${esc(l.label)}</button>`).join('');
  }

  setOptions(o) {
    const set = (grp, v) => { for (const b of this.el.querySelectorAll(`[data-dv="${grp}"]`)) if (b.closest('.dv-menu') || grp === 'loc') b.setAttribute('aria-pressed', String(b.dataset.v === v)); };
    if (o.time) set('time', o.time);
    if (o.aids) set('aids', o.aids);
    if (o.gear) { set('gear', o.gear); this.lamp('mode', o.gear === 'manual' ? 'MAN' : 'AUTO', true); }
    if (o.cams) this.$('[data-grp="cam"]').innerHTML = o.cams.map((c) => `<button type="button" data-dv="cam" data-v="${c.id}">${esc(c.label)}</button>`).join('');
    if (o.cam) { set('cam', o.cam); const c = (o.cams || this.cams || []).find((x) => x.id === o.cam); if (c) this.$('.dv-camname').textContent = c.label; }
    if (o.cams) this.cams = o.cams;
    if (o.volume != null) this.$('.dv-volin').value = o.volume;
    if (o.build) this.$('.dv-build').textContent = o.build;
    if (o.touch != null) this.$('.dv-touch').hidden = !o.touch;
  }

  lamp(name, text, on) {
    const l = this.el.querySelector(`[data-l="${name}"]`);
    if (!l) return;
    if (text != null && l.textContent !== text) l.textContent = text;
    l.classList.toggle('on', !!on);
  }

  menu(open) { this.$('.dv-menu').hidden = !open; }
  get menuOpen() { return !this.$('.dv-menu').hidden; }
  help(open) { this.$('.dv-help').hidden = !open; }
  get helpOpen() { return !this.$('.dv-help').hidden; }

  message(text, kind = '', dur = 2.2) {
    this.msgEl.textContent = text;
    this.msgEl.className = 'dv-msg show ' + kind;
    this.msgT = dur;
  }

  tick(dt) {
    if (this.msgT > 0) { this.msgT -= dt; if (this.msgT <= 0) this.msgEl.classList.remove('show'); }
  }

  setLap(L) {
    this.$('.dv-lapn').textContent = L.lap;
    this.$('.dv-cur').textContent = fmtTime(L.cur);
    this.$('.dv-last').textContent = fmtTime(L.last);
    this.$('.dv-best').textContent = fmtTime(L.best);
    const d = this.$('.dv-delta');
    d.textContent = fmtDelta(L.delta);
    d.className = 'v dv-delta ' + (L.delta == null ? '' : L.delta <= 0 ? 'good' : 'bad');
    this.$('.dv-flag').hidden = !L.invalid;
  }

  setDrift(D) {
    this.$('.dv-chain').textContent = Math.round(D.chain).toLocaleString('en-US');
    this.$('.dv-dbest').textContent = Math.round(D.best).toLocaleString('en-US');
    this.$('.dv-total').textContent = Math.round(D.total).toLocaleString('en-US');
    const box = this.$('.dv-angle');
    box.hidden = !D.active && D.chain <= 0;
    if (!box.hidden) {
      this.$('.dv-deg').textContent = `${Math.round(Math.abs(D.angle))}°`;
      this.$('.dv-mult').textContent = `x${D.mult}`;
      this.$('.dv-pts').textContent = Math.round(D.chain).toLocaleString('en-US');
      box.classList.toggle('live', D.active);
      const x = this.actx, W = 220, H = 70;
      x.clearRect(0, 0, W, H);
      // slip angle scale -60..60 degrees
      const cx = W / 2, y = 54, span = 92;
      x.strokeStyle = 'rgba(239,233,224,0.25)'; x.lineWidth = 2;
      x.beginPath(); x.moveTo(cx - span, y); x.lineTo(cx + span, y); x.stroke();
      for (let a = -60; a <= 60; a += 15) { const px = cx + (a / 60) * span; x.beginPath(); x.moveTo(px, y - (a % 30 ? 4 : 8)); x.lineTo(px, y); x.stroke(); }
      const px = cx + Math.max(-1, Math.min(1, D.angle / 60)) * span;
      x.fillStyle = D.active ? '#f5b301' : 'rgba(239,233,224,0.5)';
      x.beginPath(); x.moveTo(px, y - 12); x.lineTo(px - 6, y - 22); x.lineTo(px + 6, y - 22); x.closePath(); x.fill();
      // chain timer bar (time left to keep the combo)
      x.fillStyle = 'rgba(245,179,1,0.85)'; x.fillRect(cx - span, y + 6, span * 2 * Math.max(0, Math.min(1, D.keep)), 3);
    }
  }

  // ---------------------------------------------------------------- maps: radar (heading up) and the world map
  setMapData(world) {
    const B = world.bounds, mpp = 3;
    const W = Math.round((B.x1 - B.x0) / mpp), H = Math.round((B.y1 - B.y0) / mpp);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    const img = x.createImageData(W, H);
    const HF = world.HF, L = world.lake;
    for (let j = 0; j < H; j++) {
      const wy = B.y1 - (j + 0.5) * mpp;
      for (let i = 0; i < W; i++) {
        const wx = B.x0 + (i + 0.5) * mpp;
        const h = HF.heightAt(wx, wy), g = HF.gradAt(wx, wy);
        const shade = Math.max(0.55, Math.min(1.2, 1 + (-g[0] * 0.6 + g[1] * 0.6) * 1.2));
        let r = 62, gg = 82, b = 52;
        if (h > 160) { const k = Math.min(1, (h - 160) / 260); r += (110 - r) * k; gg += (104 - gg) * k; b += (92 - b) * k; }
        const dl = Math.hypot((wx - L.x) / L.rx, (wy - L.y) / L.ry);
        if (h < L.level - 0.2 && dl < 1.5) { r = 40; gg = 86; b = 120; }
        const o = (j * W + i) * 4;
        img.data[o] = r * shade; img.data[o + 1] = gg * shade; img.data[o + 2] = b * shade; img.data[o + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);
    const P = (wx, wy) => [(wx - B.x0) / mpp, (B.y1 - wy) / mpp];
    // park, city blocks, village
    const rect = (r, col) => { const [a, b2] = P(r.x0, r.y1), [cc, d] = P(r.x1, r.y0); x.fillStyle = col; x.fillRect(a, b2, cc - a, d - b2); };
    rect({ x0: -470, y0: -340, x1: 470, y1: 340 }, 'rgba(90,110,70,0.6)');
    rect(world.park.pad, 'rgba(120,120,116,0.9)');
    for (const b of world.city.buildings) rect(b, 'rgba(196,184,160,0.9)');
    for (const h of world.village.houses) rect({ x0: h.x - h.w / 2, y0: h.y - h.d / 2, x1: h.x + h.w / 2, y1: h.y + h.d / 2 }, 'rgba(170,130,90,0.95)');
    x.lineJoin = 'round'; x.lineCap = 'round';
    for (const rd of world.roads) {
      const w = Math.max(1.4, (rd.type.half * 2) / mpp);
      x.strokeStyle = rd.typeName === 'motorway' ? '#e3b23c' : rd.typeName === 'dirt' ? 'rgba(150,120,90,0.9)' : '#e9e5dc';
      x.lineWidth = w + (rd.typeName === 'dirt' ? 0 : 1.5);
      x.beginPath();
      for (let i = 0; i < rd.rb.n; i += 2) { const [px, py] = P(rd.rb.x[i], rd.rb.y[i]); if (i) x.lineTo(px, py); else x.moveTo(px, py); }
      if (rd.closed) x.closePath();
      x.stroke();
    }
    const cc = world.circuit;
    x.strokeStyle = '#d9d6cf'; x.lineWidth = (cc.half * 2) / mpp;
    x.beginPath(); for (let i = 0; i <= cc.n; i += 2) { const k = i % cc.n; const [px, py] = P(cc.x[k], cc.y[k]); if (i) x.lineTo(px, py); else x.moveTo(px, py); } x.closePath(); x.stroke();
    this.mapBg = c;
    this.mapInfo = { B, mpp, W, H, P };
  }

  drawMap(carX, carY, psi) {
    if (!this.mapBg) return;
    const x = this.mctx, S = 190, cx = S / 2, cy = S / 2, R = S / 2 - 3;
    const { B, mpp } = this.mapInfo;
    const zoom = 1.35; // px per map pixel (map is 3 m per pixel)
    x.clearRect(0, 0, S, S);
    x.save();
    x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.closePath();
    x.fillStyle = 'rgba(14,13,12,0.85)'; x.fill();
    x.clip();
    x.translate(cx, cy);
    x.rotate(psi - Math.PI / 2);
    const px = (carX - B.x0) / mpp, py = (B.y1 - carY) / mpp;
    x.globalAlpha = 0.92;
    x.drawImage(this.mapBg, -px * zoom, -py * zoom, this.mapBg.width * zoom, this.mapBg.height * zoom);
    x.globalAlpha = 1;
    x.restore();
    // vignette ring and the car
    x.strokeStyle = 'rgba(239,233,224,0.25)'; x.lineWidth = 2; x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.stroke();
    // north marker
    const na = -(psi - Math.PI / 2) - Math.PI / 2;
    x.fillStyle = '#f5b301'; x.font = '700 11px "Chakra Petch", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('N', cx + Math.cos(na) * (R - 10), cy + Math.sin(na) * (R - 10));
    x.fillStyle = '#f5b301'; x.strokeStyle = '#121110'; x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(cx, cy - 8); x.lineTo(cx + 5.5, cy + 6); x.lineTo(cx, cy + 3); x.lineTo(cx - 5.5, cy + 6); x.closePath(); x.fill(); x.stroke();
  }

  drawWorldMap(carX, carY, psi, markers) {
    if (!this.mapBg) return;
    const c = this.$('.dv-wmap');
    if (!this.wctx) {
      const w = c.width, h = c.height;
      c.style.width = '100%'; c.style.height = 'auto';
      c.width = w * this.dpr; c.height = h * this.dpr;
      this.wctx = c.getContext('2d'); this.wctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.wsize = w;
      c.addEventListener('click', (ev) => {
        const r = c.getBoundingClientRect();
        const mx = ((ev.clientX - r.left) / r.width) * this.wsize, my = ((ev.clientY - r.top) / r.height) * this.wsize;
        let best = null, bd = 26 * 26;
        for (const m of this.markers || []) { const d = (m.px - mx) ** 2 + (m.py - my) ** 2; if (d < bd) { bd = d; best = m; } }
        if (best) this.opts.onAction?.('loc', best.id);
      });
    }
    const x = this.wctx, S = this.wsize, { B, mpp } = this.mapInfo;
    const k = S / this.mapBg.width;
    x.clearRect(0, 0, S, S);
    x.drawImage(this.mapBg, 0, 0, S, S);
    const P = (wx, wy) => [((wx - B.x0) / mpp) * k, ((B.y1 - wy) / mpp) * k];
    this.markers = (markers || []).map((m) => { const [px, py] = P(m.x, m.y); return { ...m, px, py }; });
    x.font = '700 12px "Chakra Petch", Arial, sans-serif'; x.textAlign = 'left'; x.textBaseline = 'middle';
    for (const m of this.markers) {
      x.fillStyle = '#121110'; x.beginPath(); x.arc(m.px, m.py, 7, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#2cc3b3'; x.beginPath(); x.arc(m.px, m.py, 5, 0, Math.PI * 2); x.fill();
      x.fillStyle = 'rgba(14,13,12,0.75)'; const tw = x.measureText(m.label).width; x.fillRect(m.px + 9, m.py - 9, tw + 8, 18);
      x.fillStyle = '#efe9e0'; x.fillText(m.label, m.px + 13, m.py);
    }
    const [cx, cy] = P(carX, carY);
    x.save(); x.translate(cx, cy); x.rotate(-psi);
    x.fillStyle = '#f5b301'; x.strokeStyle = '#121110'; x.lineWidth = 1.5;
    x.beginPath(); x.moveTo(9, 0); x.lineTo(-6, 5.5); x.lineTo(-3, 0); x.lineTo(-6, -5.5); x.closePath(); x.fill(); x.stroke();
    x.restore();
  }

  // ---------------------------------------------------------------- instrument cluster
  drawTach(s) {
    const x = this.tctx, W = 250, H = 250, cx = W / 2, cy = H / 2 + 6, R = 104;
    x.clearRect(0, 0, W, H);
    const maxR = s.maxRpm, red = s.redline;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    const ang = (r) => a0 + (a1 - a0) * Math.max(0, Math.min(1, r / maxR));
    // dial face
    const g = x.createRadialGradient(cx, cy, R * 0.2, cx, cy, R + 14);
    g.addColorStop(0, 'rgba(22,21,19,0.88)'); g.addColorStop(1, 'rgba(10,10,9,0.92)');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, R + 14, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(239,233,224,0.12)'; x.lineWidth = 1; x.stroke();
    // redline band
    x.strokeStyle = 'rgba(232,58,46,0.85)'; x.lineWidth = 7;
    x.beginPath(); x.arc(cx, cy, R - 4, ang(red), a1); x.stroke();
    // rpm fill
    x.strokeStyle = s.rpm >= red * 0.97 ? '#ff4b3a' : '#f5b301'; x.lineWidth = 3.5;
    x.beginPath(); x.arc(cx, cy, R + 4, a0, ang(s.rpm)); x.stroke();
    // ticks and numbers
    const step = maxR > 12000 ? 2000 : 1000;
    x.fillStyle = '#d8d2c8'; x.font = '600 13px "Chakra Petch", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    for (let r = 0; r <= maxR + 1; r += step / 2) {
      const a = ang(r), major = r % step === 0;
      x.strokeStyle = r >= red ? 'rgba(255,90,70,0.95)' : 'rgba(239,233,224,0.75)'; x.lineWidth = major ? 2.4 : 1.2;
      const r0 = R - (major ? 15 : 9);
      x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * (R - 1), cy + Math.sin(a) * (R - 1)); x.stroke();
      if (major) x.fillText(String(r / 1000), cx + Math.cos(a) * (R - 28), cy + Math.sin(a) * (R - 28));
    }
    x.fillStyle = 'rgba(166,157,144,0.9)'; x.font = '600 9px "Chakra Petch", Arial, sans-serif';
    x.fillText(s.ev ? 'x1000 rpm motor' : 'x1000 rpm', cx, cy + 74);
    // needle
    const an = ang(s.rpm);
    x.strokeStyle = '#ff5a2a'; x.lineWidth = 3; x.lineCap = 'round';
    x.shadowColor = 'rgba(255,90,42,0.6)'; x.shadowBlur = 8;
    x.beginPath(); x.moveTo(cx - Math.cos(an) * 14, cy - Math.sin(an) * 14); x.lineTo(cx + Math.cos(an) * (R - 6), cy + Math.sin(an) * (R - 6)); x.stroke();
    x.shadowBlur = 0;
    x.fillStyle = '#1b1a18'; x.beginPath(); x.arc(cx, cy, 9, 0, Math.PI * 2); x.fill();
    // speed and gear
    x.fillStyle = '#f2ede4'; x.font = '700 46px "Chakra Petch", Arial, sans-serif';
    x.fillText(String(Math.round(s.kmh)), cx, cy + 34);
    x.fillStyle = 'rgba(166,157,144,0.95)'; x.font = '600 11px "Chakra Petch", Arial, sans-serif';
    x.fillText('km/h', cx, cy + 60);
    // gear box above the hub
    x.fillStyle = 'rgba(14,13,12,0.85)'; x.strokeStyle = 'rgba(245,179,1,0.6)'; x.lineWidth = 1.2;
    x.beginPath(); x.roundRect ? x.roundRect(cx - 16, cy - 56, 32, 32, 6) : x.rect(cx - 16, cy - 56, 32, 32); x.fill(); x.stroke();
    x.fillStyle = s.gear === 'R' ? '#ff6a5c' : '#f5b301'; x.font = '700 23px "Chakra Petch", Arial, sans-serif';
    x.fillText(s.gear, cx, cy - 39);
    // shift lights
    if (!s.ev) {
      const n = 7, frac = (s.rpm - red * 0.78) / (red * 0.2);
      const flash = s.rpm >= red * 0.985 && Math.floor(performance.now() / 70) % 2 === 0;
      for (let i = 0; i < n; i++) {
        const lit = frac * n > i;
        const col = i < 3 ? '#3ad17d' : i < 5 ? '#f5b301' : '#ff3b2f';
        x.fillStyle = flash ? '#5aa8ff' : lit ? col : 'rgba(239,233,224,0.12)';
        x.beginPath(); x.arc(cx - 48 + i * 16, cy - 72, 4.2, 0, Math.PI * 2); x.fill();
      }
    }
    // boost and nitrous bars
    let by = cy + 84;
    if (s.boostOn) {
      x.fillStyle = 'rgba(239,233,224,0.12)'; x.fillRect(cx - 50, by, 100, 4);
      x.fillStyle = '#2cc3b3'; x.fillRect(cx - 50, by, 100 * Math.max(0, Math.min(1, s.boost)), 4);
      x.fillStyle = 'rgba(166,157,144,0.9)'; x.font = '600 9px "Chakra Petch", Arial, sans-serif'; x.textAlign = 'right';
      x.fillText('BOOST', cx - 56, by + 2); x.textAlign = 'center';
      by += 10;
    }
    if (s.nosCap > 0) {
      x.fillStyle = 'rgba(239,233,224,0.12)'; x.fillRect(cx - 50, by, 100, 4);
      x.fillStyle = s.nosOn ? '#7fb6ff' : '#4a7fd1'; x.fillRect(cx - 50, by, 100 * Math.max(0, Math.min(1, s.nos / s.nosCap)), 4);
      x.fillStyle = 'rgba(166,157,144,0.9)'; x.font = '600 9px "Chakra Petch", Arial, sans-serif'; x.textAlign = 'right';
      x.fillText('N2O', cx - 56, by + 2); x.textAlign = 'center';
    }
  }

  dispose() { this.el.remove(); }
}
