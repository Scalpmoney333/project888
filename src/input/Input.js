// Touch HUD, keyboard and gamepad input. Every control tracks its own pointerId with pointer
// capture, so steering, throttle and handbrake work simultaneously on multitouch screens.

import { settings } from '../core/settings.js';

const WHEEL_SVG = `
<svg viewBox="-100 -100 200 200" xmlns="http://www.w3.org/2000/svg">
  <circle r="88" fill="none" stroke="#1b1d21" stroke-width="22"/>
  <circle r="88" fill="none" stroke="#3a3e45" stroke-width="16"/>
  <circle r="88" fill="none" stroke="#5a606a" stroke-width="2" stroke-dasharray="3 9"/>
  <path d="M-80 8 L-26 14 L-18 40 L18 40 L26 14 L80 8 L80 -6 L26 -2 L0 -14 L-26 -2 L-80 -6 Z" fill="#2b2f35" stroke="#15171a" stroke-width="3"/>
  <circle r="24" fill="#1b1d21" stroke="#4a4f57" stroke-width="3"/>
  <rect x="-5" y="-98" width="10" height="20" rx="3" fill="#e8442f"/>
</svg>`;

const PEDAL_SVG = (label) => `<div class="pedal-face"><span>${label}</span></div>`;

const LABELS = {
  left: '◀', right: '▶', throttle: 'GAS', brake: 'BRAKE', handbrake: 'E-BRAKE', clutch: 'CLUTCH',
  gearUp: '▲', gearDown: '▼', camera: 'CAM', reset: '⟲', pause: 'Ⅱ',
};

export class Input {
  constructor(container) {
    this.container = container;
    this.state = { steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0 };
    this.raw = { wheelAngle: 0, wheelHeld: false, left: false, right: false, throttle: 0, brake: 0, handbrake: false, clutch: false };
    this.keys = new Set();
    this.handlers = { gearUp: [], gearDown: [], camera: [], reset: [], pause: [] };
    this.editMode = false;
    this.onSelect = null;
    this.elements = {};
    this.buildTouch();
    this.bindKeyboard();
    this.prevPad = {};
    settings.onChange((path) => { if (path.startsWith('hud') || path.startsWith('driving')) this.layout(); });
    addEventListener('resize', () => this.layout());
    this.layout();
  }

  on(evt, fn) {
    this.handlers[evt].push(fn);
  }

  emit(evt) {
    if (this.editMode) return;
    for (const fn of this.handlers[evt]) fn();
  }

  // ---------------- touch HUD ----------------
  buildTouch() {
    const root = document.createElement('div');
    root.className = 'touch-controls';
    this.container.appendChild(root);
    this.root = root;
    for (const id of Object.keys(settings.data.hud.layout)) {
      const el = document.createElement('div');
      el.className = `ctl ctl-${id}`;
      el.dataset.id = id;
      if (id === 'wheel') {
        el.innerHTML = `<div class="wheel-rot">${WHEEL_SVG}</div>`;
      } else if (['throttle', 'brake', 'handbrake', 'clutch'].includes(id)) {
        el.innerHTML = PEDAL_SVG(LABELS[id]) + '<div class="pedal-fill"></div>';
      } else {
        el.innerHTML = `<span>${LABELS[id]}</span>`;
      }
      root.appendChild(el);
      this.elements[id] = el;
      this.bindControl(el, id);
    }
  }

