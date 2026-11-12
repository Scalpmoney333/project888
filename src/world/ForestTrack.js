// "Forest Loop Raceway". The uploaded race_track__forest_loop_raceway.glb contains no track
// geometry (only a Sketchfab placeholder image plane), so this circuit is generated in the
// style of its preview: misty forest, wet tarmac with a double yellow line, red/white kerbs,
// yellow-black chevron walls on the hairpins, stone retaining walls and armco.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as T from './textures.js';

const ROAD_W = 11;
const KERB_W = 1.2;
const VERGE_W = 7;
const STEP = 2;

const CONTROL = [
  [0, 0], [120, -4], [215, -18], [285, 18], [312, 95], [276, 158], [205, 172], [158, 222],
  [176, 292], [128, 345], [36, 336], [-36, 286], [-58, 205], [-118, 152], [-172, 84], [-150, 14], [-78, -6],
];

function elevation(s, L) {
  const a = (s / L) * Math.PI * 2;
  return 11 * Math.sin(a * 2 + 0.4) + 5 * Math.sin(a * 3 + 1.3) + 3 * Math.sin(a * 5);
}

function hills(x, z) {
  const r = Math.hypot(x - 70, z - 160);
  return 7 * Math.sin(x / 85) + 6 * Math.cos(z / 66) + 4 * Math.sin((x + z) / 41) + Math.max(0, r - 380) * 0.35;
}

