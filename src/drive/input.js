// Driver input: keyboard with analogue-style smoothing, gamepad, on-screen touch pedals and
// mouse or right-stick look-around. Actions (gear shifts, camera, reset...) go to a callback.
const KEYS = {
  throttle: ['KeyW', 'ArrowUp'], brake: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'], nitrous: ['KeyN', 'ShiftRight'], horn: ['KeyH'], lookBack: ['KeyV'],
};
const ACTIONS = { KeyE: 'shiftUp', KeyQ: 'shiftDown', KeyC: 'camera', KeyR: 'reset', KeyM: 'gearbox', KeyL: 'lights', KeyI: 'engine', Escape: 'menu', KeyP: 'menu', F1: 'help', KeyF: 'fullscreen', KeyT: 'time', KeyK: 'aids' };

export class DriveInput {
  constructor(canvas, onAction) {
    this.canvas = canvas;
    this.onAction = onAction;
    this.down = new Set();
    this.out = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitrous: false, horn: false, lookBack: false, lookX: 0, lookY: 0, device: 'keyboard' };
    this.kSteer = 0; this.kThr = 0; this.kBrk = 0;
    this.touch = { left: false, right: false, gas: false, brake: false, hand: false, nos: false };
    this.mouse = { dragging: false, dx: 0, dy: 0, id: null, lx: 0, ly: 0 };
    this.padPrev = [];
    this.onKeyDown = (e) => {
      if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return;
      const c = e.code;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F1', 'Tab'].includes(c)) e.preventDefault();
      if (!this.down.has(c) && ACTIONS[c]) this.onAction(ACTIONS[c]);
      this.down.add(c);
      this.out.device = 'keyboard';
    };
    this.onKeyUp = (e) => { this.down.delete(e.code); };
    this.onBlur = () => this.down.clear();
    this.onPDown = (e) => {
      if (e.pointerType === 'touch') return;
      this.mouse.dragging = true; this.mouse.id = e.pointerId; this.mouse.lx = e.clientX; this.mouse.ly = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
    };
    this.onPMove = (e) => {
      if (!this.mouse.dragging || e.pointerId !== this.mouse.id) return;
      this.mouse.dx += e.clientX - this.mouse.lx; this.mouse.dy += e.clientY - this.mouse.ly;
      this.mouse.lx = e.clientX; this.mouse.ly = e.clientY;
    };
    this.onPUp = (e) => { if (e.pointerId === this.mouse.id) { this.mouse.dragging = false; this.mouse.id = null; } };
    this.onWheel = (e) => { this.wheelDelta = (this.wheelDelta || 0) + Math.sign(e.deltaY); };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('pointerdown', this.onPDown);
    window.addEventListener('pointermove', this.onPMove);
    window.addEventListener('pointerup', this.onPUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: true });
  }

  // on-screen buttons: element with data-t = left | right | gas | brake | hand | nos
  bindTouch(root) {
    const set = (t, v) => { if (t in this.touch) this.touch[t] = v; this.out.device = 'touch'; };
    const active = new Map();
    root.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      e.preventDefault(); b.setPointerCapture?.(e.pointerId);
      active.set(e.pointerId, b.dataset.t); set(b.dataset.t, true); b.classList.add('on');
    });
    const up = (e) => { const t = active.get(e.pointerId); if (!t) return; active.delete(e.pointerId); set(t, false); root.querySelector(`[data-t="${t}"]`)?.classList.remove('on'); };
    root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up); root.addEventListener('lostpointercapture', up);
  }

  key(name) { return KEYS[name].some((k) => this.down.has(k)); }

  update(dt, speed = 0) {
    const o = this.out;
    // keyboard and touch: ramped like a real pedal and steering wheel
    const left = this.key('left') || this.touch.left, right = this.key('right') || this.touch.right;
    const wantS = (left ? 1 : 0) - (right ? 1 : 0);
    const back = wantS === 0 || Math.sign(wantS) !== Math.sign(this.kSteer);
    const rate = back ? 5.5 : 2.6 / (1 + speed / 40);
    this.kSteer += Math.max(-rate * dt, Math.min(rate * dt, wantS - this.kSteer));
    const thr = this.key('throttle') || this.touch.gas, brk = this.key('brake') || this.touch.brake;
    this.kThr += Math.max(-dt * 7, Math.min(dt * 5.5, (thr ? 1 : 0) - this.kThr));
    this.kBrk += Math.max(-dt * 8, Math.min(dt * 7, (brk ? 1 : 0) - this.kBrk));
    let steer = this.kSteer, throttle = this.kThr, brake = this.kBrk;
    let handbrake = this.key('handbrake') || this.touch.hand ? 1 : 0;
    let nitrous = this.key('nitrous') || this.touch.nos;
    let horn = this.key('horn'), lookBack = this.key('lookBack');
    let lookX = 0, lookY = 0;
    // gamepad (standard mapping)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = p.axes[0] || 0, dz = 0.07;
      const sx = Math.abs(ax) < dz ? 0 : Math.sign(ax) * Math.pow((Math.abs(ax) - dz) / (1 - dz), 1.5);
      const rt = p.buttons[7]?.value || 0, lt = p.buttons[6]?.value || 0;
      const used = Math.abs(sx) > 0 || rt > 0.02 || lt > 0.02 || p.buttons.some((b) => b?.pressed);
      if (used) o.device = 'gamepad';
      if (o.device === 'gamepad') { steer = -sx; throttle = Math.max(throttle, rt); brake = Math.max(brake, lt); }
      if (p.buttons[0]?.pressed) handbrake = 1;
      if (p.buttons[2]?.pressed) nitrous = true;
      if (p.buttons[1]?.pressed) horn = true;
      lookX = Math.abs(p.axes[2] || 0) > 0.15 ? p.axes[2] : 0;
      lookY = Math.abs(p.axes[3] || 0) > 0.15 ? p.axes[3] : 0;
      const edge = (i, act) => { const now = !!p.buttons[i]?.pressed; if (now && !this.padPrev[i]) this.onAction(act); this.padPrev[i] = now; };
      edge(5, 'shiftUp'); edge(4, 'shiftDown'); edge(3, 'camera'); edge(8, 'reset'); edge(9, 'menu'); edge(10, 'lookBack'); edge(12, 'lights'); edge(13, 'gearbox');
      if (p.buttons[11]?.pressed) lookBack = true;
      break;
    }
    o.throttle = throttle; o.brake = brake; o.steer = steer; o.handbrake = handbrake; o.nitrous = nitrous; o.horn = horn; o.lookBack = lookBack;
    o.lookX = lookX; o.lookY = lookY;
    o.mouseDX = this.mouse.dx; o.mouseDY = this.mouse.dy; o.dragging = this.mouse.dragging;
    this.mouse.dx = 0; this.mouse.dy = 0;
    o.wheel = this.wheelDelta || 0; this.wheelDelta = 0;
    return o;
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('pointerdown', this.onPDown);
    window.removeEventListener('pointermove', this.onPMove);
    window.removeEventListener('pointerup', this.onPUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }
}
