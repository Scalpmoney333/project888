// Chassis motion metrics: body roll after a steering step and pitch after a brake stab.
// Usage: node tests/chassis.mjs [carIds...]  (exploration tool; thresholds live in physics.test.js)
import * as THREE from 'three';
import { makeCar, drive } from './helpers.js';
import { VEHICLES } from '../src/vehicle/specs.js';

const neutral = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
const e = new THREE.Euler();
export function chassisMetrics(id) {
  const car = makeCar(id);
  drive(car, 20, (t, c) => ({ ...neutral, throttle: c.speed * 3.6 < 60 ? 0.8 : 0.2 }));
  // steering step, then hold and release
  const roll = [];
  drive(car, 1.0, () => ({ ...neutral, steer: 0.35, throttle: 0.3 }), 120, (c) => { e.setFromQuaternion(c.quaternion, 'YXZ'); roll.push(e.z); });
  drive(car, 2.0, () => ({ ...neutral, throttle: 0.3 }), 120, (c) => { e.setFromQuaternion(c.quaternion, 'YXZ'); roll.push(e.z); });
  // brake stab then release
  const car2 = makeCar(id);
  drive(car2, 20, (t, c) => ({ ...neutral, throttle: c.speed * 3.6 < 70 ? 0.8 : 0.2 }));
  const pitch = [];
  drive(car2, 0.6, () => ({ ...neutral, brake: 1 }), 120, (c) => { e.setFromQuaternion(c.quaternion, 'YXZ'); pitch.push(e.x); });
  drive(car2, 2.0, () => ({ ...neutral }), 120, (c) => { e.setFromQuaternion(c.quaternion, 'YXZ'); pitch.push(e.x); });
  const swing = (arr, from) => {
    // number of sign changes of the derivative after `from` with amplitude above 0.05 deg
    const a = arr.slice(from);
    const fin = a.at(-1);
    let crossings = 0, prev = 0;
    for (const v of a) {
      const d = v - fin;
      const s = Math.abs(d) < 0.05 / 57.3 ? 0 : Math.sign(d);
      if (s && prev && s !== prev) crossings++;
      if (s) prev = s;
    }
    const peak = Math.max(...a.map((v) => Math.abs(v - fin)));
    return { crossings, peakDeg: +(peak * 57.3).toFixed(2) };
  };
  const rollPeak = Math.max(...roll.slice(0, 120).map(Math.abs)) * 57.3;
  const rollSteady = Math.abs(roll[119]) * 57.3;
  return {
    rollPeakDeg: +rollPeak.toFixed(2),
    rollOvershoot: +((rollPeak / Math.max(rollSteady, 1e-3)) - 1).toFixed(2),
    rollAfterRelease: swing(roll, 120),
    pitchPeakDeg: +(Math.max(...pitch.slice(0, 72).map(Math.abs)) * 57.3).toFixed(2),
    pitchAfterRelease: swing(pitch, 72),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = process.argv.length > 2 ? process.argv.slice(2) : VEHICLES.map((v) => v.id);
  for (const id of ids) console.log(id.padEnd(10), JSON.stringify(chassisMetrics(id)));
}
