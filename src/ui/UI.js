// DOM user interface: menus, settings, HUD readouts and the HUD layout editor.

import { settings, DEFAULTS, DEFAULT_HUD_LAYOUT, applyPreset } from '../core/settings.js';
import { VEHICLES, TUNING_PARAMS } from '../vehicle/specs.js';
import { MAPS } from '../core/Game.js';
import { CAMERA_MODES } from '../camera/CameraRig.js';

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};

const PAINTS = [null, '#c8102e', '#f4f4f2', '#111214', '#1d4ea8', '#9aa3ab', '#f2b705', '#2f7d4f'];

export class UI {
  constructor(root, game) {
    this.root = root;
    this.game = game;
    this.state = 'menu';
    this.tab = 'driving';
    this.build();
    game.on('pause', () => { if (this.state === 'driving') this.showPause(); });
    game.on('frame', (v) => this.updateHud(v));
    this.showMenu();
  }

  build() {
    // HUD
    this.hud = h('div', { class: 'hud hidden' },
      h('div', { class: 'gauge' }, (this.tacho = h('canvas', { width: 260, height: 150 }))),
      (this.scoreEl = h('div', { class: 'score' })),
      (this.fpsEl = h('div', { class: 'fps' })),
      (this.toast = h('div', { class: 'toast' })),
      (this.telemetry = h('pre', { class: 'telemetry' })),
    );
    this.root.append(this.hud);
    this.tctx = this.tacho.getContext('2d');

    this.loading = h('div', { class: 'overlay loading hidden' },
      h('div', { class: 'loading-box' }, (this.loadingText = h('div', {}, 'Loading…')), h('div', { class: 'bar' }, (this.loadingBar = h('div')))));
    this.menu = h('div', { class: 'overlay menu hidden' });
    this.pause = h('div', { class: 'overlay pause hidden' });
    this.settingsEl = h('div', { class: 'overlay settings hidden' });
    this.editor = h('div', { class: 'editor hidden' });
    this.root.append(this.loading, this.menu, this.pause, this.settingsEl, this.editor);
    this.game.input.on('camera', () => this.flash(CAMERA_MODES[this.game.cameraRig?.mode ?? 0]));
  }

  hideAll() {
    for (const el of [this.menu, this.pause, this.settingsEl, this.loading, this.editor]) el.classList.add('hidden');
  }

