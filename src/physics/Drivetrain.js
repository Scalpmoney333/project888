// Engine + clutch + gearbox for a rear-wheel-drive car.
//
// The clutch is either "locked" (engine and rear axle share one rotating inertia, which is
// integrated implicitly by the wheel solver) or "slipping" (Coulomb clutch with bounded torque).
// Locking whenever the clutch can hold the engine torque avoids the stiff explicit coupling
// between the light engine flywheel and the wheels that would otherwise oscillate.

const RPM = 60 / (2 * Math.PI);

export class Drivetrain {
  constructor(spec) {
    this.setSpec(spec);
    this.reset();
  }

  setSpec(s) {
    this.spec = s;
    this.idleW = s.idleRpm / RPM;
    this.limiterW = s.limiterRpm / RPM;
    this.clutchCapacity = s.maxTorque * 1.7;
  }

  reset() {
    this.gear = 1; // -1 = R, 0 = N, 1..n
    this.engineW = this.idleW;
    this.locked = false;
    this.shiftTimer = 0;
    this.pendingGear = null;
    this.limiterCut = 0;
    this.engagement = 0;
    this.clutchTorque = 0;
    this.engineTorque = 0;
    this.throttleApplied = 0;
    this.lastShift = 0;
    this.reverseHold = 0;
    this.time = 0;
    this.shiftEvents = 0;
  }

  get rpm() {
    return this.engineW * RPM;
  }

  get gearCount() {
    return this.spec.gears.length;
  }

  /** Overall ratio engine:wheel for a gear (negative in reverse, 0 in neutral). */
  ratio(gear = this.gear) {
    if (gear === 0) return 0;
    if (gear < 0) return -this.spec.reverseRatio * this.spec.finalDrive;
    return this.spec.gears[gear - 1] * this.spec.finalDrive;
  }

  /** Full-throttle torque (Nm) at an engine speed, limited by peak power. */
  fullTorque(w) {
    const s = this.spec;
    const rpm = w * RPM;
    const x = (rpm - s.torquePeakRpm) / (rpm < s.torquePeakRpm ? s.torquePeakRpm - s.idleRpm * 0.5 : s.limiterRpm - s.torquePeakRpm + 1500);
    const shape = 1 - (rpm < s.torquePeakRpm ? 0.42 : 0.55) * x * x;
    const t = s.maxTorque * Math.max(0.3, shape);
    const powerLimited = (s.powerKW * 1000) / Math.max(w, 1);
    return Math.min(t, powerLimited);
  }

  /** Engine friction / pumping losses (Nm, positive number). Gives engine braking. */
  dragTorque(w) {
    const s = this.spec;
    return s.engineBrake * (0.35 + 0.65 * Math.min(1.4, (w * RPM) / s.limiterRpm));
  }

  canShift() {
    return this.shiftTimer <= 0;
  }

  requestGear(g, speed = 0) {
    if (g === this.gear && this.pendingGear === null) return false;
    if (g < -1 || g > this.gearCount) return false;
    // Reverse only near standstill (no gearbox carnage).
    if (g === -1 && speed > 2.0) return false;
    if (this.gear === -1 && g > 0 && speed < -2.0) return false;
    const up = g > this.gear;
    this.pendingGear = g;
    this.shiftTimer = up ? this.spec.shiftTimeUp : this.spec.shiftTimeDown;
    this.lastShift = this.time;
    this.shiftEvents++;
    return true;
  }

  shiftUp(speed) {
    const target = this.pendingGear ?? this.gear;
    return this.requestGear(Math.min(this.gearCount, target + 1), speed);
  }

  shiftDown(speed) {
    const target = this.pendingGear ?? this.gear;
    return this.requestGear(Math.max(-1, target - 1), speed);
  }

  /**
   * Automatic gearbox decisions; call every physics step.
   * @param {object} st  {throttle, brake, speed (m/s along heading), driftAngle (rad), rearSpin (rad/s excess)}
   */
  automatic(dt, st) {
    const s = this.spec;
    if (!this.canShift()) return;
    const sinceShift = this.time - this.lastShift;

    // Reverse handling: hold brake at standstill to engage reverse, throttle to leave it.
    if (this.gear >= 0) {
      if (Math.abs(st.speed) < 0.6 && st.brake > 0.5 && st.throttle < 0.05) {
        this.reverseHold += dt;
        if (this.reverseHold > 0.35) { this.requestGear(-1, st.speed); this.reverseHold = 0; }
        return;
      }
      this.reverseHold = 0;
    } else {
      if (st.throttle > 0.1 && st.speed > -0.8) { this.requestGear(1, st.speed); }
      return;
    }
    if (this.gear === 0) { this.requestGear(1, st.speed); return; }

    const rpm = this.rpm;
    // Road-speed rpm ignores wheelspin; actual rpm includes it. Upshifts need both, so a
    // spinning launch does not short-shift, and downshifts use the actual rpm so wheelspin
    // never triggers a downshift.
    const roadW = Math.abs(st.roadOmega);
    const drifting = Math.abs(st.driftAngle) > 0.2 && st.speed > 6;
    const upRpm = s.idleRpm + (s.redlineRpm * 0.96 - s.idleRpm) * Math.max(0.45, st.throttle);
    if (this.gear < this.gearCount && sinceShift > 0.6) {
      const nextRoadRpm = roadW * this.ratio(this.gear + 1) * RPM;
      const want = drifting
        ? rpm > s.limiterRpm - 120 && nextRoadRpm > s.torquePeakRpm * 0.75
        : rpm > upRpm && nextRoadRpm > s.idleRpm * 1.5;
      if (want) { this.requestGear(this.gear + 1, st.speed); return; }
    }
    if (this.gear > 1 && sinceShift > 0.6) {
      const braking = st.brake > 0.2;
      const downRoadRpm = roadW * this.ratio(this.gear - 1) * RPM;
      const effRpm = Math.min(rpm, Math.max(roadW * this.ratio() * RPM, braking ? 0 : rpm));
      const downRpm = braking ? s.redlineRpm * 0.52 : s.idleRpm + 700 + 1500 * st.throttle;
      const fits = downRoadRpm < s.redlineRpm * (braking ? 0.85 : 0.88);
      const want = drifting ? effRpm < s.idleRpm + 900 && fits : effRpm < downRpm && fits;
      if (want) this.requestGear(this.gear - 1, st.speed);
    }
  }

