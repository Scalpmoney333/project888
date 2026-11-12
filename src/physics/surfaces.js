// Surface properties. `grip` multiplies tire friction, `rolling` is the rolling-resistance
// coefficient, `bump` the amplitude (m) of road texture fed into the suspension, `dust` the
// amount of spray thrown up (coloured `dustColor`).
export const SURFACES = [
  { id: 0, name: 'tarmac', grip: 1.0, rolling: 0.012, bump: 0.0012, smoke: 1, skid: 1, dust: 0 },
  { id: 1, name: 'grass', grip: 0.6, rolling: 0.05, bump: 0.01, smoke: 0, skid: 0, dust: 0.6 },
  { id: 2, name: 'concrete', grip: 0.93, rolling: 0.013, bump: 0.0025, smoke: 1, skid: 1, dust: 0 },
  { id: 3, name: 'kerb', grip: 0.86, rolling: 0.016, bump: 0.008, smoke: 1, skid: 1, dust: 0 },
  { id: 4, name: 'dirt', grip: 0.68, rolling: 0.035, bump: 0.012, smoke: 0, skid: 0, dust: 1 },
  { id: 5, name: 'wet tarmac', grip: 0.82, rolling: 0.012, bump: 0.0012, smoke: 0.4, skid: 0.6, dust: 0 },
  { id: 6, name: 'packed snow', grip: 0.62, rolling: 0.02, bump: 0.003, smoke: 0, skid: 0.35, dust: 0.8, dustColor: [0.93, 0.95, 0.98] },
  { id: 7, name: 'deep snow', grip: 0.45, rolling: 0.06, bump: 0.008, smoke: 0, skid: 0, dust: 1, dustColor: [0.95, 0.96, 1.0] },
];
