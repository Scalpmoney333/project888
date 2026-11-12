// Physics acceptance tests (run with `npm test`). They drive the real Vehicle on a flat world
// and check the behaviours listed in the spec: RWD, wheel rotation, steering, wheelspin,
// drift initiation by power and handbrake, countersteer control, grip recovery, inertia,
// stability, frame-rate independence, and both transmissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCar, drive, deg, upright } from './helpers.js';
import { chassisMetrics } from './chassis.mjs';

const CARS = ['skyline', 'chaser', 'markii', 's15', 's13'];
const neutral = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

// Body control: no car may roll or wobble like the original loose Chaser setup did
// (3.3 deg roll with 75% overshoot in this manoeuvre).
for (const id of CARS) {
  test(`${id}: chassis is planted (limited roll, little overshoot)`, () => {
    const m = chassisMetrics(id);
    assert.ok(m.rollPeakDeg < 2.5, `roll ${m.rollPeakDeg} deg`);
    assert.ok(m.rollOvershoot < 0.6, `overshoot ${m.rollOvershoot}`);
    assert.ok(m.rollAfterRelease.crossings <= 3, `oscillation ${m.rollAfterRelease.crossings}`);
  });
}

/** Reach a steady speed (km/h) in a straight line. */
function cruise(car, kmh) {
  drive(car, 20, (t, c) => ({ ...neutral, throttle: c.speed * 3.6 < kmh ? 0.9 : 0.15 }), 60);
  return car;
}

/** A simple drifting driver: countersteers proportionally to drift angle and yaw rate. */
function countersteerDriver(targetDeg = 30, throttleHi = 0.95) {
  return (t, c) => {
    const beta = c.driftAngle;
    const r = c.angularVelocity.y;
    const maxSteer = c.spec.steering.maxAngle;
    // Countersteer = steer toward the slide (beta > 0 => slide left => steer left, input < 0).
    const want = beta * 1.05 - r * 0.12;
    const steer = Math.max(-1, Math.min(1, -want / maxSteer));
    const throttle = Math.abs(deg(beta)) > targetDeg ? 0.45 : throttleHi;
    return { ...neutral, steer, throttle };
  };
}

