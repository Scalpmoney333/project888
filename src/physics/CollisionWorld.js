// Static collision world backed by three-mesh-bvh. Map geometry is baked to world space and
// merged; each vertex carries a surface id so tire grip can follow the ground under each wheel.
// Tree trunks and posts are vertical cylinders checked separately through a spatial hash.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { SURFACES } from './surfaces.js';

const _ray = new THREE.Ray();
const _target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const _n = new THREE.Vector3();
const CELL = 8;

export class CollisionWorld {
  constructor() {
    this.parts = [];
    this.cylinders = new Map();
    this.minY = Infinity;
    this.defaultSurface = SURFACES[0];
  }

  /**
   * @param {THREE.BufferGeometry} geometry world-space, indexed; optional 'surface' attribute
   * @param {number} defaultSurface id used when there is no surface attribute
   */
  addGeometry(geometry, defaultSurface = 0) {
    if (!geometry.index) {
      const n = geometry.attributes.position.count;
      const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    const bvh = new MeshBVH(geometry, { targetLeafSize: 8 });
    geometry.computeBoundingBox();
    this.minY = Math.min(this.minY, geometry.boundingBox.min.y);
    this.parts.push({ geometry, bvh, surface: geometry.attributes.surface || null, defaultSurface });
  }

  addCylinder(x, z, radius, y0, y1) {
    const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    let list = this.cylinders.get(key);
    if (!list) this.cylinders.set(key, (list = []));
    list.push({ x, z, radius, y0, y1 });
  }

  surfaceOf(part, faceIndex) {
    if (!part.surface) return SURFACES[part.defaultSurface];
    const v = part.geometry.index.getX(faceIndex * 3);
    return SURFACES[part.surface.getX(v)] || this.defaultSurface;
  }

  /** Nearest hit along a ray (both triangle sides). */
  raycast(origin, dir, far, out) {
    _ray.origin.copy(origin);
    _ray.direction.copy(dir);
    let best = null;
    let bestPart = null;
    for (const part of this.parts) {
      const hit = part.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, far);
      if (hit && (!best || hit.distance < best.distance)) {
        best = hit;
        bestPart = part;
      }
    }
    if (!best) return false;
    out.distance = best.distance;
    out.normal.copy(best.face.normal);
    out.surface = this.surfaceOf(bestPart, best.faceIndex);
    out.point = best.point;
    return true;
  }

  /** Deepest penetration of a sphere into world geometry. */
  sphereContact(center, radius, out) {
    let found = false;
    let depth = 0;
    for (const part of this.parts) {
      const res = part.bvh.closestPointToPoint(center, _target, 0, radius);
      if (!res || res.distance >= radius) continue;
      const d = radius - res.distance;
      if (d <= depth) continue;
      depth = d;
      found = true;
      out.point.copy(res.point);
      if (res.distance > 1e-5) {
        out.normal.subVectors(center, res.point).multiplyScalar(1 / res.distance);
      } else {
        const g = part.geometry;
        const idx = g.index;
        const p = g.attributes.position;
        const a = new THREE.Vector3().fromBufferAttribute(p, idx.getX(res.faceIndex * 3));
        const b = new THREE.Vector3().fromBufferAttribute(p, idx.getX(res.faceIndex * 3 + 1));
        const c = new THREE.Vector3().fromBufferAttribute(p, idx.getX(res.faceIndex * 3 + 2));
        out.normal.copy(_n.subVectors(c, b).cross(a.sub(b)).normalize());
      }
    }
    // Cylinders (trees, posts)
    const cx = Math.floor(center.x / CELL), cz = Math.floor(center.z / CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.cylinders.get(`${cx + i},${cz + j}`);
        if (!list) continue;
        for (const c of list) {
          if (center.y < c.y0 - radius || center.y > c.y1 + radius) continue;
          const dx = center.x - c.x, dz = center.z - c.z;
          const dist = Math.hypot(dx, dz);
          const d = radius + c.radius - dist;
          if (d > depth && dist > 1e-4) {
            depth = d;
            found = true;
            out.normal.set(dx / dist, 0, dz / dist);
            out.point.set(c.x + out.normal.x * c.radius, center.y, c.z + out.normal.z * c.radius);
          }
        }
      }
    }
    out.depth = depth;
    return found;
  }
}