  flash(text) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), 1200);
  }

  // ---------------- main menu ----------------
  showMenu() {
    this.state = 'menu';
    this.game.setPaused(true);
    this.hideAll();
    this.hud.classList.add('hidden');
    this.game.input.root.classList.add('hidden');
    const d = settings.data;
    const carCards = VEHICLES.map((v) => h('button', {
      class: `card ${d.car === v.id ? 'selected' : ''}`,
      onclick: () => { settings.set('car', v.id); this.showMenu(); },
    }, h('b', {}, v.name), h('small', {}, v.subtitle)));
    const mapCards = MAPS.map((m) => h('button', {
      class: `card ${d.map === m.id ? 'selected' : ''}`,
      onclick: () => { settings.set('map', m.id); this.showMenu(); },
    }, h('b', {}, m.name), h('small', {}, m.subtitle)));
    const mapDef = MAPS.find((m) => m.id === d.map) || MAPS[0];
    const spawnId = d.spawn[mapDef.id] || mapDef.spawns[0].id;
    const spawnButtons = mapDef.spawns.map((s) => h('button', {
      class: `chip ${s.id === spawnId ? 'selected' : ''}`,
      onclick: () => { settings.set(`spawn.${mapDef.id}`, s.id); this.showMenu(); },
    }, s.name));
    const paint = PAINTS.map((c) => h('button', {
      class: `swatch ${(d.paint[d.car] || null) === c ? 'selected' : ''}`,
      style: c ? `background:${c}` : 'background:linear-gradient(135deg,#888 50%,#444 50%)',
      title: c ? c : 'Original',
      onclick: () => { settings.set(`paint.${d.car}`, c); this.showMenu(); },
    }));
    this.menu.replaceChildren(h('div', { class: 'panel menu-panel' },
      h('h1', {}, 'TOUGE ', h('span', {}, 'DRIFT')),
      h('div', { class: 'menu-cols' },
        h('section', {}, h('h3', {}, 'Car'), h('div', { class: 'cards' }, carCards), h('h3', {}, 'Paint'), h('div', { class: 'swatches' }, paint)),
        h('section', {}, h('h3', {}, 'Map'), h('div', { class: 'cards' }, mapCards),
          h('h3', {}, 'Start position'), h('div', { class: 'chips' }, spawnButtons)),
      ),
      h('div', { class: 'row buttons' },
        h('button', { class: 'primary', onclick: () => this.start() }, 'DRIVE'),
        h('button', { onclick: () => this.showSettings('menu') }, 'Settings'),
        h('button', { onclick: () => { this.tab = 'tuning'; this.showSettings('menu'); } }, 'Tune car'),
      ),
      h('p', { class: 'hint' }, 'Keyboard: W/S or ↑/↓ throttle/brake · A/D steer · Space handbrake · E/Q shift · X clutch · C camera · R reset · Esc pause'),
    ));
    this.menu.classList.remove('hidden');
  }

  async start() {
    this.hideAll();
    this.game.audio.init(); // user gesture: unlock audio
    this.loading.classList.remove('hidden');
    const d = settings.data;
    try {
      await this.game.loadSession(d.car, d.map, (p, text) => {
        this.loadingBar.style.width = `${Math.round(p * 100)}%`;
        this.loadingText.textContent = text;
      });
    } catch (err) {
      console.error(err);
      this.loadingText.textContent = `Failed to load: ${err.message}`;
      setTimeout(() => this.showMenu(), 2500);
      return;
    }
    this.loading.classList.add('hidden');
    this.resume();
    tryFullscreen();
  }

  resume() {
    this.hideAll();
    this.state = 'driving';
    this.hud.classList.remove('hidden');
    this.game.input.root.classList.remove('hidden');
    this.game.input.layout();
    this.game.setPaused(false);
  }

  // ---------------- pause ----------------
  showPause() {
    this.state = 'pause';
    this.game.setPaused(true);
    this.hideAll();
    this.game.input.root.classList.add('hidden');
    this.pause.replaceChildren(h('div', { class: 'panel small' },
      h('h2', {}, 'Paused'),
      h('button', { class: 'primary', onclick: () => this.resume() }, 'Resume'),
      h('button', { onclick: () => { this.game.resetCar(); this.resume(); } }, 'Reset car to start'),
      this.game.map && this.game.map.spawns.length > 1
        ? h('div', { class: 'chips' }, this.game.map.spawns.map((s) => h('button', {
          class: `chip ${s.id === this.game.currentSpawn().id ? 'selected' : ''}`,
          onclick: () => { this.game.setSpawn(s.id); this.resume(); },
        }, `Restart: ${s.name}`)))
        : null,
      h('button', { onclick: () => this.showSettings('pause') }, 'Settings'),
      h('button', { onclick: () => this.showMenu() }, 'Main menu'),
    ));
    this.pause.classList.remove('hidden');
  }

  // ---------------- settings ----------------
  showSettings(back) {
    this.back = back || this.back;
    this.hideAll();
    this.state = 'settings';
    const tabs = [['driving', 'Driving'], ['assists', 'Assists'], ['camera', 'Camera'], ['hud', 'HUD'], ['graphics', 'Graphics'], ['audio', 'Audio'], ['tuning', 'Tuning']];
    const body = h('div', { class: 'tab-body' }, this.tabContent(this.tab));
    this.settingsEl.replaceChildren(h('div', { class: 'panel settings-panel' },
      h('div', { class: 'tabs' }, tabs.map(([id, label]) => h('button', {
        class: this.tab === id ? 'selected' : '',
        onclick: () => { this.tab = id; this.showSettings(); },
      }, label)), h('button', { class: 'close', onclick: () => this.closeSettings() }, '✕')),
      body,
    ));
    this.settingsEl.classList.remove('hidden');
  }

  closeSettings() {
    if (this.back === 'pause') this.showPause();
    else this.showMenu();
  }

  slider(label, path, min, max, step, fmt = (v) => v) {
    const val = settings.get(path);
    const out = h('span', { class: 'val' }, fmt(val));
    const input = h('input', { type: 'range', min, max, step, value: val });
    input.addEventListener('input', () => { settings.set(path, +input.value); out.textContent = fmt(+input.value); });
    return h('label', { class: 'field' }, h('span', {}, label), input, out);
  }

  select(label, path, options, onchange) {
    const sel = h('select', {}, options.map(([v, l]) => h('option', { value: v, selected: String(settings.get(path)) === String(v) }, l)));
    sel.addEventListener('change', () => {
      const v = typeof settings.get(path) === 'number' ? +sel.value : sel.value;
      if (onchange) onchange(v);
      else settings.set(path, v);
      this.showSettings();
    });
    return h('label', { class: 'field' }, h('span', {}, label), sel);
  }

  toggle(label, path) {
    const cb = h('input', { type: 'checkbox', checked: !!settings.get(path) });
    cb.addEventListener('change', () => { settings.set(path, cb.checked); this.showSettings(); });
    return h('label', { class: 'field toggle' }, h('span', {}, label), cb);
  }

  tabContent(tab) {
    const pct = (v) => `${Math.round(v * 100)}%`;
    const x = (v) => `${(+v).toFixed(2)}×`;
    switch (tab) {
      case 'driving': return [
        this.select('Steering type', 'driving.steeringType', [['wheel', 'Steering wheel'], ['arrows', 'Arrows']]),
        this.select('Transmission', 'driving.transmission', [['auto', 'Automatic (AT)'], ['manual', 'Manual (MT)']]),
        settings.data.driving.transmission === 'manual' ? this.toggle('Clutch pedal (MT)', 'driving.clutchPedal') : null,
        this.select('Pedals', 'driving.pedals', [['proportional', 'Proportional (press higher = more)'], ['regular', 'Regular (on / off)']]),
        this.slider('Steering sensitivity', 'driving.steeringSensitivity', 0.4, 2, 0.05, x),
        this.slider('Steering return speed', 'driving.steeringReturn', 0.3, 2.5, 0.05, x),
        settings.data.driving.steeringType === 'wheel' ? this.slider('Wheel rotation lock to lock', 'driving.wheelRange', 180, 1080, 30, (v) => `${v}° (${(v / 720).toFixed(2)} turn each way)`) : null,
        this.select('Touch controls', 'hud.touch', [['auto', 'Auto'], ['on', 'Always show'], ['off', 'Hide']]),
        h('p', { class: 'hint' }, 'AT: hold brake at a standstill to engage reverse; the brake pedal then drives backwards. MT: use ▲/▼ (E/Q) — neutral sits between 1st and R.'),
      ];
      case 'assists': return [
        this.slider('Steering assist', 'assists.steering', 0, 1, 0.05, pct),
        this.slider('Countersteer assist', 'assists.countersteer', 0, 1, 0.05, pct),
        this.slider('Drift stabilization', 'assists.driftStabilization', 0, 1, 0.05, pct),
        this.slider('Traction control', 'assists.tractionControl', 0, 1, 0.05, pct),
        this.slider('ABS', 'assists.abs', 0, 1, 0.05, pct),
        this.slider('Stability control', 'assists.stability', 0, 1, 0.05, pct),
        h('button', { onclick: () => { settings.reset('assists'); this.showSettings(); } }, 'Reset assists'),
        h('p', { class: 'hint' }, 'All assists are optional; none of them starts a drift on its own. Set everything to 0% for raw physics.'),
      ];
      case 'camera': return [
        this.select('Camera mode', 'camera.mode', CAMERA_MODES.map((m, i) => [i, m]), (v) => this.game.cameraRig ? this.game.cameraRig.setMode(v) : settings.set('camera.mode', v)),
        this.slider('Distance', 'camera.distance', 0.6, 1.8, 0.05, x),
        this.slider('Height', 'camera.height', 0.5, 2, 0.05, x),
        this.slider('Field of view', 'camera.fov', 45, 90, 1, (v) => `${v}°`),
        this.slider('Smoothing', 'camera.smoothing', 0, 1, 0.05, pct),
        this.slider('Sensitivity', 'camera.sensitivity', 0, 1, 0.05, pct),
        this.slider('Rotation strength', 'camera.rotation', 0, 1, 0.05, pct),
        this.slider('Camera shake', 'camera.shake', 0, 1, 0.05, pct),
        this.slider('Drift camera effect', 'camera.drift', 0, 1, 0.05, pct),
        h('button', { onclick: () => { settings.reset('camera'); this.game.cameraRig?.setMode(0); this.showSettings(); } }, 'Reset camera settings'),
      ];
      case 'hud': return [
        this.slider('Button transparency', 'hud.opacity', 0.15, 1, 0.05, pct),
        h('button', { class: 'primary', onclick: () => this.openEditor() }, 'Edit button positions & sizes'),
        h('button', { onclick: () => { settings.set('hud.layout', structuredClone(DEFAULT_HUD_LAYOUT)); this.showSettings(); } }, 'Restore default HUD layout'),
        this.toggle('Vibration', 'hud.vibration'),
        this.toggle('Show telemetry', 'hud.showTelemetry'),
        this.toggle('Show FPS', 'graphics.showFps'),
      ];
      case 'graphics': return [
        this.select('Preset', 'graphics.preset', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], (v) => applyPreset(v)),
        this.toggle('Shadows', 'graphics.shadows'),
        this.select('Smoke quality', 'graphics.smoke', [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]),
        this.toggle('Reflections', 'graphics.reflections'),
        this.toggle('Skid marks', 'graphics.skidmarks'),
        this.toggle('Exhaust effects', 'graphics.exhaust'),
        this.slider('Rendering resolution', 'graphics.resolution', 0.5, 1.5, 0.05, pct),
        this.toggle('Adaptive resolution', 'graphics.adaptive'),
        h('p', { class: 'hint' }, 'Antialiasing and texture size follow the preset when a map loads.'),
      ];
      case 'audio': return [
        this.slider('Master volume', 'audio.master', 0, 1, 0.05, pct),
        this.slider('Engine', 'audio.engine', 0, 1.5, 0.05, pct),
        this.slider('Tires', 'audio.tires', 0, 1.5, 0.05, pct),
        this.slider('Effects', 'audio.effects', 0, 1.5, 0.05, pct),
      ];
      case 'tuning': {
        const car = VEHICLES.find((v) => v.id === settings.data.car);
        const tune = settings.data.tuning[car.id] || (settings.data.tuning[car.id] = {});
        const rows = TUNING_PARAMS.map((p) => {
          const val = tune[p.key] ?? (p.key === 'trackWidth' && this.game.model?.def.id === car.id ? +this.game.model.measured.trackWidth.toFixed(2) : car.defaults[p.key]);
          const out = h('span', { class: 'val' }, `${val} ${p.unit}`);
          const input = h('input', { type: 'range', min: p.min, max: p.max, step: p.step, value: val });
          input.addEventListener('input', () => { out.textContent = `${input.value} ${p.unit}`; settings.set(`tuning.${car.id}.${p.key}`, +input.value); });
          return h('label', { class: 'field' }, h('span', {}, p.label), input, out);
        });
        return [h('h3', {}, car.name), ...rows,
          h('button', { onclick: () => { settings.set(`tuning.${car.id}`, {}); this.showSettings(); } }, 'Reset tuning to stock')];
      }
    }
    return [];
  }

  // ---------------- HUD editor ----------------
  openEditor() {
    this.hideAll();
    this.state = 'editor';
    this.hud.classList.add('hidden');
    const input = this.game.input;
    input.root.classList.remove('hidden');
    let selected = null;
    const sizeIn = h('input', { type: 'range', min: 30, max: 260, step: 2, disabled: true });
    const label = h('span', {}, 'Tap a control to select it, drag to move');
    sizeIn.addEventListener('input', () => {
      if (!selected) return;
      settings.data.hud.layout[selected].size = +sizeIn.value;
      settings.set('hud.layout', settings.data.hud.layout);
    });
    input.setEditMode(true, (id) => {
      selected = id;
      label.textContent = `Selected: ${id}`;
      sizeIn.disabled = false;
      sizeIn.value = settings.data.hud.layout[id].size;
      for (const [k, el] of Object.entries(input.elements)) el.classList.toggle('selected', k === id);
    });
    // show every control while editing, including ones hidden by current options
    for (const el of Object.values(input.elements)) el.style.display = '';
    this.editor.replaceChildren(h('div', { class: 'editor-bar' }, label,
      h('label', {}, 'Size ', sizeIn),
      h('button', { onclick: () => { settings.set('hud.layout', structuredClone(DEFAULT_HUD_LAYOUT)); input.layout(); for (const el of Object.values(input.elements)) el.style.display = ''; } }, 'Reset'),
      h('button', { class: 'primary', onclick: () => {
        input.setEditMode(false);
        for (const el of Object.values(input.elements)) el.classList.remove('selected');
        settings.save();
        this.showSettings();
        if (this.back === 'pause' || this.back === 'menu') input.root.classList.add('hidden');
      } }, 'Save'),
    ));
    this.editor.classList.remove('hidden');
  }

  // ---------------- HUD ----------------
  updateHud(v) {
    if (this.state !== 'driving') return;
    this.hudFrame = (this.hudFrame || 0) + 1;
    if (this.hudFrame % 2) return; // 30 Hz is plenty for gauges
    const ctx = this.tctx;
    const W = 260, H = 150, cx = 130, cy = 112, R = 92;
    const spec = v.spec.engine;
    const maxRpm = Math.ceil(spec.limiterRpm / 1000) * 1000;
    ctx.clearRect(0, 0, W, H);
    const a0 = Math.PI * 0.85, a1 = Math.PI * 2.15;
    const ang = (r) => a0 + (a1 - a0) * Math.min(1, r / maxRpm);
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();
    ctx.strokeStyle = 'rgba(230,40,40,0.85)';
    ctx.beginPath(); ctx.arc(cx, cy, R, ang(spec.redlineRpm), a1); ctx.stroke();
    const rpm = v.rpm;
    ctx.strokeStyle = rpm > spec.redlineRpm ? '#ff4b3a' : '#ffd23f';
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(cx, cy, R, a0, ang(rpm)); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px system-ui';
    ctx.textAlign = 'center';
    for (let r = 0; r <= maxRpm; r += 1000) {
      const a = ang(r);
      ctx.fillText(String(r / 1000), cx + Math.cos(a) * (R - 22), cy + Math.sin(a) * (R - 22) + 4);
    }
    const gear = v.drivetrain.pendingGear !== null ? '-' : v.gear === -1 ? 'R' : v.gear === 0 ? 'N' : String(v.gear);
    ctx.font = 'bold 44px system-ui';
    ctx.fillStyle = v.gear === -1 ? '#ff6b5a' : '#fff';
    ctx.fillText(gear, cx, cy - 18);
    ctx.font = 'bold 26px system-ui';
    ctx.fillStyle = '#fff';
    ctx.fillText(`${Math.round(Math.abs(v.speed) * 3.6)}`, cx, cy + 14);
    ctx.font = '11px system-ui';
    ctx.fillStyle = '#bbb';
    ctx.fillText(`km/h · ${v.transmission === 'auto' ? 'AT' : 'MT'} · ${Math.round(rpm)} rpm`, cx, cy + 30);

    const sc = this.game.score;
    const cur = Math.round(sc.current);
    this.scoreEl.innerHTML = cur > 0
      ? `<b>${cur.toLocaleString()}</b><small>×${sc.combo.toFixed(1)} · ${Math.round(Math.abs(v.driftAngle) * 57.3)}°</small>`
      : (sc.total ? `<small>Total ${sc.total.toLocaleString()} · Best ${sc.best.toLocaleString()}</small>` : '');
    this.fpsEl.textContent = settings.data.graphics.showFps ? `${Math.round(this.game.fps)} FPS · ${Math.round(this.game.pixelRatio() * 100)}%` : '';
    if (settings.data.hud.showTelemetry) {
      const w = v.wheels;
      const f = (n, d = 0) => n.toFixed(d).padStart(6);
      this.telemetry.textContent =
        `β ${f(v.driftAngle * 57.3, 1)}°  yaw ${f(v.angularVelocity.y, 2)}  steer ${f(v.steerAngle * 57.3, 1)}°\n` +
        `thr ${f(v.controls.throttle, 2)} brk ${f(v.controls.brake, 2)} hb ${f(v.controls.handbrake, 2)} clutch ${v.drivetrain.locked ? 'lock' : f(v.drivetrain.engagement, 2)}\n` +
        w.map((x, i) => `${['FL', 'FR', 'RL', 'RR'][i]} load${f(x.load)} κ${f(x.slipRatio, 2)} α${f(x.slipAngle * 57.3, 1)} ${x.surface ? x.surface.name : 'air'}`).join('\n');
      this.telemetry.style.display = '';
    } else this.telemetry.style.display = 'none';
  }
}

function tryFullscreen() {
  const mobile = navigator.maxTouchPoints > 0;
  if (!mobile || document.fullscreenElement) return;
  const el = document.documentElement;
  el.requestFullscreen?.({ navigationUI: 'hide' }).then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
}

export { DEFAULTS };