  bindControl(el, id) {
    let pointerId = null;
    let lastAngle = 0;
    let drag = null;
    const center = () => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2, r];
    };
    const depth = (e) => {
      // Progressive pedal: pressing higher on the pedal = deeper.
      const [, , r] = center();
      const f = 1 - (e.clientY - r.top) / r.height;
      return Math.min(1, Math.max(0.35, 0.35 + f * 0.9));
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (pointerId !== null) return;
      pointerId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      if (this.editMode) {
        drag = { x: e.clientX, y: e.clientY, start: { ...settings.data.hud.layout[id] } };
        this.onSelect?.(id);
        return;
      }
      if (navigator.vibrate && id !== 'wheel') navigator.vibrate(8);
      switch (id) {
        case 'wheel': {
          const [cx, cy] = center();
          lastAngle = Math.atan2(e.clientY - cy, e.clientX - cx);
          this.raw.wheelHeld = true;
          break;
        }
        case 'left': this.raw.left = true; break;
        case 'right': this.raw.right = true; break;
        case 'throttle': this.raw.throttle = depth(e); break;
        case 'brake': this.raw.brake = depth(e); break;
        case 'handbrake': this.raw.handbrake = true; break;
        case 'clutch': this.raw.clutch = true; break;
        default: this.emit(id);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;
      e.preventDefault();
      if (this.editMode && drag) {
        const L = settings.data.hud.layout[id];
        L.x = Math.min(98, Math.max(2, drag.start.x + ((e.clientX - drag.x) / innerWidth) * 100));
        L.y = Math.min(98, Math.max(2, drag.start.y + ((e.clientY - drag.y) / innerHeight) * 100));
        this.place(id);
        return;
      }
      if (id === 'wheel') {
        const [cx, cy] = center();
        const a = Math.atan2(e.clientY - cy, e.clientX - cx);
        let d = a - lastAngle;
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        lastAngle = a;
        const range = (settings.data.driving.wheelRange * Math.PI) / 180;
        // Clockwise finger motion (screen coords) = steer right.
        this.raw.wheelAngle = Math.min(range / 2, Math.max(-range / 2, this.raw.wheelAngle + d));
      } else if (id === 'throttle') this.raw.throttle = depth(e);
      else if (id === 'brake') this.raw.brake = depth(e);
    });
    const end = (e) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      el.classList.remove('active');
      if (this.editMode) {
        if (drag) settings.set('hud.layout', settings.data.hud.layout);
        drag = null;
        return;
      }
      switch (id) {
        case 'wheel': this.raw.wheelHeld = false; break;
        case 'left': this.raw.left = false; break;
        case 'right': this.raw.right = false; break;
        case 'throttle': this.raw.throttle = 0; break;
        case 'brake': this.raw.brake = 0; break;
        case 'handbrake': this.raw.handbrake = false; break;
        case 'clutch': this.raw.clutch = false; break;
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  touchVisible() {
    const mode = settings.data.hud.touch || 'auto';
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
  }

  place(id) {
    const el = this.elements[id];
    const L = settings.data.hud.layout[id];
    const scale = Math.min(innerWidth, innerHeight) / 400;
    const size = L.size * scale;
    el.style.width = `${size}px`;
    el.style.height = `${['throttle', 'brake', 'handbrake', 'clutch'].includes(id) ? size * 1.35 : size}px`;
    el.style.left = `${L.x}%`;
    el.style.top = `${L.y}%`;
    el.style.fontSize = `${Math.max(11, size * 0.18)}px`;
  }

  layout() {
    const d = settings.data;
    this.root.style.display = this.touchVisible() || this.editMode ? '' : 'none';
    this.root.style.setProperty('--hud-opacity', d.hud.opacity);
    this.root.classList.toggle('editing', this.editMode);
    const manual = d.driving.transmission === 'manual';
    const visible = {
      wheel: d.driving.steeringType === 'wheel',
      left: d.driving.steeringType === 'arrows',
      right: d.driving.steeringType === 'arrows',
      gearUp: manual,
      gearDown: manual,
      clutch: manual && d.driving.clutchPedal,
    };
    for (const id of Object.keys(this.elements)) {
      if (!settings.data.hud.layout[id]) settings.data.hud.layout[id] = { x: 50, y: 50, size: 60 };
      this.place(id);
      this.elements[id].style.display = visible[id] === false ? 'none' : '';
    }
  }

  setEditMode(on, onSelect) {
    this.editMode = on;
    this.onSelect = onSelect;
    this.layout();
  }

  /** Bring pedals/steering back to rest (e.g. when pausing). */
  release() {
    Object.assign(this.raw, { wheelAngle: 0, wheelHeld: false, left: false, right: false, throttle: 0, brake: 0, handbrake: false, clutch: false });
    Object.assign(this.state, { steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0 });
    this.keys.clear();
  }

  // ---------------- keyboard ----------------
  bindKeyboard() {
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.repeat) return;
      this.keys.add(e.code);
      const map = { KeyE: 'gearUp', ShiftRight: 'gearUp', ShiftLeft: 'gearUp', KeyQ: 'gearDown', ControlLeft: 'gearDown', ControlRight: 'gearDown', KeyC: 'camera', KeyR: 'reset', Escape: 'pause', KeyP: 'pause' };
      if (map[e.code]) this.emit(map[e.code]);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  // ---------------- per-frame update ----------------
  update(dt) {
    const d = settings.data.driving;
    const k = this.keys;
    const kLeft = k.has('ArrowLeft') || k.has('KeyA');
    const kRight = k.has('ArrowRight') || k.has('KeyD');
    const kUp = k.has('ArrowUp') || k.has('KeyW');
    const kDown = k.has('ArrowDown') || k.has('KeyS');
    const pad = this.readGamepad();
    const sens = d.steeringSensitivity;
    const ret = d.steeringReturn;
    const s = this.state;

    // Steering
    let target = null;
    if (pad && Math.abs(pad.steer) > 0.08) target = Math.sign(pad.steer) * ((Math.abs(pad.steer) - 0.08) / 0.92) ** 1.4;
    if (target === null && d.steeringType === 'wheel' && (this.raw.wheelHeld || Math.abs(this.raw.wheelAngle) > 1e-3)) {
      if (!this.raw.wheelHeld) {
        // Natural centre return of the virtual wheel.
        const r = (Math.PI * 3 * ret) * dt;
        this.raw.wheelAngle = Math.abs(this.raw.wheelAngle) <= r ? 0 : this.raw.wheelAngle - Math.sign(this.raw.wheelAngle) * r;
      }
      const range = (d.wheelRange * Math.PI) / 180;
      const x = (this.raw.wheelAngle / (range / 2)) * sens;
      s.steer = Math.max(-1, Math.min(1, x));
    } else {
      const left = kLeft || this.raw.left, right = kRight || this.raw.right;
      if (target === null) target = left === right ? 0 : left ? -1 : 1;
      const rate = (target === 0 ? 4.5 * ret : 3.2 * sens) * dt;
      // Faster when reversing direction for crisp countersteer.
      const r2 = Math.sign(target) !== Math.sign(s.steer) && target !== 0 ? rate * 1.8 : rate;
      s.steer += Math.max(-r2, Math.min(r2, target - s.steer));
    }
    const wr = this.elements.wheel.firstChild;
    if (wr) wr.style.transform = `rotate(${this.raw.wheelAngle}rad)`;

    // Pedals: ramp toward the requested depth (progressive), release smoothly.
    const ramp = (cur, want, up, down) => cur + Math.max(-down * dt, Math.min(up * dt, want - cur));
    const thrWant = Math.max(this.raw.throttle, kUp ? 1 : 0, pad ? pad.throttle : 0);
    const brkWant = Math.max(this.raw.brake, kDown ? 1 : 0, pad ? pad.brake : 0);
    s.throttle = ramp(s.throttle, thrWant, 5, 9);
    s.brake = ramp(s.brake, brkWant, 6, 7);
    const hb = this.raw.handbrake || k.has('Space') || (pad && pad.handbrake);
    s.handbrake = ramp(s.handbrake, hb ? 1 : 0, 25, 8);
    const cl = this.raw.clutch || k.has('KeyX') || (pad && pad.clutch);
    s.clutch = ramp(s.clutch, cl ? 1 : 0, 14, 5);

    // pedal fill feedback
    for (const id of ['throttle', 'brake', 'handbrake', 'clutch']) {
      const fill = this.elements[id].querySelector('.pedal-fill');
      if (fill) fill.style.transform = `scaleY(${s[id]})`;
    }
    return s;
  }

  readGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = pads && [...pads].find((g) => g && g.connected);
    if (!p) return null;
    const b = (i) => (p.buttons[i] ? p.buttons[i].value : 0);
    const pressed = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
    const edge = (i, evt) => {
      const now = pressed(i);
      if (now && !this.prevPad[i]) this.emit(evt);
      this.prevPad[i] = now;
    };
    edge(5, 'gearUp');
    edge(4, 'gearDown');
    edge(3, 'camera');
    edge(8, 'reset');
    edge(9, 'pause');
    return { steer: p.axes[0] || 0, throttle: b(7), brake: b(6), handbrake: pressed(0) || pressed(1), clutch: pressed(2) };
  }
}
