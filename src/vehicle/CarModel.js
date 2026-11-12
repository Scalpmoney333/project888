// Loads an uploaded car GLB and rebuilds it into a drivable rig without modifying the file:
//  - every mesh is baked into one model space (metres, ground at y = 0, +Z forward, +X left,
//    axle midpoint at z = 0), scaled so the measured wheelbase matches the real car;
//  - wheel parts are found (optionally by splitting merged meshes into connected components)
//    and grouped per corner, with the tyre's bounding box giving the true hub centre;
//  - each corner gets   wheelRoot (suspension) -> steer (yaw) -> spin (axle X) -> parts,
//    so steering and rolling never interfere and rotation happens about the real hub.

import * as THREE from 'three';

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

/** Split an indexed geometry into connected components (vertices welded by position). */
function connectedComponents(geometry) {
  const pos = geometry.attributes.position;
  const n = pos.count;
  const index = geometry.index ? geometry.index.array : Uint32Array.from({ length: n }, (_, i) => i);
  const parent = new Int32Array(n);
  const keyMap = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    const e = keyMap.get(k);
    if (e === undefined) { keyMap.set(k, i); parent[i] = i; } else parent[i] = e;
  }
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  for (let t = 0; t < index.length; t += 3) {
    const a = find(index[t]), b = find(index[t + 1]), c = find(index[t + 2]);
    if (b !== a) parent[b] = a;
    const c2 = find(c);
    if (c2 !== a) parent[c2] = a;
  }
  const groups = new Map();
  for (let t = 0; t < index.length; t += 3) {
    const r = find(index[t]);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(t / 3);
  }
  return [...groups.values()];
}

/** New geometry containing only the given triangles (all attributes copied). */
function extractTriangles(geometry, tris) {
  const index = geometry.index ? geometry.index.array : null;
  const remap = new Map();
  const newIndex = [];
  const order = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = index ? index[t * 3 + k] : t * 3 + k;
      let m = remap.get(v);
      if (m === undefined) { m = order.length; remap.set(v, m); order.push(v); }
      newIndex.push(m);
    }
  }
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const size = attr.itemSize;
    const arr = new Float32Array(order.length * size);
    for (let i = 0; i < order.length; i++) for (let c = 0; c < size; c++) arr[i * size + c] = attr.getComponent(order[i], c);
    g.setAttribute(name, new THREE.BufferAttribute(arr, size, attr.normalized));
  }
  g.setIndex(order.length > 65535 ? new THREE.Uint32BufferAttribute(newIndex, 1) : new THREE.Uint16BufferAttribute(newIndex, 1));
  return g;
}

function hasAncestorNamed(obj, names) {
  // GLTFLoader sanitises node names (e.g. "Circle.014_18" -> "Circle014_18").
  const wanted = names.map((n) => THREE.PropertyBinding.sanitizeNodeName(n));
  for (let o = obj; o; o = o.parent) if (names.includes(o.name) || wanted.includes(o.name)) return true;
  return false;
}

/** Make materials cheap and mobile-safe while keeping their look. */
function adaptMaterial(mat, quality) {
  if (mat.transmission > 0) {
    // Transmission needs an extra full-scene render pass; approximate glass with alpha.
    mat.transmission = 0;
    mat.transparent = true;
    mat.opacity = Math.min(mat.opacity, 0.42);
    mat.depthWrite = false;
    mat.roughness = Math.min(mat.roughness, 0.1);
    mat.metalness = 0.2;
  }
  if (quality === 'low' && mat.clearcoat > 0) mat.clearcoat = 0;
  return mat;
}

