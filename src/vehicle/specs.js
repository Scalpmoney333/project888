// Per-vehicle handling and model setup. Every car is rear-wheel drive.
//
// `tune` holds the player-adjustable parameters (saved per car); buildSpec() merges them into
// the full physics spec, so handling can be changed without touching the simulation code.

const DEG = Math.PI / 180;

export const VEHICLES = [
  {
    id: 'skyline',
    name: 'Nissan Skyline R32',
    subtitle: 'RB26 • RWD conversion • short wheelbase, sharp turn-in',
    url: 'assets/cars/nissan_skyline_r32_gtr.glb',
    model: {
      // Nodes whose meshes form the wheels (tyre, rim, brake disc, caliper).
      wheelNodes: ['Circle.014_18', 'Circle.017_19', 'Circle.020_20', 'Circle.023_21'],
      splitWheelMeshes: false,
      // Parts that steer with the wheel but must not spin.
      nonSpinMaterials: ['brake_caliper'],
      realWheelbase: 2.615,
      exhaustMaterial: 'exhaust',
      paintMaterial: 'paint',
      driverSide: 'right',
      cockpit: { y: 1.08, z: -0.15 },
    },
    defaults: {
      powerKW: 235,
      maxTorque: 370,
      mass: 1400,
      steeringSensitivity: 1.0,
      steeringAngle: 40,
      frontGrip: 1.16,
      rearGrip: 1.08,
      handbrake: 3200,
      suspensionStiffness: 1.0,
      suspensionDamping: 0.34,
      diffLock: 0.55,
      wheelbase: 2.615,
      trackWidth: 1.48,
    },
    base: {
      cgHeight: 0.47,
      frontWeight: 0.57,
      inertiaScale: 0.92,
      groundClearance: 0.13,
      rollCenterHeight: 0.12,
      wheelInertia: 1.05,
      body: { length: 4.55, width: 1.755, height: 1.34 },
      engine: {
        idleRpm: 900, redlineRpm: 7600, limiterRpm: 8000, launchRpm: 3200, torquePeakRpm: 4400,
        engineInertia: 0.17, engineBrake: 60, efficiency: 0.9,
        gears: [3.214, 1.925, 1.302, 1.0, 0.752], reverseRatio: 3.369, finalDrive: 4.111,
        shiftTimeUp: 0.13, shiftTimeDown: 0.17,
      },
      steeringRate: 4.8,
      ackermann: 0.5,
      tires: {
        front: { peakSlipRatio: 0.1, peakSlipAngle: 0.14, shape: 1.32, loadSensitivity: 0.12 },
        rear: { peakSlipRatio: 0.1, peakSlipAngle: 0.15, shape: 1.42, loadSensitivity: 0.12 },
      },
      suspension: { stiffnessFront: 52000, stiffnessRear: 46000, reboundRatio: 1.4, travel: 0.2, antiRollFront: 19000, antiRollRear: 9000 },
      brakes: { maxTorque: 5200, frontBias: 0.66 },
      aero: { drag: 0.41, downforce: 0.06 },
    },
  },
  {
    id: 'chaser',
    name: 'Toyota Chaser JZX100',
    subtitle: '1JZ-GTE • long wheelbase, big lock, soft & torquey',
    url: 'assets/cars/toyota_chaser_tourer_v_jzx100.glb',
    model: {
      // Rims are one mesh per axle and tyres are merged with body parts, so these meshes are
      // split into connected components and assigned to the nearest wheel.
      wheelNodes: ['Object_22', 'Object_23', 'Object_32'],
      splitWheelMeshes: true,
      nonSpinMaterials: [],
      realWheelbase: 2.73,
      exhaustMaterial: 'Exhaust1Mtl',
      paintMaterial: 'Meshesdoor1Mtl',
      driverSide: 'right',
      cockpit: { y: 1.1, z: -0.2 },
    },
    defaults: {
      powerKW: 250,
      maxTorque: 430,
      mass: 1470,
      steeringSensitivity: 1.0,
      steeringAngle: 52,
      frontGrip: 1.12,
      rearGrip: 1.02,
      handbrake: 3400,
      suspensionStiffness: 0.85,
      suspensionDamping: 0.3,
      diffLock: 0.8,
      wheelbase: 2.73,
      trackWidth: 1.48,
    },
    base: {
      cgHeight: 0.52,
      frontWeight: 0.53,
      inertiaScale: 1.0,
      groundClearance: 0.13,
      rollCenterHeight: 0.13,
      wheelInertia: 1.1,
      body: { length: 4.76, width: 1.755, height: 1.4 },
      engine: {
        idleRpm: 850, redlineRpm: 7200, limiterRpm: 7600, launchRpm: 2800, torquePeakRpm: 3600,
        engineInertia: 0.2, engineBrake: 65, efficiency: 0.9,
        gears: [3.251, 1.955, 1.31, 1.0, 0.753], reverseRatio: 3.768, finalDrive: 4.3,
        shiftTimeUp: 0.15, shiftTimeDown: 0.19,
      },
      steeringRate: 4.4,
      ackermann: 0.2,
      tires: {
        front: { peakSlipRatio: 0.1, peakSlipAngle: 0.14, shape: 1.3, loadSensitivity: 0.12 },
        rear: { peakSlipRatio: 0.1, peakSlipAngle: 0.16, shape: 1.48, loadSensitivity: 0.12 },
      },
      suspension: { stiffnessFront: 50000, stiffnessRear: 44000, reboundRatio: 1.35, travel: 0.22, antiRollFront: 15000, antiRollRear: 8000 },
      brakes: { maxTorque: 5400, frontBias: 0.64 },
      aero: { drag: 0.43, downforce: 0.04 },
    },
  },
];

