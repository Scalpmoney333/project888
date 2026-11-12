// Free-flying drone camera: fly around the map while the car stays parked.

import * as THREE from 'three';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
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

  /** Take off from wherever the current camera is. */
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

  look(dYaw, dPitch) {
    this.yaw -= dYaw;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dPitch));
  }

  /** @param input {forward, right, up} in -1..1 and fast */
  update(dt, input) {
    const speed = input.fast ? 45 : 16;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const want = _fwd.multiplyScalar(input.forward * speed).addScaledVector(_right, input.right * speed);
    want.y = input.up * speed * 0.6;
    this.vel.lerp(want, 1 - Math.exp(-4 * dt));
    this.pos.addScaledVector(this.vel, dt);
    // Don't fly through the ground.
    _fwd.set(this.pos.x, this.pos.y + 50, this.pos.z);
    if (this.world.raycast(_fwd, DOWN, 400, _hit)) {
      const gy = _fwd.y - _hit.distance + 0.6;
      if (this.pos.y < gy) {
        this.pos.y = gy;
        this.vel.y = Math.max(0, this.vel.y);
      }
    }
    this.camera.position.copy(this.pos);
    this.camera.quaternion.setFromEuler(_e.set(this.pitch, this.yaw, 0, 'YXZ'));
  }

  get speed() {
    return this.vel.length();
  }
}