export class CarModel {
  /**
   * @param {object} gltf  result of GLTFLoader
   * @param {object} def   vehicle definition (specs.js)
   */
  constructor(gltf, def, quality = 'high') {
    this.def = def;
    const cfg = def.model;
    const scene = gltf.scene;
    // Models authored facing another axis are turned so the front points to +Z.
    if (cfg.yaw) scene.rotation.y = (cfg.yaw * Math.PI) / 180;
    scene.updateMatrixWorld(true);
    const wheelRe = cfg.wheelMatch ? new RegExp(cfg.wheelMatch, 'i') : null;
    const isWheel = (o) => {
      if (cfg.wheelNodes) return hasAncestorNamed(o, cfg.wheelNodes);
      for (let p = o; p; p = p.parent) if (wheelRe.test(p.name)) return true;
      return wheelRe.test(o.material?.name || '');
    };
    const round = (box) => {
      const s = box.getSize(new THREE.Vector3());
      const d = Math.max(s.y, s.z);
      return d > 0 && Math.abs(s.y - s.z) / d < 0.2 && s.x < d * 0.8;
    };

    const bodyParts = []; // {geometry, material}
    const wheelComps = []; // {geometry, material, box}
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const geom = o.geometry.clone();
      geom.applyMatrix4(o.matrixWorld);
      if (o.matrixWorld.determinant() < 0) {
        // Mirrored node: flip winding so faces stay front-facing.
        const idx = geom.index;
        if (idx) for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, a); }
      }
      const material = adaptMaterial(o.material, quality);
      if (isWheel(o)) {
        const comps = cfg.splitWheelMeshes ? connectedComponents(geom).map((t) => extractTriangles(geom, t)) : [geom];
        for (const g of comps) {
          g.computeBoundingBox();
          wheelComps.push({ geometry: g, material, box: g.boundingBox.clone() });
        }
      } else {
        bodyParts.push({ geometry: geom, material });
      }
    });

    // Axle split from the large round wheel parts only (tyres, rims), so small badges or
    // body bits caught by the wheel pattern cannot shift the centre.
    for (const c of wheelComps) c.size = c.box.getSize(new THREE.Vector3()).length();
    const roundSizes = wheelComps.filter((c) => round(c.box)).map((c) => c.size);
    const maxRound = Math.max(...roundSizes);
    const wheelBox = new THREE.Box3();
    for (const c of wheelComps) if (round(c.box) && c.size > maxRound * 0.6) wheelBox.union(c.box);
    const cx = (wheelBox.min.x + wheelBox.max.x) / 2;
    const cz = (wheelBox.min.z + wheelBox.max.z) / 2;

    // Per corner: the largest component is the tyre and defines the hub.
    const corners = [
      { front: true, left: true }, { front: true, left: false },
      { front: false, left: true }, { front: false, left: false },
    ];
    for (const c of wheelComps) {
      c.box.getCenter(c.center = new THREE.Vector3());
      c.corner = (c.center.z > cz ? 0 : 2) + (c.center.x > cx ? 0 : 1);
    }
    for (let i = 0; i < 4; i++) {
      // Tyre = largest component that is round in side view (Y ≈ Z) and narrow; stray body
      // bits merged into wheel meshes are not round, so they cannot become the hub.
      const mine = wheelComps.filter((c) => c.corner === i && round(c.box));
      const tyre = mine.reduce((a, b) => (b.size > (a?.size ?? 0) ? b : a), null);
      if (!tyre) throw new Error(`${def.id}: wheel ${i} not found`);
      const s = tyre.box.getSize(new THREE.Vector3());
      corners[i].center = tyre.center.clone();
      corners[i].radius = Math.max(s.y, s.z) / 2;
      corners[i].width = s.x;
      corners[i].parts = [];
    }
    for (const c of wheelComps) {
      const w = corners[c.corner];
      if (c.center.distanceTo(w.center) < w.radius * 1.05) w.parts.push(c);
      else bodyParts.push({ geometry: c.geometry, material: c.material }); // stray body bits
    }

    // Normalise: ground at y=0, axle midpoint at z=0, centre line x=0, real-world scale.
    const zFront = (corners[0].center.z + corners[1].center.z) / 2;
    const zRear = (corners[2].center.z + corners[3].center.z) / 2;
    const ground = Math.min(...corners.map((c) => c.center.y - c.radius));
    const scale = cfg.realWheelbase / (zFront - zRear);
    const offset = new THREE.Vector3(cx, ground, (zFront + zRear) / 2);
    const M = new THREE.Matrix4().makeScale(scale, scale, scale).multiply(new THREE.Matrix4().makeTranslation(-offset.x, -offset.y, -offset.z));
    for (const p of bodyParts) p.geometry.applyMatrix4(M);
    for (const w of corners) {
      w.center.applyMatrix4(M);
      w.radius *= scale;
      w.width *= scale;
      for (const p of w.parts) {
        p.geometry.applyMatrix4(M);
        // centre each part on its hub so rotations happen about the axle
        p.geometry.translate(-w.center.x, -w.center.y, -w.center.z);
      }
    }
    this.scale = scale;
    this.wheelInfo = corners.map((c) => ({ center: c.center.clone(), radius: c.radius, width: c.width }));

    // ---- build scene graph ----
    this.root = new THREE.Group(); // positioned at the physics CG each frame
    this.body = new THREE.Group(); // model space offset from the CG
    this.root.add(this.body);
    this.brakeLightMaterials = [];
    const brakeRe = new RegExp(cfg.brakeLightMaterial || 'rear_light|red|tail', 'i');
    const materialCache = new Map();
    for (const p of bodyParts) {
      let mat = p.material;
      if (brakeRe.test(mat.name || '')) {
        if (!materialCache.has(mat)) {
          const m = mat.clone();
          m.emissive = m.emissive || new THREE.Color();
          m.userData.baseEmissive = m.emissive.clone();
          this.brakeLightMaterials.push(m);
          materialCache.set(mat, m);
        }
        mat = materialCache.get(mat);
      }
      const mesh = new THREE.Mesh(p.geometry, mat);
      mesh.castShadow = true;
      mesh.name = 'body';
      this.body.add(mesh);
    }
    const nonSpin = cfg.nonSpinMaterials || [];
    const nonSpinRe = cfg.nonSpinMatch ? new RegExp(cfg.nonSpinMatch, 'i') : null;
    this.wheels = corners.map((c, i) => {
      const wheelRoot = new THREE.Group();
      const steer = new THREE.Group();
      const spin = new THREE.Group();
      wheelRoot.add(steer);
      steer.add(spin);
      for (const p of c.parts) {
        const mesh = new THREE.Mesh(p.geometry, p.material);
        mesh.castShadow = true;
        const fixed = nonSpin.includes(p.material.name) || (nonSpinRe && nonSpinRe.test(p.material.name || ''));
        (fixed ? steer : spin).add(mesh);
      }
      wheelRoot.name = ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'][i];
      this.root.add(wheelRoot);
      return { root: wheelRoot, steer, spin, info: this.wheelInfo[i] };
    });

    // Measurements used by physics and cameras.
    const box = new THREE.Box3();
    for (const m of this.body.children) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox); }
    this.bodyBox = box;
    const front = this.wheelInfo[0], rear = this.wheelInfo[2];
    this.measured = {
      wheelRadiusFront: (this.wheelInfo[0].radius + this.wheelInfo[1].radius) / 2,
      wheelRadiusRear: (this.wheelInfo[2].radius + this.wheelInfo[3].radius) / 2,
      trackWidth: Math.abs(this.wheelInfo[0].center.x - this.wheelInfo[1].center.x),
      wheelbase: front.center.z - rear.center.z,
      body: { length: box.max.z - box.min.z, width: Math.min(2.0, box.max.x - box.min.x), height: box.max.y },
    };

    // Camera anchors: hood surface (found by raycasting the body) and exhaust tips.
    const ray = new THREE.Raycaster();
    const hoodZ = box.max.z - (box.max.z - front.center.z) * 0.2 - 0.9;
    ray.set(new THREE.Vector3(0, 5, hoodZ), new THREE.Vector3(0, -1, 0));
    const hits = ray.intersectObjects(this.body.children, false);
    this.hoodY = hits.length ? hits[0].point.y : box.max.y * 0.72;
    this.hoodZ = hoodZ;
    this.frontZ = box.max.z;
    this.rearZ = box.min.z;
    this.exhausts = [];
    for (const m of this.body.children) {
      if (cfg.exhaustMaterial && new RegExp(cfg.exhaustMaterial, 'i').test(m.material.name || '')) {
        const b = m.geometry.boundingBox;
        this.exhausts.push(new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z));
      }
    }
    if (!this.exhausts.length) this.exhausts.push(new THREE.Vector3(0.45, 0.3, box.min.z));
  }

  /** Model-space z of the centre of gravity for a spec. */
  cgOffset(spec) {
    const zFront = this.measured.wheelbase / 2;
    return new THREE.Vector3(0, spec.cgHeight, zFront - spec.wheelbase * (1 - spec.frontWeight));
  }

  setPaint(color) {
    for (const m of this.body.children) {
      if (!new RegExp(this.def.model.paintMaterial, 'i').test(m.material.name || '')) continue;
      m.material.userData.origColor ??= m.material.color.clone();
      if (color) m.material.color.set(color);
      else m.material.color.copy(m.material.userData.origColor);
    }
  }

  /** Sync visuals with the simulation (render-interpolated pose). */
  update(vehicle, braking) {
    this.root.position.copy(vehicle.renderPosition);
    this.root.quaternion.copy(vehicle.renderQuaternion);
    const cg = this._cg || (this._cg = new THREE.Vector3());
    cg.copy(this.cgOffset(vehicle.spec));
    this.body.position.set(-cg.x, -cg.y, -cg.z);
    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheels[i];
      const vw = this.wheels[i];
      vw.root.position.set(w.mountTop.x, w.mountTop.y - w.length, w.mountTop.z);
      vw.steer.rotation.y = w.steer;
      vw.spin.rotation.x = w.spinAngle;
    }
    for (const m of this.brakeLightMaterials) {
      if (braking) m.emissive.setRGB(1, 0.05, 0.02);
      else m.emissive.copy(m.userData.baseEmissive);
      m.emissiveIntensity = braking ? 2.5 : 1;
    }
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
  }
}

export function measureBox(obj) {
  return _box.setFromObject(obj).getSize(_v).clone();
}
