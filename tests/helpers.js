// Shared helpers for headless physics tests: a flat world and a scripted driver.
import * as THREE from 'three';
import { Vehicle } from '../src/physics/Vehicle.js';
import { VEHICLES, buildSpec } from '../src/vehicle/specs.js';
import { SURFACES } from '../src/physics/surfaces.js';

export class FlatWorld {
  constructor({ grip = 0, wallX = null } = {}) {
    this.surface = SURFACES[grip];
    this.wallX = wallX; // optional wall plane at x = wallX facing -X
    this.minY = 0;
  }
  raycast(origin, dir, far, out) {
    if (dir.y >= -1e-6) return false;
    const t = -origin.y / dir.y;
    if (t < 0 || t > far) return false;
    out.distance = t;
    out.normal.set(0, 1, 0);
    out.surface = this.surface;
    return true;
  }
  sphereContact(c, r, out) {
    let found = false;
    out.depth = 0;
    if (c.y < r) {
      out.depth = r - c.y;
      out.normal.set(0, 1, 0);
      out.point.set(c.x, 0, c.z);
      found = true;
    }
    if (this.wallX !== null && c.x > this.wallX - r) {
      const d = c.x - (this.wallX - r);
      if (d > out.depth) {
        out.depth = d;
        out.normal.set(-1, 0, 0);
        out.point.set(this.wallX, c.y, c.z);
        found = true;
      }
    }
    return found;
  }
}

export function makeCar(id = 'skyline', opts = {}) {
  const def = VEHICLES.find((v) => v.id === id);
  const world = opts.world || new FlatWorld();
  const car = new Vehicle(buildSpec(def, opts.tune || {}), world);
  car.transmission = opts.transmission || 'auto';
  car.drivetrain.spec.autoBlip = car.transmission === 'auto';
  if (opts.assists) Object.assign(car.assists, opts.assists);
  car.reset(new THREE.Vector3(0, 0, 0), 0);
  return car;
}

/** Run `seconds` of simulation at a given frame rate with a control function(t, car). */
export function drive(car, seconds, control, fps = 60, onFrame) {
  const dt = 1 / fps;
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) {
    const t = car.time;
    if (control) Object.assign(car.controls, control(t, car));
    car.update(dt);
    if (onFrame) onFrame(car, t);
  }
  return car;
}

export const deg = (r) => (r * 180) / Math.PI;
export const upright = (car) => new THREE.Vector3(0, 1, 0).applyQuaternion(car.quaternion).y;
export const yaw = (car) => {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quaternion);
  return Math.atan2(f.x, f.z);
};