/** Player-facing tuning parameters with UI ranges. */
export const TUNING_PARAMS = [
  { key: 'powerKW', label: 'Engine power', unit: 'kW', min: 120, max: 450, step: 5 },
  { key: 'maxTorque', label: 'Max torque', unit: 'Nm', min: 200, max: 700, step: 5 },
  { key: 'mass', label: 'Vehicle mass', unit: 'kg', min: 1000, max: 1900, step: 10 },
  { key: 'steeringSensitivity', label: 'Steering sensitivity', unit: '×', min: 0.5, max: 1.6, step: 0.05 },
  { key: 'steeringAngle', label: 'Steering angle', unit: '°', min: 28, max: 65, step: 1 },
  { key: 'frontGrip', label: 'Front tire grip', unit: 'μ', min: 0.7, max: 1.5, step: 0.01 },
  { key: 'rearGrip', label: 'Rear tire grip', unit: 'μ', min: 0.6, max: 1.5, step: 0.01 },
  { key: 'handbrake', label: 'Handbrake strength', unit: 'Nm', min: 800, max: 6000, step: 50 },
  { key: 'suspensionStiffness', label: 'Suspension stiffness', unit: '×', min: 0.5, max: 1.8, step: 0.05 },
  { key: 'suspensionDamping', label: 'Suspension damping', unit: 'ζ', min: 0.12, max: 0.7, step: 0.01 },
  { key: 'diffLock', label: 'Differential lock', unit: '', min: 0, max: 1, step: 0.05 },
  { key: 'wheelbase', label: 'Wheelbase', unit: 'm', min: 2.3, max: 3.0, step: 0.01 },
  { key: 'trackWidth', label: 'Track width', unit: 'm', min: 1.3, max: 1.7, step: 0.01 },
];

export function getVehicle(id) {
  return VEHICLES.find((v) => v.id === id) || VEHICLES[0];
}

/**
 * Merge base data, tuning values and model-measured values (wheel radii, body size).
 * @param {object} def   entry from VEHICLES
 * @param {object} tune  values keyed like TUNING_PARAMS (missing keys use defaults)
 * @param {object} [measured] {wheelRadiusFront, wheelRadiusRear, body}
 */
export function buildSpec(def, tune = {}, measured = {}) {
  const t = { ...def.defaults, ...tune };
  const b = def.base;
  const stiff = t.suspensionStiffness;
  return {
    id: def.id,
    mass: t.mass,
    cgHeight: b.cgHeight,
    frontWeight: b.frontWeight,
    inertiaScale: b.inertiaScale,
    groundClearance: b.groundClearance,
    rollCenterHeight: b.rollCenterHeight,
    wheelInertia: b.wheelInertia,
    wheelbase: t.wheelbase,
    trackFront: t.trackWidth,
    trackRear: t.trackWidth,
    wheelRadiusFront: measured.wheelRadiusFront ?? 0.32,
    wheelRadiusRear: measured.wheelRadiusRear ?? 0.32,
    body: measured.body ?? b.body,
    diffLock: t.diffLock,
    engine: { ...b.engine, powerKW: t.powerKW, maxTorque: t.maxTorque, autoBlip: true },
    steering: { maxAngle: t.steeringAngle * DEG, rate: b.steeringRate * t.steeringSensitivity, ackermann: b.ackermann, sensitivity: t.steeringSensitivity },
    tires: {
      front: { ...b.tires.front, mu: t.frontGrip },
      rear: { ...b.tires.rear, mu: t.rearGrip },
    },
    suspension: {
      ...b.suspension,
      stiffnessFront: b.suspension.stiffnessFront * stiff,
      stiffnessRear: b.suspension.stiffnessRear * stiff,
      antiRollFront: b.suspension.antiRollFront * stiff,
      antiRollRear: b.suspension.antiRollRear * stiff,
      damping: t.suspensionDamping,
    },
    brakes: { ...b.brakes, handbrakeTorque: t.handbrake },
    aero: { ...b.aero },
  };
}
