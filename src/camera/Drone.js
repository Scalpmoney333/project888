// Free-flying drone camera. Movement is relative to where the drone looks (yaw only, so it
// flies level); altitude is separate. Speed eases in and out so it feels like a real drone.

import * as THREE from 'three';
import { settings } from '../core/settings.js';

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const DOWN = new THREE.Vector3(0, -1, 0);
const _hit = { distance: 0, normal: new THREE.Vector3(), surface: null };

export class DroneCamera {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.active = false;
  }

  /** Start from the current view so entering drone mode has no jump. */
  start() {
    this.pos.copy(this.camera.position);
    _e.setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = _e.y;
    this.pitch = _e.x;
    this.vel.set(0, 0, 0);
    this.active = true;
  }

  stop() {
    this.active = false;
  }

  /** Drag look: dx/dy in radians (+dx turns right, +dy looks up). */
  look(dx, dy) {
    this.yaw -= dx;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy));
  }

  /** Field of view in degrees (saved in settings), changed with the FOV buttons / wheel. */
  setFov(deg) {
    const fov = Math.max(30, Math.min(110, Math.round(deg)));
    settings.data.camera.droneFov = fov;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    return fov;
  }

  /**
   * @param {object} c  {forward, right, up, zoom} each in -1..1, fast (boolean)
   */
  update(dt, c) {
    if (c.zoom) this.zooming = this.setFov(settings.data.camera.droneFov + c.zoom * 35 * dt);
    else if (this.zooming) { settings.set('camera.droneFov', settings.data.camera.droneFov); this.zooming = 0; }
    if (this.camera.fov !== settings.data.camera.droneFov) this.setFov(settings.data.camera.droneFov);
    const max = c.fast ? 45 : 16; // m/s
    _f.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _r.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const target = _f.multiplyScalar(c.forward * max).addScaledVector(_r, c.right * max);
    target.y = c.up * max * 0.6;
    this.vel.lerp(target, 1 - Math.exp(-4 * dt));
    this.pos.addScaledVector(this.vel, dt);
    // Stay above the ground.
    _f.set(this.pos.x, this.pos.y + 50, this.pos.z);
    if (this.world.raycast(_f, DOWN, 400, _hit)) {
      const gy = _f.y - _hit.distance + 0.6;
      if (this.pos.y < gy) { this.pos.y = gy; this.vel.y = Math.max(0, this.vel.y); }
    }
    this.camera.position.copy(this.pos);
    this.camera.quaternion.setFromEuler(_e.set(this.pitch, this.yaw, 0, 'YXZ'));
  }

  get speed() {
    return this.vel.length();
  }
}
