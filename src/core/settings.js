// Persistent settings (localStorage) with defaults and change notification.

const KEY = 'driftsim.settings.v1';

export const DEFAULT_HUD_LAYOUT = {
  // x/y are the control centre in % of the viewport, size in px at a 400 px-tall reference
  // screen (scaled to the real viewport so phones and tablets look alike).
  wheel: { x: 15, y: 70, size: 170 },
  left: { x: 9, y: 76, size: 92 },
  right: { x: 25, y: 76, size: 92 },
  throttle: { x: 91, y: 70, size: 110 },
  brake: { x: 78, y: 76, size: 92 },
  handbrake: { x: 66, y: 80, size: 74 },
  clutch: { x: 56, y: 82, size: 64 },
  gearUp: { x: 91, y: 24, size: 60 },
  gearDown: { x: 91, y: 40, size: 60 },
  camera: { x: 63, y: 8, size: 48 },
  reset: { x: 70, y: 8, size: 48 },
  pause: { x: 96, y: 8, size: 48 },
};

export const DEFAULTS = {
  car: 'skyline',
  map: 'nagao',
  spawn: {}, // per map id: spawn point id
  paint: {},
  tuning: {}, // per car id
  driving: {
    steeringType: 'wheel', // 'wheel' | 'arrows'
    transmission: 'auto', // 'auto' | 'manual'
    clutchPedal: false,
    pedals: 'proportional', // 'proportional' (depth by touch height) | 'regular' (on/off)
    steeringSensitivity: 1.0,
    steeringReturn: 1.0,
    wheelRange: 720, // degrees of virtual wheel rotation lock to lock (one turn each way)
  },
  assists: {
    steering: 0.5,
    countersteer: 0.45,
    driftStabilization: 0.45,
    tractionControl: 0,
    abs: 1,
    stability: 0,
  },
  camera: {
    mode: 0,
    distance: 1,
    height: 1,
    fov: 62,
    smoothing: 0.5,
    sensitivity: 0.5,
    rotation: 0.55,
    shake: 0.5,
    drift: 0.6,
  },
  hud: {
    opacity: 0.7,
    layout: structuredClone(DEFAULT_HUD_LAYOUT),
    showTelemetry: false,
    vibration: true, // haptic feedback on button presses and impacts
  },
  graphics: {
    preset: 'auto', // 'low' | 'medium' | 'high' | 'auto'
    shadows: true,
    smoke: 'medium', // off | low | medium | high
    skidmarks: true,
    reflections: true,
    exhaust: true,
    resolution: 1.0, // multiplier on the preset pixel ratio
    adaptive: true,
    showFps: true,
  },
  audio: { master: 0.8, engine: 1, tires: 1, effects: 1 },
};

export const GRAPHICS_PRESETS = {
  low: { pixelRatio: 0.65, shadows: false, shadowSize: 0, smoke: 'low', reflections: false, skidmarks: true, exhaust: false, maxDpr: 1.0 },
  medium: { pixelRatio: 0.85, shadows: true, shadowSize: 1024, smoke: 'medium', reflections: true, skidmarks: true, exhaust: true, maxDpr: 1.5 },
  high: { pixelRatio: 1.0, shadows: true, shadowSize: 2048, smoke: 'high', reflections: true, skidmarks: true, exhaust: true, maxDpr: 2.0 },
};

function merge(base, over) {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over === undefined ? base : over;
  const out = { ...base };
  if (over && typeof over === 'object') {
    for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

class SettingsStore {
  constructor() {
    this.listeners = new Set();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
    this.data = merge(structuredClone(DEFAULTS), saved);
    // Migrations from earlier versions.
    if (this.data.driving.wheelRange === 140) this.data.driving.wheelRange = 720;
    if (this.data.map === 'forest') this.data.map = 'nagao';
  }

  get(path) {
    return path.split('.').reduce((o, k) => (o ? o[k] : undefined), this.data);
  }

  set(path, value) {
    const keys = path.split('.');
    let o = this.data;
    for (const k of keys.slice(0, -1)) o = o[k] ??= {};
    o[keys.at(-1)] = value;
    this.save();
    for (const fn of this.listeners) fn(path, value);
  }

  reset(section) {
    this.data[section] = structuredClone(DEFAULTS[section]);
    this.save();
    for (const fn of this.listeners) fn(section, this.data[section]);
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* storage full or disabled */ }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const settings = new SettingsStore();

/** Resolve the effective graphics configuration ('auto' picks a preset by device). */
export function resolvePreset(preset) {
  if (preset !== 'auto') return preset;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;
  const mem = navigator.deviceMemory || 4;
  return mobile ? (mem >= 6 ? 'medium' : 'low') : 'high';
}

/** Copy a preset's defaults into the individual graphics toggles. */
export function applyPreset(preset) {
  const p = GRAPHICS_PRESETS[resolvePreset(preset)];
  const g = settings.data.graphics;
  Object.assign(g, { preset, shadows: p.shadows, smoke: p.smoke, reflections: p.reflections, skidmarks: p.skidmarks, exhaust: p.exhaust, resolution: 1 });
  settings.set('graphics', g);
}

export function resolveGraphics(g = settings.data.graphics) {
  const preset = resolvePreset(g.preset);
  const p = GRAPHICS_PRESETS[preset];
  return {
    preset,
    pixelRatio: p.pixelRatio * g.resolution,
    maxDpr: p.maxDpr,
    shadows: g.shadows,
    shadowSize: p.shadowSize || 1024,
    smoke: g.smoke,
    reflections: g.reflections,
    skidmarks: g.skidmarks,
    exhaust: g.exhaust,
    adaptive: g.adaptive,
  };
}

/** Haptic pulse, unless vibration is turned off in settings. */
export function vibrate(ms) {
  if (settings.data.hud.vibration && navigator.vibrate) navigator.vibrate(ms);
}