for (const id of CARS) {
  test(`${id}: rear-wheel drive only`, () => {
    const car = makeCar(id);
    let frontDrive = 0, rearDrive = 0, frontSlip = 0, rearSlip = 0;
    drive(car, 3, () => ({ ...neutral, throttle: 1 }), 60, (c) => {
      frontDrive = Math.max(frontDrive, Math.abs(c.wheels[0].driveTorque), Math.abs(c.wheels[1].driveTorque));
      rearDrive = Math.max(rearDrive, Math.abs(c.wheels[2].driveTorque));
      frontSlip = Math.max(frontSlip, Math.abs(c.wheels[0].slipRatio));
      rearSlip = Math.max(rearSlip, c.wheels[2].slipRatio);
    });
    assert.equal(frontDrive, 0);
    assert.ok(rearDrive > 1000, `rear drive torque ${rearDrive}`);
    assert.ok(frontSlip < 0.03, `front wheels free rolling, slip ${frontSlip}`);
    assert.ok(car.speed > 8, 'car accelerates');
  });

  test(`${id}: all wheels rotate with road speed, forwards and in reverse`, () => {
    const car = cruise(makeCar(id), 50);
    drive(car, 2, () => ({ ...neutral, throttle: 0.25 }));
    for (const w of car.wheels) {
      const expected = car.speed / w.radius;
      assert.ok(Math.abs(w.omega - expected) / expected < 0.06, `wheel ${w.index} omega ${w.omega} vs ${expected}`);
    }
    const rev = makeCar(id, { transmission: 'manual' });
    rev.drivetrain.requestGear(-1, 0);
    drive(rev, 3, () => ({ ...neutral, throttle: 0.5 }));
    assert.ok(rev.speed < -2, `reverses, speed ${rev.speed}`);
    for (const w of rev.wheels) assert.ok(w.omega < -2, `wheel ${w.index} spins backwards ${w.omega}`);
  });

  test(`${id}: front wheels steer, rears do not`, () => {
    const car = cruise(makeCar(id), 30);
    drive(car, 0.5, () => ({ ...neutral, steer: 1, throttle: 0.2 }));
    assert.ok(car.wheels[0].steer < -0.1 && car.wheels[1].steer < -0.1, 'right input turns fronts right');
    assert.equal(car.wheels[2].steer, 0);
    drive(car, 0.8, () => ({ ...neutral, steer: -1, throttle: 0.2 }));
    assert.ok(car.wheels[0].steer > 0.1 && car.wheels[1].steer > 0.1, 'left input turns fronts left');
  });

  test(`${id}: excessive throttle spins the rear wheels`, () => {
    const car = makeCar(id);
    let maxRear = 0, maxFront = 0;
    drive(car, 1.5, () => ({ ...neutral, throttle: 1 }), 60, (c) => {
      maxRear = Math.max(maxRear, c.wheels[2].slipRatio, c.wheels[3].slipRatio);
      maxFront = Math.max(maxFront, Math.abs(c.wheels[0].slipRatio));
    });
    assert.ok(maxRear > 0.4, `rear slip ratio ${maxRear}`);
    assert.ok(maxFront < 0.03);
  });

  test(`${id}: power-over drift from throttle + steering`, () => {
    const car = cruise(makeCar(id), 55);
    let maxBeta = 0;
    drive(car, 2, () => ({ ...neutral, steer: 1, throttle: 1 }), 60, (c) => { maxBeta = Math.max(maxBeta, Math.abs(c.driftAngle)); });
    assert.ok(deg(maxBeta) > 15, `drift angle ${deg(maxBeta)}`);
  });

  test(`${id}: handbrake initiates a drift and rears lock`, () => {
    const car = cruise(makeCar(id), 65);
    let maxBeta = 0, minRear = 0;
    drive(car, 0.7, () => ({ ...neutral, steer: 0.5, handbrake: 1 }), 60, (c) => {
      maxBeta = Math.max(maxBeta, Math.abs(c.driftAngle));
      minRear = Math.min(minRear, c.wheels[2].slipRatio);
    });
    assert.ok(minRear < -0.5, `rear lockup ${minRear}`);
    assert.ok(deg(maxBeta) > 10, `drift angle ${deg(maxBeta)}`);
  });

  test(`${id}: countersteering holds a drift that otherwise spins`, () => {
    const assists = { countersteer: 0, driftStabilization: 0, steering: 0 };
    const init = (c) => {
      cruise(c, 60);
      drive(c, 0.6, () => ({ ...neutral, steer: 0.7, handbrake: 1 }));
    };
    const spin = makeCar(id, { assists });
    init(spin);
    let spinMax = 0;
    drive(spin, 3, () => ({ ...neutral, steer: 0.7, throttle: 1 }), 60, (c) => { spinMax = Math.max(spinMax, Math.abs(c.driftAngle)); });

    const held = makeCar(id, { assists });
    init(held);
    let heldMax = 0, minUp = 1;
    drive(held, 3, countersteerDriver(30), 60, (c) => {
      heldMax = Math.max(heldMax, Math.abs(c.driftAngle));
      minUp = Math.min(minUp, upright(c));
    });
    assert.ok(deg(spinMax) > 75, `no countersteer spins (${deg(spinMax)})`);
    assert.ok(deg(heldMax) < 70, `countersteer keeps angle (${deg(heldMax)})`);
    assert.ok(held.speed > 4, `still moving forward ${held.speed}`);
    assert.ok(minUp > 0.85, 'no rollover');
  });

  test(`${id}: lifting off restores grip progressively`, () => {
    const car = cruise(makeCar(id), 60);
    drive(car, 0.6, () => ({ ...neutral, steer: 0.7, handbrake: 1 }));
    drive(car, 0.3, countersteerDriver(30));
    const start = Math.abs(car.driftAngle);
    const trace = [];
    drive(car, 3, (t, c) => ({ ...countersteerDriver(30)(t, c), throttle: 0 }), 60, (c) => trace.push(Math.abs(c.driftAngle)));
    assert.ok(deg(start) > 8, `was drifting ${deg(start)}`);
    assert.ok(deg(trace.at(-1)) < 4, `grip restored, beta ${deg(trace.at(-1))}`);
    // progressive: still sliding a little after 0.15 s
    assert.ok(deg(trace[9]) > 2, `not an instant snap ${deg(trace[9])}`);
  });

  test(`${id}: inertia - direction does not change instantly`, () => {
    const car = cruise(makeCar(id), 70);
    const v0 = car.velocity.clone().normalize();
    drive(car, 0.1, () => ({ ...neutral, steer: 1, throttle: 0.3 }));
    const ang = Math.acos(Math.min(1, v0.dot(car.velocity.clone().normalize())));
    assert.ok(deg(ang) < 3, `velocity turned ${deg(ang)} deg in 0.1 s`);
    assert.ok(Math.abs(car.angularVelocity.y) < 1.2);
  });

  test(`${id}: default assists keep a drift controllable and the car upright`, () => {
    const car = cruise(makeCar(id), 70);
    let maxYaw = 0, minUp = 1;
    drive(car, 0.5, () => ({ ...neutral, steer: 0.6, handbrake: 1 }));
    drive(car, 4, (t, c) => ({ ...neutral, steer: 0.1, throttle: 0.9 }), 60, (c) => {
      maxYaw = Math.max(maxYaw, Math.abs(c.angularVelocity.y));
      minUp = Math.min(minUp, upright(c));
    });
    assert.ok(maxYaw < 3.0, `yaw rate ${maxYaw}`);
    assert.ok(minUp > 0.85, `upright ${minUp}`);
  });

  test(`${id}: same result at 30, 60 and 144 fps`, () => {
    const results = [30, 60, 144].map((fps) => {
      const car = makeCar(id);
      drive(car, 6, (t) => ({ ...neutral, throttle: 0.8, steer: t > 3 ? 0.4 : 0 }), fps);
      return car.position.clone();
    });
    for (const p of results) assert.ok(p.distanceTo(results[1]) < 0.6, `diverged ${p.distanceTo(results[1])} m`);
  });

  test(`${id}: automatic gearbox shifts up and down`, () => {
    const car = makeCar(id);
    let maxGear = 0;
    drive(car, 12, () => ({ ...neutral, throttle: 1 }), 60, (c) => { maxGear = Math.max(maxGear, c.gear); });
    assert.ok(maxGear >= 3, `reached gear ${maxGear}`);
    drive(car, 6, () => ({ ...neutral, brake: 0.7 }));
    assert.ok(car.gear <= 2, `downshifted to ${car.gear}`);
  });

  test(`${id}: manual gearbox obeys the driver`, () => {
    const car = makeCar(id, { transmission: 'manual' });
    drive(car, 4, () => ({ ...neutral, throttle: 1 }));
    assert.equal(car.gear, 1, 'stays in 1st on the limiter');
    assert.ok(car.rpm > car.spec.engine.redlineRpm * 0.9, `revs high ${car.rpm}`);
    car.drivetrain.shiftUp(car.speed);
    drive(car, 1, () => ({ ...neutral, throttle: 1 }));
    assert.equal(car.gear, 2);
    car.drivetrain.shiftDown(car.speed);
    car.drivetrain.shiftDown(car.speed);
    drive(car, 0.5, () => ({ ...neutral }));
    assert.equal(car.gear, 0, 'neutral');
  });
}
