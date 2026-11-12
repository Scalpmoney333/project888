// Pooled visual effects: tire smoke / dust particles, skid marks and exhaust backfire.
// Nothing is allocated per frame; all buffers are fixed-size ring buffers.

import * as THREE from 'three';
import { smokeSprite } from '../world/textures.js';

const SMOKE_COUNTS = { off: 0, low: 90, medium: 220, high: 420 };

export class SmokeSystem {
  constructor(scene, quality) {
    this.scene = scene;
    this.setQuality(quality);
  }

  setQuality(quality) {
    this.dispose();
    const n = SMOKE_COUNTS[quality] ?? 220;
    this.count = n;
    if (!n) return;
    this.next = 0;
    this.px = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.age = new Float32Array(n).fill(1e9);
    this.life = new Float32Array(n).fill(1);
    this.size0 = new Float32Array(n);
    this.grow = new Float32Array(n);
    this.alpha0 = new Float32Array(n);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.color = new Float32Array(n * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.px, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMap: { value: smokeSprite() }, uScale: { value: 400 } }]),
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
        uniform float uScale; varying float vAlpha; varying vec3 vColor;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = aSize * uScale / max(0.1, -mvPosition.z);
          vAlpha = aAlpha; vColor = aColor;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D uMap; varying float vAlpha; varying vec3 vColor;
        #include <fog_pars_fragment>
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(vColor, t.a * vAlpha);
          if (gl_FragColor.a < 0.01) discard;
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.scene.add(this.points);
  }

  /** Spawn one particle. */
  emit(x, y, z, vx, vy, vz, size, alpha, life, r = 0.9, gr = 0.9, b = 0.9, grow = 2.2) {
    if (!this.count) return;
    const i = this.next;
    this.next = (i + 1) % this.count;
    this.px[i * 3] = x; this.px[i * 3 + 1] = y; this.px[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size0[i] = size;
    this.grow[i] = grow;
    this.alpha0[i] = alpha;
    this.color[i * 3] = r; this.color[i * 3 + 1] = gr; this.color[i * 3 + 2] = b;
  }

  update(dt, camera, renderer) {
    if (!this.count) return;
    const drag = Math.exp(-1.6 * dt);
    for (let i = 0; i < this.count; i++) {
      const a = (this.age[i] += dt);
      const life = this.life[i];
      if (a >= life) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      const t = a / life;
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag + 0.5 * dt;
      this.vel[i * 3 + 2] *= drag;
      this.px[i * 3] += this.vel[i * 3] * dt;
      this.px[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.px[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.size0[i] * (1 + this.grow[i] * Math.sqrt(t));
      this.alpha[i] = this.alpha0[i] * Math.min(1, t * 8) * (1 - t) * (1 - t);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    const h = renderer.getDrawingBufferSize(_size).y;
    this.material.uniforms.uScale.value = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
  }

  clear() {
    if (this.age) this.age.fill(1e9);
  }

  dispose() {
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.material.dispose();
      this.points = null;
    }
  }
}
const _size = new THREE.Vector2();

const SKID_SEGMENTS = { low: 500, medium: 1100, high: 2000 };

export class SkidMarks {
  constructor(scene, quality) {
    this.scene = scene;
    this.setQuality(quality);
  }

  setQuality(quality) {
    this.dispose();
    const n = SKID_SEGMENTS[quality] ?? 1100;
    this.max = n;
    this.next = 0;
    this.pos = new Float32Array(n * 4 * 3);
    this.alpha = new Float32Array(n * 4);
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const v = i * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: `attribute float aAlpha; varying float vA;
        #include <fog_pars_vertex>
        void main(){ vec4 mvPosition = modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mvPosition; vA=aAlpha;
        #include <fog_vertex>
        }`,
      fragmentShader: `varying float vA;
        #include <fog_pars_fragment>
        void main(){ gl_FragColor=vec4(0.05,0.05,0.05,vA*0.75);
        #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: true,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.scene.add(this.mesh);
    this.last = [null, null, null, null].map(() => ({ active: false, l: new THREE.Vector3(), r: new THREE.Vector3(), a: 0 }));
    this.dirty = false;
  }

  /** Add a mark under a wheel. intensity 0 ends the current strip. */
  add(wheelIndex, point, normal, side, width, intensity) {
    if (!this.mesh) return;
    const st = this.last[wheelIndex];
    if (intensity < 0.05) { st.active = false; return; }
    const lx = point.x + side.x * width * 0.5 + normal.x * 0.02;
    const ly = point.y + side.y * width * 0.5 + normal.y * 0.02;
    const lz = point.z + side.z * width * 0.5 + normal.z * 0.02;
    const rx = point.x - side.x * width * 0.5 + normal.x * 0.02;
    const ry = point.y - side.y * width * 0.5 + normal.y * 0.02;
    const rz = point.z - side.z * width * 0.5 + normal.z * 0.02;
    if (!st.active) {
      st.active = true;
      st.l.set(lx, ly, lz);
      st.r.set(rx, ry, rz);
      st.a = intensity;
      return;
    }
    const dx = lx - st.l.x, dz = lz - st.l.z;
    if (dx * dx + dz * dz < 0.09) return;
    if (dx * dx + dz * dz > 9) { st.l.set(lx, ly, lz); st.r.set(rx, ry, rz); return; } // teleport/reset
    const i = this.next;
    this.next = (i + 1) % this.max;
    const p = this.pos, o = i * 12;
    p[o] = st.l.x; p[o + 1] = st.l.y; p[o + 2] = st.l.z;
    p[o + 3] = st.r.x; p[o + 4] = st.r.y; p[o + 5] = st.r.z;
    p[o + 6] = lx; p[o + 7] = ly; p[o + 8] = lz;
    p[o + 9] = rx; p[o + 10] = ry; p[o + 11] = rz;
    const a = i * 4;
    this.alpha[a] = this.alpha[a + 1] = st.a;
    this.alpha[a + 2] = this.alpha[a + 3] = intensity;
    st.l.set(lx, ly, lz);
    st.r.set(rx, ry, rz);
    st.a = intensity;
    this.dirty = true;
  }

  update() {
    if (!this.mesh || !this.dirty) return;
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
    this.dirty = false;
  }

  clear() {
    if (!this.mesh) return;
    this.alpha.fill(0);
    this.last.forEach((s) => (s.active = false));
    this.dirty = true;
  }

  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.material.dispose();
      this.mesh = null;
    }
  }
}

/** Backfire flame sprites at the exhaust tips. */
export class ExhaustFlames {
  constructor(parent, tips) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,220,1)');
    g.addColorStop(0.3, 'rgba(255,170,40,0.9)');
    g.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this.material = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.sprites = tips.map((t) => {
      const s = new THREE.Sprite(this.material);
      s.position.copy(t).add(new THREE.Vector3(0, 0, -0.12));
      s.scale.setScalar(0.35);
      s.visible = false;
      parent.add(s);
      return s;
    });
    this.timer = 0;
  }

  pop() {
    this.timer = 0.06 + Math.random() * 0.05;
  }

  update(dt) {
    this.timer -= dt;
    const on = this.timer > 0;
    for (const s of this.sprites) {
      s.visible = on;
      if (on) s.scale.setScalar(0.25 + Math.random() * 0.25);
    }
  }
}
