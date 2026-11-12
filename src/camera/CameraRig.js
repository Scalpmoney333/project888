// Five camera modes with frame-rate independent smoothing, drift-aware framing, shake and
// smooth transitions between modes.

import * as THREE from 'three';
import { settings } from '../core/settings.js';

export const CAMERA_MODES = ['Chase', 'Close chase', 'Cinematic drift', 'Hood', 'Cockpit'];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const LOOK_HOLD = 1.0; // seconds the free-look view is held after the finger lifts
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _hit = { distance: 0, normal: new THREE.Vector3(), surface: null };
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const Q180 = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);

const damp = (k, dt) => 1 - Math.exp(-k * dt);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class CameraRig {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.mode = settings.data.camera.mode;
    this.yaw = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.side = 1;
    this.shakeT = 0;
    this.trauma = 0;
    this.transition = 1;
    this.fromPos = new THREE.Vector3();
    this.fromQuat = new THREE.Quaternion();
    this.initialized = false;
    this.fovKick = 0;
  }

  setMode(m) {
    const prev = this.mode;
    this.mode = (m + CAMERA_MODES.length) % CAMERA_MODES.length;
    this.fromPos.copy(this.camera.position);
    this.fromQuat.copy(this.camera.quaternion);
    // Blend only between external cameras; blending to/from a car-mounted view would
    // sweep the camera through the bodywork, so those switches cut instantly.
    const mounted = (x) => x >= 3;
    this.transition = mounted(prev) || mounted(this.mode) ? 1 : 0;
    if (mounted(prev) && !mounted(this.mode)) this.needSnap = true;
    settings.set('camera.mode', this.mode);
  }

  next() {
    this.setMode(this.mode + 1);
  }

  snap() {
    this.initialized = false;
  }

  addTrauma(x) {
    this.trauma = Math.min(1, this.trauma + x);
  }

  /** Free look offsets in radians: +yaw turns the view left (about world up), +pitch looks down. */
  lookBy(dYaw, dPitch) {
    this.lookYaw = wrap((this.lookYaw || 0) + dYaw);
    this.lookPitch = Math.max(-0.5, Math.min(1.1, (this.lookPitch || 0) + dPitch));
    this.lookReleased = performance.now();
  }

  setLookHeld(held) {
    this.lookHeld = held;
    this.lookReleased = performance.now();
  }

  /** After the finger lifts, hold the view for LOOK_HOLD seconds (wall clock, so it is ~1 s even at low fps), then ease back. */
  updateLook(dt) {
    this.lookYaw ||= 0;
    this.lookPitch ||= 0;
    if (this.lookHeld) return;
    if (performance.now() - (this.lookReleased || 0) > LOOK_HOLD * 1000) {
      const k = damp(7, dt);
      this.lookYaw -= this.lookYaw * k;
      this.lookPitch -= this.lookPitch * k;
      if (Math.abs(this.lookYaw) < 1e-3) this.lookYaw = 0;
      if (Math.abs(this.lookPitch) < 1e-3) this.lookPitch = 0;
    }
  }

  update(dt, vehicle, model) {
    const c = settings.data.camera;
    const cam = this.camera;
    const carPos = vehicle.renderPosition;
    const carQ = vehicle.renderQuaternion;
    const fwd = _v.set(0, 0, 1).applyQuaternion(carQ);
    const carYaw = Math.atan2(fwd.x, fwd.z);
    const vel = vehicle.velocity;
    const speed = Math.hypot(vel.x, vel.z);
    const velYaw = speed > 2.5 && vehicle.speed > -1 ? Math.atan2(vel.x, vel.z) : carYaw;
    const beta = vehicle.driftAngle;
    if (!this.initialized) {
      this.yaw = carYaw;
      this.initialized = true;
      this.needSnap = true;
    }

    // Shake: speed rumble + tire slip + impacts (trauma), scaled by the setting.
    const slip = Math.max(vehicle.wheels[2].slipSpeed, vehicle.wheels[3].slipSpeed);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const shakeAmt = c.shake * (0.004 * Math.min(1, speed / 50) + 0.006 * Math.min(1, slip / 15) + 0.08 * this.trauma * this.trauma);
    this.shakeT += dt * 30;
    const sx = Math.sin(this.shakeT * 1.13) * Math.sin(this.shakeT * 0.71) * shakeAmt;
    const sy = Math.sin(this.shakeT * 1.37 + 1) * Math.sin(this.shakeT * 0.53) * shakeAmt;

    let fov = c.fov;
    const mode = this.mode;
    if (mode <= 2) {
      const close = mode === 1;
      const cine = mode === 2;
      const dist = (close ? 3.9 : cine ? 6.2 : 5.9) * c.distance;
      const height = (close ? 1.25 : cine ? 1.55 : 1.9) * c.height;
      // Camera heading blends travel direction and car heading ("rotation strength").
      const rot = cine ? c.rotation * 0.6 : c.rotation;
      let target = velYaw + wrap(carYaw - velYaw) * rot;
      if (cine) {
        // Swing to the outside of the drift to show the angle.
        const want = Math.sign(beta || this.side) * Math.min(1, Math.abs(beta) / 0.6);
        this.side += (want - this.side) * damp(1.5, dt);
        target += this.side * (0.35 + 0.35 * c.drift);
      } else {
        target += -beta * 0.25 * c.drift;
      }
      const k = (close ? 7 : 4.5) * (0.4 + c.sensitivity * 1.2) * (1.4 - c.smoothing);
      this.yaw += wrap(target - this.yaw) * damp(k, dt);
      const desired = _v2.set(-Math.sin(this.yaw) * dist, height, -Math.cos(this.yaw) * dist).add(carPos);
      // Positional lag gives a sense of inertia; less lag when close.
      const pk = (close ? 14 : 9) * (1.3 - c.smoothing);
      this.pos.lerp(desired, this.needSnap ? 1 : damp(pk, dt));
      this.updateLook(dt);
      // Free look orbits the (lagged) chase position around the car.
      const lp = _v3.copy(this.pos);
      if (this.lookYaw || this.lookPitch) {
        const o = lp.sub(carPos);
        const r = o.length();
        const a = Math.atan2(o.x, o.z) + this.lookYaw;
        const e = Math.max(-0.15, Math.min(1.35, Math.atan2(o.y, Math.hypot(o.x, o.z)) + this.lookPitch));
        lp.set(Math.sin(a) * Math.cos(e) * r, Math.sin(e) * r, Math.cos(a) * Math.cos(e) * r).add(carPos);
      }
      // keep the camera above ground
      _v.set(lp.x, lp.y + 2.5, lp.z);
      if (this.world.raycast(_v, DOWN, 40, _hit)) {
        const gy = _v.y - _hit.distance + 0.4;
        if (lp.y < gy) lp.y = gy;
        if (this.pos.y < gy) this.pos.y = gy;
      }
      const lookAhead = Math.min(4, speed * 0.08) * (1 - Math.min(1, Math.abs(this.lookYaw) * 2));
      const lookTarget = _v.set(Math.sin(this.yaw) * lookAhead, 0.75, Math.cos(this.yaw) * lookAhead).add(carPos);
      this.look.lerp(lookTarget, this.needSnap ? 1 : damp(20, dt));
      this.needSnap = false;
      cam.position.copy(lp);
      cam.position.x += sx;
      cam.position.y += sy;
      cam.lookAt(this.look);
      fov += (cine ? 6 : 0) + Math.min(10, speed * 0.12) + c.drift * Math.min(1, Math.abs(beta) / 0.7) * 6;
      this.setNear(0.1);
    } else {
      // Car-mounted cameras with a stabilised horizon.
      const cg = model.cgOffset(vehicle.spec);
      let local;
      if (mode === 3) {
        local = _v2.set(0, model.hoodY + 0.22 - cg.y, model.frontZ - 0.5 - cg.z);
      } else {
        const ck = model.def.model.cockpit;
        const side = model.def.model.driverSide === 'right' ? -1 : 1;
        local = _v2.set(side * model.measured.trackWidth * 0.24, ck.y - cg.y, ck.z - cg.z);
      }
      cam.position.copy(local).applyQuaternion(carQ).add(carPos);
      _e.setFromQuaternion(carQ, 'YXZ');
      const keep = mode === 3 ? 0.5 : 0.35; // how much body pitch/roll reaches the view
      _e.x *= keep;
      _e.z *= keep;
      _q.setFromEuler(_e);
      // Look along the car (+Z): rotate a camera that looks down -Z by 180 degrees about Y.
      cam.quaternion.copy(_q).multiply(Q180);
      // Free look: turn the head (yaw about world up, pitch about the view's right axis).
      this.updateLook(dt);
      if (this.lookYaw || this.lookPitch) {
        cam.quaternion.premultiply(_q.setFromAxisAngle(UP, this.lookYaw));
        cam.quaternion.multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), -Math.max(-0.6, Math.min(0.6, this.lookPitch))));
      }
      cam.position.x += sx * 0.4;
      cam.position.y += sy * 0.4;
      fov += Math.min(8, speed * 0.08);
      this.setNear(0.05);
    }

    // Blend from the previous mode's camera.
    if (this.transition < 1) {
      this.transition = Math.min(1, this.transition + dt / 0.45);
      const t = this.transition * this.transition * (3 - 2 * this.transition);
      cam.position.lerpVectors(this.fromPos, cam.position, t);
      cam.quaternion.slerpQuaternions(this.fromQuat, cam.quaternion, t);
    }
    this.fovKick += (fov - this.fovKick) * damp(4, dt);
    if (Math.abs(cam.fov - this.fovKick) > 0.01) {
      cam.fov = this.fovKick;
      cam.updateProjectionMatrix();
    }
    void _m;
  }
}

CameraRig.prototype.setNear = function setNear(n) {
  if (this.camera.near !== n) {
    this.camera.near = n;
    this.camera.updateProjectionMatrix();
  }
};