  /**
   * Before the wheel solve. Returns torque to send to the rear axle (Nm, sum of both wheels)
   * and the engine inertia reflected to each rear wheel when the clutch is locked.
   * @param {number} throttle 0..1
   * @param {number} clutchPedal 0..1 (1 = fully pressed); null for auto clutch
   * @param {number} axleW average rear wheel angular velocity
   */
  preStep(dt, throttle, clutchPedal, handbrake, axleW, out) {
    const s = this.spec;
    this.time += dt;
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0 && this.pendingGear !== null) {
        this.gear = this.pendingGear;
        this.pendingGear = null;
        if (s.autoBlip && this.gear !== 0) {
          // Automatic: rev-match both ways so the clutch re-engages without a torque spike.
          const target = Math.max(this.idleW, Math.abs(axleW * this.ratio()));
          this.engineW += (Math.min(this.limiterW, target) - this.engineW) * 0.9;
        }
      }
    }

    // Rev limiter: hard fuel cut with short recovery.
    if (this.engineW > this.limiterW) this.limiterCut = 0.06;
    if (this.limiterCut > 0) { this.limiterCut -= dt; throttle = 0; }
    // Idle governor keeps the engine alive.
    const idleNeed = Math.min(1, Math.max(0, (this.idleW * 1.05 - this.engineW) / (this.idleW * 0.3)));
    throttle = Math.max(throttle, idleNeed * 0.35);
    if (this.shiftTimer > 0 && s.autoBlip) throttle *= 0.15;
    this.throttleApplied = throttle;

    const ratio = this.ratio();
    const shaftW = axleW * ratio;

    // Clutch engagement: anti-stall / launch control plus the driver's pedal.
    const rpmE = this.engineW * RPM;
    const launch = Math.min(1, Math.max(0, (rpmE - s.idleRpm * 1.1) / (s.launchRpm - s.idleRpm * 1.1)));
    const rolling = Math.min(1, Math.max(0, (Math.abs(shaftW) * RPM - s.idleRpm * 0.95) / 400));
    let e = Math.max(launch, rolling);
    if (clutchPedal !== null && clutchPedal !== undefined) e = Math.min(e, 1 - clutchPedal);
    else if (handbrake > 0.3) e *= 0.0; // auto clutch-in while the handbrake is pulled
    if (this.shiftTimer > 0 || ratio === 0) e = 0;
    this.engagement = e;

    const tEng = throttle * this.fullTorque(this.engineW) - (1 - throttle) * this.dragTorque(this.engineW);
    this.engineTorque = tEng;
    const cap = this.clutchCapacity * e;

    const diff = this.engineW - shaftW;
    const canHold = Math.abs(tEng) <= cap;
    if (this.locked) {
      if (!canHold || e < 0.98 || shaftW < this.idleW * 0.9) this.locked = false;
    } else if (e >= 0.98 && canHold && Math.abs(diff) < 12 && shaftW >= this.idleW * 0.95) {
      this.locked = true;
    }

    if (this.locked) {
      out.torque = tEng * ratio * s.efficiency;
      out.inertia = (s.engineInertia * ratio * ratio) / 2;
      this.clutchTorque = tEng;
    } else {
      // Slipping clutch: torque needed to bring the engine to shaft speed this step, clamped.
      const need = tEng + (s.engineInertia * diff) / dt;
      const tc = Math.max(-cap, Math.min(cap, need));
      this.engineW += ((tEng - tc) / s.engineInertia) * dt;
      if (this.engineW < this.idleW * 0.7) this.engineW = this.idleW * 0.7;
      this.clutchTorque = tc;
      out.torque = tc * ratio * s.efficiency;
      out.inertia = 0;
    }
    out.locked = this.locked;
    return out;
  }

  /** After the wheel solve: a locked engine follows the axle. */
  postStep(axleW) {
    if (this.locked) {
      this.engineW = Math.max(this.idleW * 0.7, axleW * this.ratio());
    }
  }
}
