// Exploratory telemetry run (not a test): prints how the car behaves in scripted manoeuvres.
import { makeCar, drive, deg, upright } from './helpers.js';

const id = process.argv[2] || 'skyline';
const log = (label, car) => {
  const w = car.wheels;
  console.log(
    label.padEnd(26),
    `t=${car.time.toFixed(2)} v=${(car.speed * 3.6).toFixed(1)}km/h g=${car.gear} rpm=${car.rpm.toFixed(0)} beta=${deg(car.driftAngle).toFixed(1)} yawr=${car.angularVelocity.y.toFixed(2)} up=${upright(car).toFixed(3)}`,
    `roll=${(Math.asin(new (car.position.constructor)(1,0,0).applyQuaternion(car.quaternion).y)*57.3).toFixed(2)} load=${w.map((x) => x.load.toFixed(0)).join('/')} kap=${w.map((x) => x.slipRatio.toFixed(2)).join('/')} y=${car.position.y.toFixed(3)} lock=${car.drivetrain.locked}`,
  );
};

let car = makeCar(id);
drive(car, 1, () => ({}));
log('settle', car);
drive(car, 6, () => ({ throttle: 1, brake: 0, steer: 0, handbrake: 0 }), 60, (c) => { if (Math.abs(c.time % 0.5) < 1 / 60) log('accel', c); });
drive(car, 3, () => ({ throttle: 0, brake: 1, steer: 0, handbrake: 0 }), 60, (c) => { if (Math.abs(c.time % 0.5) < 1 / 60) log('brake', c); });

console.log('--- power-over drift');
car = makeCar(id);
drive(car, 5, (t) => ({ throttle: t < 4 ? 0.7 : 0.4, brake: 0, steer: 0, handbrake: 0 }));
log('cruise', car);
drive(car, 4, () => ({ throttle: 1, steer: 0.6, brake: 0, handbrake: 0 }), 60, (c) => { if (Math.abs(c.time % 0.25) < 1 / 60) log('steer+throttle', c); });

console.log('--- handbrake');
car = makeCar(id);
drive(car, 6, () => ({ throttle: 0.8, brake: 0, steer: 0, handbrake: 0 }));
log('cruise', car);
drive(car, 0.6, () => ({ throttle: 0, steer: 0.5, handbrake: 1 }), 60, (c) => { if (Math.abs(c.time % 0.1) < 1 / 60) log('handbrake', c); });
drive(car, 3, () => ({ throttle: 0.7, steer: -0.3, handbrake: 0, brake: 0 }), 60, (c) => { if (Math.abs(c.time % 0.25) < 1 / 60) log('after hb', c); });
