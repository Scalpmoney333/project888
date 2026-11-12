// Procedural WebAudio sound: engine (follows RPM and load), tire screech (follows slip),
// surface rumble, and one-shot handbrake / impact / suspension / shift / backfire sounds.

import { settings } from '../core/settings.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = false;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.noise = this.makeNoise(2);

    // ---- engine ----
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 2.5;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.distortionCurve(6);
    this.engineMix = ctx.createGain();
    this.engineMix.gain.value = 0.5;
    this.engineMix.connect(shaper).connect(this.engineFilter).connect(this.engineGain).connect(this.master);
    this.osc = [
      this.makeOsc('sawtooth', 0.55),
      this.makeOsc('square', 0.25),
      this.makeOsc('sawtooth', 0.18),
      this.makeOsc('triangle', 0.3),
    ];
    // intake/exhaust breath
    this.intake = ctx.createBufferSource();
    this.intake.buffer = this.noise;
    this.intake.loop = true;
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.Q.value = 1.2;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.intake.connect(this.intakeFilter).connect(this.intakeGain).connect(this.engineGain);
    this.intake.start();

    // ---- tire screech ----
    this.tireGain = ctx.createGain();
    this.tireGain.gain.value = 0;
    this.tireGain.connect(this.master);
    this.squeal = [this.makeTone(1020, 'triangle', 0.5), this.makeTone(1490, 'sine', 0.3), this.makeTone(760, 'triangle', 0.25)];
    const tn = ctx.createBufferSource();
    tn.buffer = this.noise;
    tn.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1300;
    bp.Q.value = 3;
    const tng = ctx.createGain();
    tng.gain.value = 0.9;
    tn.connect(bp).connect(tng).connect(this.tireGain);
    tn.start();
    this.squealLfo = ctx.createOscillator();
    this.squealLfo.frequency.value = 7;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 40;
    this.squealLfo.connect(lfoGain);
    for (const s of this.squeal) lfoGain.connect(s.osc.frequency);
    this.squealLfo.start();

    // ---- surface rumble ----
    const rn = ctx.createBufferSource();
    rn.buffer = this.noise;
    rn.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rn.connect(lp).connect(this.rumbleGain).connect(this.master);
    rn.start();

    // wind
    const wn = ctx.createBufferSource();
    wn.buffer = this.noise;
    wn.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 600;
    wf.Q.value = 0.5;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wn.connect(wf).connect(this.windGain).connect(this.master);
    wn.start();
    this.enabled = true;
  }

  makeNoise(seconds) {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  distortionCurve(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / n) * 2 - 1;
      c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return c;
  }

  makeOsc(type, gain) {
    const o = this.ctx.createOscillator();
    o.type = type;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(this.engineMix);
    o.start();
    return { osc: o, gain: g };
  }

  makeTone(freq, type, gain) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    o.connect(g).connect(this.tireGain);
    o.start();
    return { osc: o, gain: g, base: freq };
  }

  suspend() {
    this.ctx?.suspend();
  }

  resume() {
    this.ctx?.resume();
  }

  /**
   * @param {object} s {rpm, throttle, load, squeal 0..1, rumble 0..1, speed m/s, cylinders}
   */
  update(s) {
    if (!this.enabled) return;
    const a = settings.data.audio;
    const t = this.ctx.currentTime;
    const tc = 0.03;
    this.master.gain.setTargetAtTime(a.master, t, 0.1);
    const fire = (s.rpm / 60) * (s.cylinders / 2); // firing frequency
    const f = Math.max(20, fire);
    this.osc[0].osc.frequency.setTargetAtTime(f, t, tc);
    this.osc[1].osc.frequency.setTargetAtTime(f * 0.5, t, tc);
    this.osc[2].osc.frequency.setTargetAtTime(f * 1.5, t, tc);
    this.osc[3].osc.frequency.setTargetAtTime(f * 2, t, tc);
    const load = Math.min(1, Math.max(0, s.throttle));
    this.engineFilter.frequency.setTargetAtTime(250 + f * (2.2 + load * 4.5), t, tc);
    this.engineGain.gain.setTargetAtTime(a.engine * (0.16 + load * 0.2 + Math.min(0.12, s.rpm / 60000)), t, 0.05);
    this.intakeFilter.frequency.setTargetAtTime(f * 3, t, tc);
    this.intakeGain.gain.setTargetAtTime(0.05 + load * 0.25, t, 0.05);

    const sq = Math.min(1, s.squeal);
    this.tireGain.gain.setTargetAtTime(a.tires * sq * 0.22, t, 0.04);
    const pitch = 0.85 + Math.min(0.35, s.squeal * 0.2) + Math.min(0.2, s.speed / 200);
    for (const q of this.squeal) q.osc.detune.setTargetAtTime((pitch - 1) * 1200, t, 0.05);
    this.rumbleGain.gain.setTargetAtTime(a.effects * s.rumble * 0.5, t, 0.08);
    this.windGain.gain.setTargetAtTime(a.effects * Math.min(0.12, (s.speed / 60) ** 2 * 0.12), t, 0.2);
  }

  /** Short filtered noise burst. */
  burst({ freq = 800, type = 'bandpass', q = 1, dur = 0.08, gain = 0.5, delay = 0 }) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * settings.data.audio.effects, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }

  thump(freq, gain, dur) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.5, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * settings.data.audio.effects, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  handbrake(on) {
    if (on) {
      for (let i = 0; i < 4; i++) this.burst({ freq: 3500, type: 'highpass', dur: 0.025, gain: 0.25, delay: i * 0.035 });
      this.burst({ freq: 900, q: 2, dur: 0.12, gain: 0.25 });
    } else {
      this.burst({ freq: 2500, type: 'highpass', dur: 0.05, gain: 0.2 });
    }
  }

  impact(strength) {
    const s = Math.min(1, strength);
    this.burst({ freq: 500 + 600 * s, type: 'lowpass', dur: 0.15 + 0.25 * s, gain: 0.3 + 0.7 * s });
    this.burst({ freq: 2400, q: 1.5, dur: 0.1 + 0.2 * s, gain: 0.25 * s });
    this.thump(90, 0.6 * s, 0.25);
  }

  suspension(strength) {
    this.thump(70, Math.min(0.5, strength * 0.25), 0.18);
  }

  shift() {
    this.burst({ freq: 400, q: 3, dur: 0.06, gain: 0.25 });
  }

  backfire() {
    this.burst({ freq: 300, type: 'lowpass', dur: 0.12, gain: 0.9 });
    this.burst({ freq: 1200, q: 0.8, dur: 0.05, gain: 0.5 });
  }
}
