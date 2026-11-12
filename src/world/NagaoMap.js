// Nagao touge (from the uploaded "Nagao map mod 0.4.9"). The Unity mesh is converted offline by
// tools/convert_nagao.py into tiled, meshopt-compressed glTF; this loader adds the atlas
// texture, a merged collision mesh, and per-vertex grip from the atlas surface lookup.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const BASE = 'assets/maps/nagao/';

export async function loadNagao({ renderer, quality, onProgress }) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const texUrl = BASE + (quality === 'high' ? 'nagao_atlas_4k.jpg' : 'nagao_atlas_2k.jpg');
  const [gltf, texture, surfaceLut] = await Promise.all([
    loader.loadAsync(BASE + 'nagao.glb', (e) => onProgress?.(e.total ? e.loaded / e.total : 0)),
    new THREE.TextureLoader().loadAsync(BASE + texUrl.slice(BASE.length)),
    fetch(BASE + 'nagao_surface.json').then((r) => r.json()),
  ]);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false; // glTF UV convention
  texture.anisotropy = Math.min(quality === 'low' ? 2 : 8, renderer.capabilities.getMaxAnisotropy());
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;

  const material = new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide });
  const group = gltf.scene;
  group.updateMatrixWorld(true);

  // ---- collision: merge all tiles into one world-space geometry with surface ids ----
  const meshes = [];
  group.traverse((o) => { if (o.isMesh) meshes.push(o); });
  let vCount = 0, iCount = 0;
  for (const m of meshes) { vCount += m.geometry.attributes.position.count; iCount += m.geometry.index.count; }
  const positions = new Float32Array(vCount * 3);
  const surface = new Uint8Array(vCount);
  const index = new Uint32Array(iCount);
  const [GW, GH] = surfaceLut.grid;
  const lut = surfaceLut.surface;
  const v = new THREE.Vector3();
  let vo = 0, io = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const p = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      positions[(vo + i) * 3] = v.x;
      positions[(vo + i) * 3 + 1] = v.y;
      positions[(vo + i) * 3 + 2] = v.z;
      const u = Math.min(GW - 1, Math.max(0, Math.floor(uv.getX(i) * GW)));
      const w = Math.min(GH - 1, Math.max(0, Math.floor(uv.getY(i) * GH)));
      surface[vo + i] = lut.charCodeAt(w * GW + u) - 48;
    }
    const idx = g.index;
    for (let i = 0; i < idx.count; i++) index[io + i] = idx.getX(i) + vo;
    vo += p.count;
    io += idx.count;
    m.material = material;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
  }
  const collision = new THREE.BufferGeometry();
  collision.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  collision.setAttribute('surface', new THREE.BufferAttribute(surface, 1));
  collision.setIndex(new THREE.BufferAttribute(index, 1));

  return {
    id: 'nagao',
    group,
    collision: [collision],
    cylinders: [],
    spawn: { position: new THREE.Vector3(166.7, 0, 341.7), yaw: 0.365 },
    sky: { top: 0x6f9fd8, bottom: 0xcfdbe6, fog: 0xc4d2df, fogDensity: 0.0011 },
    sun: new THREE.Vector3(-0.5, 0.8, 0.35).normalize(),
    lightIntensity: { hemi: 1.6, sun: 1.6 },
    far: 9000,
    dispose() {
      texture.dispose();
      material.dispose();
      meshes.forEach((m) => m.geometry.dispose());
    },
  };
}
