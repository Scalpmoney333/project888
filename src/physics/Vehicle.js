// Rigid-body RWD vehicle simulation.
//
// Body frame: origin at the centre of gravity, +Z forward, +Y up, +X to the driver's left.
// Each wheel is a raycast suspension (spring, bump/rebound damping, bump stop, anti-roll bar)
// with its own spin state and its own combined-slip tire. Engine torque reaches the rear
// wheels only, through the clutch/gearbox and a limited-slip differential. Weight transfer
// is not scripted: it emerges from the chassis pitching/rolling on its springs, which changes
// each tire's load and therefore its grip.

import * as THREE from 'three';
import { TireModel } from './Tire.js';
import { Drivetrain } from './Drivetrain.js';

export const PHYSICS_DT = 1 / 240;
const MAX_STEPS = 24;
const G = 9.81;
const V_LOW = 2.5; // m/s, slip denominator floor (keeps slip finite near standstill)

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _tireOut = { fx: 0, fy: 0, rho: 0, usage: 0 };
const _dtOut = { torque: 0, inertia: 0, locked: false };
const _hit = { distance: 0, normal: new THREE.Vector3(), surface: null };
const _contact = { point: new THREE.Vector3(), normal: new THREE.Vector3(), depth: 0 };

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hashNoise(x) {
  // Cheap smooth 1D value noise in [-1, 1] for road texture vibration.
  const i = Math.floor(x);
  const f = x - i;
  const h = (n) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

class Wheel {
  constructor(index, front, left) {
    this.index = index;
    this.front = front;
    this.left = left;
    this.pos = new THREE.Vector3(); // static wheel centre in body frame
    this.mountTop = new THREE.Vector3();
    this.travel = 0.2;
    this.radius = 0.32;
    this.inertia = 1.2;
    this.omega = 0;
    this.spinAngle = 0;
    this.steer = 0; // rad, + = left
    this.length = 0; // current suspension length from mount top
    this.compression = 0;
    this.prevCompression = 0;
    this.contact = false;
    this.normal = new THREE.Vector3(0, 1, 0);
    this.point = new THREE.Vector3();
    this.centerWorld = new THREE.Vector3();
    this.load = 0;
    this.springForce = 0;
    this.slipRatio = 0;
    this.slipAngle = 0;
    this.slipSpeed = 0; // m/s of sliding at the contact patch
    this.fx = 0;
    this.fy = 0;
    this.usage = 0;
    this.surface = null;
    this.driveTorque = 0;
    this.brakeTorque = 0;
    this.travelDist = 0;
    this.tire = null;
  }
}

export class Vehicle {
  constructor(spec, world) {
    this.world = world;
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    this.prevPosition = new THREE.Vector3();
    this.prevQuaternion = new THREE.Quaternion();
    this.renderPosition = new THREE.Vector3();
    this.renderQuaternion = new THREE.Quaternion();
    this.inertia = new THREE.Vector3();
    this.invInertia = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.left = new THREE.Vector3();
    this.force = new THREE.Vector3();
    this.torque = new THREE.Vector3();
    this.wheels = [new Wheel(0, true, true), new Wheel(1, true, false), new Wheel(2, false, true), new Wheel(3, false, false)];
    this.bodySpheres = [];
    this.accumulator = 0;
    this.time = 0;
    this.assists = { steering: 0.5, countersteer: 0.5, driftStabilization: 0.4, tractionControl: 0, abs: 1, stability: 0 };
    this.controls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: null };
    this.transmission = 'auto';
    this.steerAngle = 0;
    this.driftAngle = 0;
    this.speed = 0;
    this.impact = 0; // collision impulse accumulated since last read (N s)
    this.suspensionHit = 0;
    this.airTime = 0;
    this.drivetrain = null;
    this.applySpec(spec);
  }

  applySpec(spec) {
    this.spec = spec;
    const s = spec;
    this.mass = s.mass;
    // Box inertia from body dimensions, scaled for mass concentrated near the centre.
    const L = s.body.length, W = s.body.width, H = s.body.height;
    const k = s.inertiaScale ?? 1;
    this.inertia.set(((W * W + H * H) * this.mass) / 12, ((W * W + L * L) * this.mass) / 12, ((L * L + H * H) * this.mass) / 12).multiplyScalar(k);
    // Roll/pitch inertia stays a bit higher for a planted feel.
    this.inertia.x *= 1.15;
    this.inertia.z *= 1.15;
    this.invInertia.set(1 / this.inertia.x, 1 / this.inertia.y, 1 / this.inertia.z);

    const a = s.wheelbase * (1 - s.frontWeight); // CG -> front axle
    const b = s.wheelbase * s.frontWeight; // CG -> rear axle
    const tireFront = new TireModel({ ...s.tires.front, nominalLoad: (this.mass * G * s.frontWeight) / 2 });
    const tireRear = new TireModel({ ...s.tires.rear, nominalLoad: (this.mass * G * (1 - s.frontWeight)) / 2 });
    for (const w of this.wheels) {
      const track = w.front ? s.trackFront : s.trackRear;
      w.radius = w.front ? s.wheelRadiusFront : s.wheelRadiusRear;
      w.inertia = s.wheelInertia;
      w.pos.set((w.left ? 1 : -1) * track * 0.5, w.radius - s.cgHeight, w.front ? a : -b);
      w.travel = s.suspension.travel;
      w.stiffness = w.front ? s.suspension.stiffnessFront : s.suspension.stiffnessRear;
      const corner = (this.mass * (w.front ? s.frontWeight : 1 - s.frontWeight)) / 2;
      w.cornerMass = corner;
      w.damping = s.suspension.damping * 2 * Math.sqrt(w.stiffness * corner);
      w.staticCompression = Math.min(w.travel * 0.7, (corner * G) / w.stiffness);
      w.mountTop.copy(w.pos);
      w.mountTop.y += w.travel - w.staticCompression;
      w.tire = w.front ? tireFront : tireRear;
    }
    this.cgToFront = a;
    this.cgToRear = b;

    // Body collision spheres (body frame), sized from the body dimensions.
    const r = Math.min(W * 0.3, H * 0.42);
    const yLow = s.groundClearance + r - s.cgHeight;
    const zs = [L * 0.5 - r * 0.95, L * 0.18, -L * 0.18, -(L * 0.5 - r * 0.95)];
    this.bodySpheres = [];
    for (const z of zs) for (const sx of [1, -1]) this.bodySpheres.push({ local: new THREE.Vector3(sx * (W * 0.5 - r * 0.95), yLow, z), radius: r });
    this.bodySpheres.push({ local: new THREE.Vector3(0, H - s.cgHeight - r * 0.9, -L * 0.05), radius: r });

    if (!this.drivetrain) this.drivetrain = new Drivetrain(s.engine);
    else this.drivetrain.setSpec(s.engine);
  }

  /** Place the car at rest with wheels on the ground below `pos`. */
  reset(pos, yaw) {
    this.quaternion.setFromAxisAngle(_v1.set(0, 1, 0), yaw);
    // Find ground under the requested point.
    let groundY = pos.y;
    _v2.set(pos.x, pos.y + 30, pos.z);
    if (this.world.raycast(_v2, _v3.set(0, -1, 0), 200, _hit)) groundY = _v2.y - _hit.distance;
    this.position.set(pos.x, groundY + this.spec.cgHeight + 0.03, pos.z);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
    this.renderPosition.copy(this.position);
    this.renderQuaternion.copy(this.quaternion);
    for (const w of this.wheels) {
      w.omega = 0;
      w.compression = w.prevCompression = w.staticCompression;
      w.length = w.travel - w.staticCompression;
      w.contact = false;
      w.slipSpeed = 0;
    }
    this.drivetrain.reset();
    this.steerAngle = 0;
    this.accumulator = 0;
    this.airTime = 0;
  }

  /** Advance by a frame delta using fixed sub-steps; result is frame-rate independent. */
  update(frameDt) {
    this.accumulator += Math.min(frameDt, 0.1);
    let steps = 0;
    while (this.accumulator >= PHYSICS_DT && steps < MAX_STEPS) {
      this.prevPosition.copy(this.position);
      this.prevQuaternion.copy(this.quaternion);
      this.step(PHYSICS_DT);
      this.accumulator -= PHYSICS_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this.accumulator = 0;
    const alpha = this.accumulator / PHYSICS_DT;
    this.renderPosition.lerpVectors(this.prevPosition, this.position, alpha);
    this.renderQuaternion.slerpQuaternions(this.prevQuaternion, this.quaternion, alpha);
    return steps;
  }

  localToWorld(local, out) {
    return out.copy(local).applyQuaternion(this.quaternion).add(this.position);
  }

  pointVelocity(worldPoint, out) {
    _v4.subVectors(worldPoint, this.position);
    return out.crossVectors(this.angularVelocity, _v4).add(this.velocity);
  }

  addForceAtPoint(f, p) {
    this.force.add(f);
    _v4.subVectors(p, this.position).cross(f);
    this.torque.add(_v4);
  }

  /** Apply world-space inverse inertia to a world vector in place. */
  applyInvInertia(vec) {
    _qInv.copy(this.quaternion).invert();
    vec.applyQuaternion(_qInv);
    vec.x *= this.invInertia.x;
    vec.y *= this.invInertia.y;
    vec.z *= this.invInertia.z;
    return vec.applyQuaternion(this.quaternion);
  }

  step(dt) {
    const s = this.spec;
    const c = this.controls;
    const dtn = this.drivetrain;
    this.time += dt;
    this.force.set(0, -this.mass * G, 0);
    this.torque.set(0, 0, 0);
    this.forward.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.left.set(1, 0, 0).applyQuaternion(this.quaternion);

    const vF = this.velocity.dot(this.forward);
    const vL = this.velocity.dot(this.left);
    this.speed = vF;
    const planar = Math.hypot(vF, vL);
    // Drift angle: + when the velocity points to the left of the heading.
    this.driftAngle = planar > 2 ? Math.atan2(vL, Math.abs(vF)) : 0;
    const yawRate = this.angularVelocity.dot(this.up);
    const as = this.assists;
    const driftness = smoothstep(0.07, 0.26, Math.abs(this.driftAngle)) * smoothstep(3, 8, vF);

    // ---------- pedals (reverse in automatic swaps pedal roles) ----------
    let throttle = c.throttle;
    let brake = c.brake;
    if (this.transmission === 'auto') {
      dtn.automatic(dt, { throttle: c.throttle, brake: c.brake, speed: vF, driftAngle: this.driftAngle, roadOmega: vF / s.wheelRadiusRear });
      if (dtn.gear === -1 || dtn.pendingGear === -1) {
        throttle = c.brake;
        brake = c.throttle;
      }
    }

    // ---------- steering ----------
    const maxSteer = s.steering.maxAngle;
    const speedReduce = 1 - as.steering * 0.62 * smoothstep(6, 42, Math.abs(vF)) * (1 - driftness);
    let target = -c.steer * maxSteer * speedReduce;
    if (vF > 3 && as.countersteer > 0) {
      // Front-axle velocity direction relative to heading; steering toward it is countersteer.
      const vFrontLat = vL + yawRate * this.cgToFront;
      const theta = Math.atan2(vFrontLat, vF);
      target += as.countersteer * driftness * theta * 0.9;
    }
    target = Math.max(-maxSteer, Math.min(maxSteer, target));
    const steerRate = s.steering.rate;
    this.steerAngle += Math.max(-steerRate * dt, Math.min(steerRate * dt, target - this.steerAngle));
    const d = this.steerAngle;
    if (Math.abs(d) > 1e-4) {
      // Ackermann: inner wheel turns more.
      const R = s.wheelbase / Math.tan(Math.abs(d));
      const half = s.trackFront * 0.5;
      const inner = Math.atan(s.wheelbase / (R - half));
      const outer = Math.atan(s.wheelbase / (R + half));
      const ack = s.steering.ackermann;
      const sign = Math.sign(d);
      const leftIsInner = d > 0;
      const wi = Math.abs(d) * (1 - ack) + inner * ack;
      const wo = Math.abs(d) * (1 - ack) + outer * ack;
      this.wheels[0].steer = sign * (leftIsInner ? wi : wo);
      this.wheels[1].steer = sign * (leftIsInner ? wo : wi);
    } else {
      this.wheels[0].steer = this.wheels[1].steer = 0;
    }
    this.wheels[2].steer = this.wheels[3].steer = 0;

    // ---------- assists on pedals ----------
    const rearSlip = Math.max(this.wheels[2].slipRatio, this.wheels[3].slipRatio);
    const kp = s.tires.rear.peakSlipRatio;
    if (as.tractionControl > 0) throttle *= 1 - as.tractionControl * 0.9 * smoothstep(kp * 1.3, kp * 4, rearSlip);
    // Drift throttle limiter (part of drift stabilisation): a held throttle button would spin
    // the rears to the limiter; cap rear wheelspin while sliding so the slide stays steerable.
    if (as.driftStabilization > 0 && driftness > 0) {
      const target = 0.35 + (1 - as.driftStabilization) * 2.5;
      throttle *= 1 - driftness * smoothstep(target, target * 2.2, rearSlip) * 0.85;
    }
    let escBrake = 0;
    if (as.stability > 0 && vF > 4) {
      const over = smoothstep(0.09, 0.4, Math.abs(this.driftAngle));
      throttle *= 1 - as.stability * 0.8 * over;
      escBrake = as.stability * over;
    }

    // ---------- suspension ----------
    let grounded = 0;
    for (const w of this.wheels) {
      const origin = this.localToWorld(w.mountTop, _v1);
      const dir = _v2.copy(this.up).negate();
      const maxDist = w.travel + w.radius;
      w.prevCompression = w.compression;
      if (this.world.raycast(origin, dir, maxDist + 0.05, _hit) && _hit.distance <= maxDist) {
        const surf = _hit.surface;
        w.surface = surf;
        // Small road texture vibration (amplitude depends on surface).
        const bump = surf.bump * hashNoise(w.travelDist * 3.1 + w.index * 17.0);
        let len = _hit.distance - w.radius - bump;
        let compression = w.travel - len;
        w.contact = true;
        w.point.copy(origin).addScaledVector(dir, _hit.distance);
        w.normal.copy(_hit.normal);
        if (w.normal.dot(this.up) < 0) w.normal.negate();
        if (compression > w.travel) compression = w.travel; // fully bottomed
        w.compression = compression;
        w.length = w.travel - compression;
        grounded++;
      } else {
        w.contact = false;
        // Wheel droops toward full extension.
        w.compression = Math.max(0, w.compression - dt * 2.5);
        w.length = w.travel - w.compression;
        w.surface = null;
      }
      this.localToWorld(_v3.copy(w.mountTop).setY(w.mountTop.y - w.length), w.centerWorld);
    }
    this.airTime = grounded === 0 ? this.airTime + dt : 0;

    // spring + damper + bump stop
    let maxCompVel = 0;
    for (const w of this.wheels) {
      if (!w.contact) { w.springForce = 0; continue; }
      const vel = (w.compression - w.prevCompression) / dt;
      maxCompVel = Math.max(maxCompVel, vel);
      const damp = vel > 0 ? w.damping : w.damping * s.suspension.reboundRatio;
      let f = w.stiffness * w.compression + damp * vel;
      const bumpStart = w.travel * 0.85;
      if (w.compression > bumpStart) f += w.stiffness * 10 * (w.compression - bumpStart) + w.damping * 2 * Math.max(0, vel);
      w.springForce = Math.max(0, f);
    }
    if (maxCompVel > 0.9) this.suspensionHit = Math.max(this.suspensionHit, maxCompVel);
    // anti-roll bars
    for (const [l, r, k] of [[0, 1, s.suspension.antiRollFront], [2, 3, s.suspension.antiRollRear]]) {
      const wl = this.wheels[l], wr = this.wheels[r];
      if (!wl.contact && !wr.contact) continue;
      const f = k * (wl.compression - wr.compression);
      if (wl.contact) wl.springForce = Math.max(0, wl.springForce + f);
      if (wr.contact) wr.springForce = Math.max(0, wr.springForce - f);
    }
    for (const w of this.wheels) {
      w.load = w.springForce;
      if (w.load > 0) this.addForceAtPoint(_v3.copy(this.up).multiplyScalar(w.load), w.centerWorld);
    }

    // ---------- drivetrain ----------
    const rl = this.wheels[2], rr = this.wheels[3];
    const axleW = (rl.omega + rr.omega) * 0.5;
    dtn.preStep(dt, throttle, this.transmission === 'manual' ? c.clutch : null, c.handbrake, axleW, _dtOut);
    const axleTorque = _dtOut.torque;
    const coupledInertia = _dtOut.inertia;

    // ---------- tires ----------
    const brakeTotal = brake * s.brakes.maxTorque;
    let escWheel = -1;
    if (escBrake > 0) escWheel = yawRate > 0 ? 1 : 0; // outer front wheel
    for (const w of this.wheels) {
      w.driveTorque = w.front ? 0 : axleTorque * 0.5;
      let tb = brakeTotal * (w.front ? s.brakes.frontBias : 1 - s.brakes.frontBias) * 0.5;
      if (w.index === escWheel) tb += escBrake * s.brakes.maxTorque * 0.18;
      // ABS: release brake pressure on a wheel that is locking.
      if (as.abs > 0 && tb > 0 && w.slipRatio < -w.tire.peakSlipRatio * 1.4 && Math.abs(vF) > 3) tb *= 1 - 0.8 * as.abs;
      if (!w.front) tb += c.handbrake * s.brakes.handbrakeTorque * 0.5;
      w.brakeTorque = tb;

      if (!w.contact || w.load <= 0) {
        // Free-spinning wheel in the air.
        const inertia = w.inertia + (w.front ? 0 : coupledInertia);
        w.omega += ((w.driveTorque) / inertia) * dt;
        const db = (tb * dt) / inertia;
        w.omega = Math.abs(w.omega) <= db ? 0 : w.omega - Math.sign(w.omega) * db;
        w.fx = w.fy = 0;
        w.usage = 0;
        w.slipSpeed = 0;
        w.slipRatio = 0;
        w.slipAngle = 0;
        continue;
      }

      const n = w.normal;
      // wheel heading (steered), projected onto the contact plane
      const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
      const fwd = _v1.copy(this.forward).multiplyScalar(cs).addScaledVector(this.left, sn);
      fwd.addScaledVector(n, -fwd.dot(n)).normalize();
      const lat = _v2.crossVectors(n, fwd).normalize();
      const pv = this.pointVelocity(w.point, _v3);
      const vx = pv.dot(fwd);
      const vy = pv.dot(lat);
      const grip = w.surface.grip;
      const Fpeak = w.tire.peakForce(w.load, grip);
      const denomX = Math.max(Math.abs(vx), V_LOW);
      const tanA = vy / Math.max(Math.abs(vx), V_LOW);
      const kp0 = w.tire.peakSlipRatio;

      // Semi-implicit wheel spin: linearise the longitudinal force with its secant stiffness so
      // stiff tires stay stable at the physics rate while wheelspin and lockup remain free.
      let kappa = (w.omega * w.radius - vx) / denomX;
      w.tire.evaluate(kappa, tanA, Fpeak, _tireOut);
      const rho = Math.max(_tireOut.rho, 1e-4);
      const secant = rho < 1e-3 ? w.tire.slope0 : w.tire.curve(rho) / rho;
      const k = (Fpeak * secant) / (kp0 * denomX);
      const I = w.inertia + (w.front ? 0 : coupledInertia);
      const den = I + dt * k * w.radius * w.radius;
      const rolling = w.surface.rolling * w.load * w.radius;
      let omega = (I * w.omega + dt * (w.driveTorque + w.radius * k * vx)) / den;
      const brakeImpulse = ((tb + rolling) * dt) / den;
      omega = Math.abs(omega) <= brakeImpulse ? 0 : omega - Math.sign(omega) * brakeImpulse;
      w.omega = omega;
    }

    // Limited-slip differential: couple rear wheel speeds (lock 1 = spool).
    const lock = s.diffLock;
    if (lock > 0) {
      const blend = lock >= 0.999 ? 1 : 1 - Math.exp(-lock * lock * 420 * dt);
      const avg = (rl.omega + rr.omega) * 0.5;
      rl.omega += (avg - rl.omega) * blend;
      rr.omega += (avg - rr.omega) * blend;
    }
    dtn.postStep((rl.omega + rr.omega) * 0.5);

    // Final tire forces with the updated wheel speeds.
    for (const w of this.wheels) {
      if (!w.contact || w.load <= 0) continue;
      const n = w.normal;
      const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
      const fwd = _v1.copy(this.forward).multiplyScalar(cs).addScaledVector(this.left, sn);
      fwd.addScaledVector(n, -fwd.dot(n)).normalize();
      const lat = _v2.crossVectors(n, fwd).normalize();
      const pv = this.pointVelocity(w.point, _v3);
      const vx = pv.dot(fwd);
      const vy = pv.dot(lat);
      const Fpeak = w.tire.peakForce(w.load, w.surface.grip);
      const denomX = Math.max(Math.abs(vx), V_LOW);
      const kappa = (w.omega * w.radius - vx) / denomX;
      const tanA = vy / Math.max(Math.abs(vx), V_LOW);
      w.tire.evaluate(kappa, tanA, Fpeak, _tireOut);
      let fx = _tireOut.fx;
      let fy = _tireOut.fy;
      // Near standstill, never apply more lateral force than stops the sideways motion this step.
      const maxFy = ((w.load / G) * Math.abs(vy)) / dt;
      if (Math.abs(fy) > maxFy) fy = Math.sign(fy) * maxFy;
      w.slipRatio = kappa;
      w.slipAngle = Math.atan(tanA);
      w.fx = fx;
      w.fy = fy;
      w.usage = _tireOut.usage;
      w.slipSpeed = Math.hypot(w.omega * w.radius - vx, vy);
      w.travelDist += Math.abs(vx) * dt;
      // Apply at roll-centre height rather than the contact patch (less jacking, no tip-over).
      const apply = _v4.copy(w.point).addScaledVector(n, s.rollCenterHeight);
      const f = _v3.copy(fwd).multiplyScalar(fx).addScaledVector(lat, fy);
      this.force.add(f);
      _v1.subVectors(apply, this.position).cross(f);
      this.torque.add(_v1);
    }

    // ---------- aero ----------
    const sp = this.velocity.length();
    this.force.addScaledVector(this.velocity, -s.aero.drag * sp);
    this.force.addScaledVector(this.up, -s.aero.downforce * vF * vF);

    // ---------- drift stabilisation assist (yaw damping only when over-rotating) ----------
    if (as.driftStabilization > 0 && vF > 4) {
      const beta = this.driftAngle;
      if (beta * yawRate < 0) {
        const over = smoothstep(0.38, 1.05, Math.abs(beta));
        const tq = -yawRate * this.inertia.y * 5.5 * as.driftStabilization * over;
        this.torque.addScaledVector(this.up, tq);
      }
    }

    // ---------- integrate ----------
    this.velocity.addScaledVector(this.force, dt / this.mass);
    // Angular: body-frame Euler equations.
    _qInv.copy(this.quaternion).invert();
    const wb = _v1.copy(this.angularVelocity).applyQuaternion(_qInv);
    const tb = _v2.copy(this.torque).applyQuaternion(_qInv);
    const Iw = _v3.set(wb.x * this.inertia.x, wb.y * this.inertia.y, wb.z * this.inertia.z);
    const gyro = _v4.crossVectors(wb, Iw);
    tb.sub(gyro);
    wb.x += tb.x * this.invInertia.x * dt;
    wb.y += tb.y * this.invInertia.y * dt;
    wb.z += tb.z * this.invInertia.z * dt;
    this.angularVelocity.copy(wb).applyQuaternion(this.quaternion);
    // light angular damping (air / bushings)
    this.angularVelocity.multiplyScalar(1 - 0.05 * dt);

    this.position.addScaledVector(this.velocity, dt);
    const ww = this.angularVelocity;
    _q1.set(ww.x * dt * 0.5, ww.y * dt * 0.5, ww.z * dt * 0.5, 0).multiply(this.quaternion);
    this.quaternion.x += _q1.x;
    this.quaternion.y += _q1.y;
    this.quaternion.z += _q1.z;
    this.quaternion.w += _q1.w;
    this.quaternion.normalize();

    for (const w of this.wheels) w.spinAngle = (w.spinAngle + w.omega * dt) % (Math.PI * 2);

    this.collide();
  }

  /** Body vs world contacts (walls, barriers, objects, bottoming out). */
  collide() {
    const e = 0.15, mu = 0.35;
    for (const sph of this.bodySpheres) {
      const c = this.localToWorld(sph.local, _v1);
      if (!this.world.sphereContact(c, sph.radius, _contact)) continue;
      const n = _contact.normal;
      const p = _contact.point;
      this.position.addScaledVector(n, _contact.depth * 0.9);
      const r = _v2.subVectors(p, this.position);
      const vrel = this.pointVelocity(p, _v3);
      const vn = vrel.dot(n);
      if (vn >= 0) continue;
      const rxn = _v4.crossVectors(r, n);
      this.applyInvInertia(rxn);
      const kn = 1 / this.mass + n.dot(rxn.cross(r));
      const j = (-(1 + e) * vn) / kn;
      this.applyImpulse(n, j, r);
      this.impact += j;
      // friction
      const vrel2 = this.pointVelocity(p, _v3);
      const vt = vrel2.addScaledVector(n, -vrel2.dot(n));
      const vtl = vt.length();
      if (vtl > 1e-3) {
        const t = vt.multiplyScalar(1 / vtl);
        const rxt = _v4.crossVectors(r, t);
        this.applyInvInertia(rxt);
        const kt = 1 / this.mass + t.dot(rxt.cross(r));
        const jt = Math.min(vtl / kt, mu * j);
        this.applyImpulse(t, -jt, r);
      }
    }
  }

  applyImpulse(dir, j, r) {
    this.velocity.addScaledVector(dir, j / this.mass);
    const ang = _v4.crossVectors(r, dir).multiplyScalar(j);
    this.applyInvInertia(ang);
    this.angularVelocity.add(ang);
  }

  get rpm() {
    return this.drivetrain.rpm;
  }

  get gear() {
    return this.drivetrain.gear;
  }

  get speedKmh() {
    return this.speed * 3.6;
  }
}