function ribbon(samples, offsets, heights, vScale, uRange = [0, 1]) {
  // offsets: lateral positions across; heights: relative y for each column
  const cols = offsets.length;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    for (let c = 0; c < cols; c++) {
      pos.push(s.p.x + s.left.x * offsets[c], s.p.y + heights[c], s.p.z + s.left.z * offsets[c]);
      uv.push(uRange[0] + (uRange[1] - uRange[0]) * (c / (cols - 1)), s.s / vScale);
    }
  }
  const n = samples.length;
  for (let i = 0; i < n - 1; i++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = i * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function withSurface(g, id) {
  g.setAttribute('surface', new THREE.BufferAttribute(new Uint8Array(g.attributes.position.count).fill(id), 1));
  return g;
}

/** Split a sample list into contiguous runs where pred(i) holds. */
function runs(samples, pred, minLen = 6) {
  const out = [];
  let cur = null;
  for (let i = 0; i < samples.length; i++) {
    if (pred(samples[i], i)) { (cur ||= []).push(samples[i]); }
    else if (cur) { if (cur.length >= minLen) out.push(cur); cur = null; }
  }
  if (cur && cur.length >= minLen) out.push(cur);
  return out;
}

export async function buildForestTrack({ renderer, quality }) {
  const group = new THREE.Group();
  const curve = new THREE.CatmullRomCurve3(CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal', 0.5);
  const L = curve.getLength();
  const n = Math.round(L / STEP);
  const samples = [];
  for (let i = 0; i <= n; i++) {
    const u = (i % n) / n;
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    t.y = 0;
    t.normalize();
    p.y = elevation(u * L, L) + 20;
    samples.push({ p, t, left: new THREE.Vector3(t.z, 0, -t.x), s: i * STEP, i });
  }
  // signed curvature (+ = turning left, i.e. toward +left)
  for (let i = 0; i < samples.length; i++) {
    const a = samples[(i - 2 + n) % n].t, b = samples[(i + 2) % n].t;
    samples[i].k = (a.z * b.x - a.x * b.z) / (4 * STEP);
  }
  // smooth curvature for barrier placement
  const ks = samples.map((s, i) => {
    let acc = 0;
    for (let j = -6; j <= 6; j++) acc += samples[(i + j + n) % n].k;
    return acc / 13;
  });
  samples.forEach((s, i) => (s.ks = ks[i]));

  const tex = {
    asphalt: T.asphaltTexture(renderer),
    kerb: T.kerbTexture(renderer),
    grass: T.grassTexture(renderer),
    stone: T.stoneTexture(renderer),
    chevron: T.chevronTexture(renderer),
    metal: T.metalTexture(renderer),
  };
  const mat = {
    road: new THREE.MeshStandardMaterial({ map: tex.asphalt, roughness: 0.55, metalness: 0.0 }),
    kerb: new THREE.MeshLambertMaterial({ map: tex.kerb }),
    grass: new THREE.MeshLambertMaterial({ map: tex.grass }),
    stone: new THREE.MeshLambertMaterial({ map: tex.stone }),
    chevron: new THREE.MeshLambertMaterial({ map: tex.chevron, side: THREE.DoubleSide }),
    metal: new THREE.MeshStandardMaterial({ map: tex.metal, metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide }),
    post: new THREE.MeshLambertMaterial({ color: 0x555a5e }),
  };
  if (quality === 'low') mat.road = new THREE.MeshLambertMaterial({ map: tex.asphalt });

  const collision = [];
  const add = (geom, material, surfaceId, collide = true) => {
    const m = new THREE.Mesh(geom, material);
    m.receiveShadow = true;
    group.add(m);
    if (collide) collision.push(withSurface(geom.clone(), surfaceId));
    return m;
  };

  const h = ROAD_W / 2;
  // road
  add(ribbon(samples, [h, h / 2, 0, -h / 2, -h], [0, 0.02, 0.03, 0.02, 0], 12), mat.road, 0);
  // kerbs where curvature is high (both sides), otherwise grass verge right at the edge
  const kerbRuns = runs(samples, (s) => Math.abs(s.ks) > 1 / 110, 4);
  for (const run of kerbRuns) {
    add(ribbon(run, [h + KERB_W, h], [0.02, 0.05], 4), mat.kerb, 3);
    add(ribbon(run, [-h, -h - KERB_W], [0.05, 0.02], 4), mat.kerb, 3);
  }
  // verges slope down to terrain
  add(ribbon(samples, [h + KERB_W + VERGE_W, h + KERB_W * 0.5, h], [-0.45, -0.02, -0.03], 8), mat.grass, 1);
  add(ribbon(samples, [-h, -h - KERB_W * 0.5, -h - KERB_W - VERGE_W], [-0.03, -0.02, -0.45], 8), mat.grass, 1);

  // ---- terrain: hills blended into the track corridor ----
  const cell = 30;
  const hash = new Map();
  for (const s of samples) {
    const key = `${Math.floor(s.p.x / cell)},${Math.floor(s.p.z / cell)}`;
    (hash.get(key) || hash.set(key, []).get(key)).push(s);
  }
  const nearest = (x, z) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    let best = null, bd = Infinity;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const list = hash.get(`${cx + i},${cz + j}`);
      if (!list) continue;
      for (const s of list) {
        const d = (s.p.x - x) ** 2 + (s.p.z - z) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
    }
    return [best, Math.sqrt(bd)];
  };
  const size = 1600, res = quality === 'low' ? 100 : 160;
  const terrain = new THREE.PlaneGeometry(size, size, res, res);
  terrain.rotateX(-Math.PI / 2);
  terrain.translate(70, 0, 160);
  const tp = terrain.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const x = tp.getX(i), z = tp.getZ(i);
    const [s, d] = nearest(x, z);
    const hy = hills(x, z) + 20;
    let y = hy;
    if (s) {
      const w = THREE.MathUtils.smoothstep(d, h + KERB_W + VERGE_W - 1, 70);
      y = THREE.MathUtils.lerp(s.p.y - 0.6, hy, w);
    }
    tp.setY(i, y);
  }
  terrain.computeVertexNormals();
  const tuv = terrain.attributes.uv;
  for (let i = 0; i < tuv.count; i++) tuv.setXY(i, tuv.getX(i) * 120, tuv.getY(i) * 120);
  add(terrain, mat.grass, 1);

  // ---- barriers ----
  const wall = (run, offset, height, material, uScale, collide = true) => {
    const pos = [], uv = [], idx = [];
    run.forEach((s, i) => {
      const x = s.p.x + s.left.x * offset, z = s.p.z + s.left.z * offset;
      pos.push(x, s.p.y - 0.6, z, x, s.p.y + height, z);
      uv.push(s.s / uScale, 0, s.s / uScale, 1);
      if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material.side === THREE.DoubleSide ? material : Object.assign(material.clone(), { side: THREE.DoubleSide }));
    m.castShadow = quality === 'high';
    m.receiveShadow = true;
    group.add(m);
    if (collide) collision.push(withSurface(g.clone(), 2));
  };
  const edge = h + KERB_W + 2.2;
  // chevron walls on the outside of tight corners; outside = opposite to turn direction
  for (const run of runs(samples, (s) => Math.abs(s.ks) > 1 / 70, 6)) {
    const outside = run[Math.floor(run.length / 2)].ks > 0 ? -1 : 1;
    wall(run, outside * edge, 1.1, mat.chevron, 2.0);
  }
  // armco along medium corners
  for (const run of runs(samples, (s) => Math.abs(s.ks) > 1 / 160 && Math.abs(s.ks) <= 1 / 70, 8)) {
    const outside = run[Math.floor(run.length / 2)].ks > 0 ? -1 : 1;
    const ext = run;
    wall(ext, outside * (edge + 0.6), 0.85, mat.metal, 4);
  }
  // stone retaining walls where the terrain rises beside the road
  const stoneRuns = runs(samples, (s) => hills(s.p.x + s.left.x * 40, s.p.z + s.left.z * 40) + 20 > s.p.y + 6, 15);
  for (const run of stoneRuns) wall(run, h + KERB_W + VERGE_W * 0.55, 3.2, mat.stone, 6);

  // ---- start / finish ----
  const s0 = samples[2];
  const lineGeo = new THREE.PlaneGeometry(ROAD_W, 1.6);
  lineGeo.rotateX(-Math.PI / 2);
  const line = new THREE.Mesh(lineGeo, new THREE.MeshLambertMaterial({ map: T.startLineTexture(renderer), polygonOffset: true, polygonOffsetFactor: -2 }));
  line.position.copy(s0.p).add(new THREE.Vector3(0, 0.04, 0));
  line.rotation.y = Math.atan2(s0.t.x, s0.t.z);
  group.add(line);
  const gantry = new THREE.Group();
  const postGeo = new THREE.BoxGeometry(0.5, 7, 0.5);
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(postGeo, mat.post);
    p.position.set(sx * (h + 1.8), 3.5, 0);
    p.castShadow = true;
    gantry.add(p);
  }
  const banner = new THREE.Mesh(new THREE.BoxGeometry(ROAD_W + 4, 1.4, 0.3), [mat.post, mat.post, mat.post, mat.post,
    new THREE.MeshBasicMaterial({ map: T.bannerTexture(renderer, 'FOREST LOOP RACEWAY') }), new THREE.MeshBasicMaterial({ map: T.bannerTexture(renderer, 'FOREST LOOP RACEWAY') })]);
  banner.position.set(0, 6.6, 0);
  gantry.add(banner);
  gantry.position.copy(s0.p);
  gantry.rotation.y = Math.atan2(s0.t.x, s0.t.z);
  group.add(gantry);

  // ---- forest (instanced) ----
  const rand = (() => { let s = 1234567; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
  const treeCount = quality === 'low' ? 900 : quality === 'medium' ? 1800 : 2800;
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 4, 6);
  trunkGeo.translate(0, 2, 0);
  const crownGeo = new THREE.ConeGeometry(2.6, 9, 7);
  crownGeo.translate(0, 8, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x4a3524 }), treeCount);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ color: 0x2b4a24 }), treeCount);
  const cylinders = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3();
  const color = new THREE.Color();
  let placed = 0;
  for (let tries = 0; placed < treeCount && tries < treeCount * 8; tries++) {
    const base = samples[Math.floor(rand() * n)];
    const side = rand() < 0.5 ? -1 : 1;
    const off = edge + 4 + rand() * rand() * 150;
    const x = base.p.x + base.left.x * side * off + (rand() - 0.5) * 8;
    const z = base.p.z + base.left.z * side * off + (rand() - 0.5) * 8;
    const [s, d] = nearest(x, z);
    if (!s || d < edge + 3.5) continue;
    const hy = hills(x, z) + 20;
    const w = THREE.MathUtils.smoothstep(d, h + KERB_W + VERGE_W - 1, 70);
    const y = THREE.MathUtils.lerp(s.p.y - 0.6, hy, w);
    const k = 0.75 + rand() * 0.7;
    q.setFromAxisAngle(pv.set(0, 1, 0), rand() * 6.28);
    m4.compose(pv.set(x, y - 0.2, z), q, sc.set(k, k * (0.85 + rand() * 0.4), k));
    trunks.setMatrixAt(placed, m4);
    crowns.setMatrixAt(placed, m4);
    color.setHSL(0.27 + rand() * 0.08, 0.45, 0.18 + rand() * 0.1);
    crowns.setColorAt(placed, color);
    if (d < 60) cylinders.push([x, z, 0.4 * k, y - 1, y + 6]);
    placed++;
  }
  trunks.count = crowns.count = placed;
  crowns.castShadow = trunks.castShadow = false;
  group.add(trunks, crowns);

  // marker posts with chevron boards before hairpins
  const boardGeo = new THREE.PlaneGeometry(1.2, 0.8);
  const boardMat = new THREE.MeshLambertMaterial({ color: 0xe0a020, side: THREE.DoubleSide });
  for (const run of runs(samples, (s) => Math.abs(s.ks) > 1 / 70, 6)) {
    const sIn = run[0];
    const outside = run[Math.floor(run.length / 2)].ks > 0 ? -1 : 1;
    for (let j = 0; j < 3; j++) {
      const s = run[Math.min(run.length - 1, j * 4)];
      const b = new THREE.Mesh(boardGeo, boardMat);
      b.position.copy(s.p).addScaledVector(s.left, outside * (edge + 0.4)).add(new THREE.Vector3(0, 1.6, 0));
      b.rotation.y = Math.atan2(s.t.x, s.t.z);
      group.add(b);
    }
    void sIn;
  }

  const spawnS = samples[8];
  return {
    id: 'forest',
    group,
    collision: [mergeGeometries(collision.map((g) => {
      const c = g.index ? g : g;
      for (const k of Object.keys(c.attributes)) if (k !== 'position' && k !== 'surface') c.deleteAttribute(k);
      return c;
    }), false)],
    cylinders,
    spawn: { position: spawnS.p.clone(), yaw: Math.atan2(spawnS.t.x, spawnS.t.z) },
    sky: { top: 0x8ea3a8, bottom: 0xd8dfdc, fog: 0xbfc9c4, fogDensity: 0.0042 },
    sun: new THREE.Vector3(0.4, 0.75, -0.3).normalize(),
    lightIntensity: { hemi: 1.5, sun: 1.3 },
    far: 1600,
    length: L,
    dispose() {
      group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      Object.values(tex).forEach((t) => t.dispose());
    },
  };
}
