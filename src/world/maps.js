// Maps converted from the uploaded Unity map mods (tools/convert_unity_map.py). Each map is a
// tiled, meshopt-compressed glTF plus an atlas texture and a JSON file with spawn points.
// Tiles named "col_*" are collidable; every vertex carries a grip class in "_surface".

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { assetUrl } from '../core/assets.js';

export const MAPS = [
  {
    id: 'nagao',
    name: 'Nagao Touge',
    subtitle: '6.4 km mountain pass • Uphill / Downhill',
    spawns: [{ id: 'downhill', name: 'Downhill' }, { id: 'uphill', name: 'Uphill' }],
    sky: { top: 0x6f9fd8, bottom: 0xcfdbe6, fog: 0xc4d2df, fogDensity: 0.0011 },
    sun: [-0.5, 0.8, 0.35],
    light: { hemi: 1.6, sun: 1.6 },
    far: 9000,
  },
  {
    id: 'tsukuba',
    name: 'Tsukuba Winter',
    subtitle: '8.5 km snowy touge • low grip',
    spawns: [{ id: 'a', name: 'Start A' }, { id: 'b', name: 'Start B' }],
    sky: { top: 0x9fb2c6, bottom: 0xe4eaf0, fog: 0xd9e1e8, fogDensity: 0.0016 },
    sun: [0.3, 0.7, -0.4],
    light: { hemi: 1.7, sun: 1.1 },
    far: 7000,
  },
  {
    id: 'ashinoko',
    name: 'Ashinoko',
    subtitle: '6 km forest skyline road',
    spawns: [{ id: 'a', name: 'Start A' }, { id: 'b', name: 'Start B' }],
    sky: { top: 0x7fa8d8, bottom: 0xd2dde6, fog: 0xc8d4dc, fogDensity: 0.0012 },
    sun: [-0.4, 0.75, 0.5],
    light: { hemi: 1.6, sun: 1.5 },
    far: 6000,
  },
  {
    id: 'oi',
    name: 'Oi Wharf',
    subtitle: 'Harbour roads and container yard',
    spawns: [{ id: 'a', name: 'Start A' }, { id: 'b', name: 'Start B' }],
    sky: { top: 0x6e93c2, bottom: 0xd5dce4, fog: 0xc9d2db, fogDensity: 0.0014 },
    sun: [0.45, 0.75, 0.3],
    light: { hemi: 1.6, sun: 1.6 },
    far: 3000,
  },
];

export async function loadMap(def, { renderer, quality, onProgress }) {
  const base = `assets/maps/${def.id}`;
  const meta = await fetch(assetUrl(`${base}.json`)).then((r) => r.json());
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const [gltf, texture] = await Promise.all([
    loader.loadAsync(assetUrl(`${base}.glb`), (e) => onProgress?.(e.total ? e.loaded / e.total : 0)),
    new THREE.TextureLoader().loadAsync(assetUrl(`assets/maps/${meta.texture}`)),
  ]);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false; // glTF UV convention
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = Math.min(quality === 'low' ? 2 : 8, renderer.capabilities.getMaxAnisotropy());

  const ground = new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide });
  // Foliage: atlases with alpha use it directly; opaque atlases draw trees on black, so the
  // texture itself doubles as an alpha map (alphaMap reads the green channel).
  const foliage = meta.alpha
    ? new THREE.MeshLambertMaterial({ map: texture, side: THREE.DoubleSide, alphaTest: 0.5 })
    : new THREE.MeshLambertMaterial({ map: texture, alphaMap: texture, side: THREE.DoubleSide, alphaTest: 0.12 });
  if (meta.alpha) ground.alphaTest = 0.5;

  const group = gltf.scene;
  group.updateMatrixWorld(true);
  const meshes = [];
  const colliders = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    meshes.push(o);
    o.material = o.material.name === 'foliage' ? foliage : ground;
    o.receiveShadow = true;
    o.matrixAutoUpdate = false;
    if (o.name.startsWith('col_') || o.parent?.name.startsWith('col_')) colliders.push(o);
  });

  // Collision: merge collidable tiles into one world-space geometry with surface ids.
  let vCount = 0, iCount = 0;
  for (const m of colliders) { vCount += m.geometry.attributes.position.count; iCount += m.geometry.index.count; }
  const positions = new Float32Array(vCount * 3);
  const surface = new Uint8Array(vCount);
  const index = new Uint32Array(iCount);
  const v = new THREE.Vector3();
  let vo = 0, io = 0;
  for (const m of colliders) {
    const g = m.geometry;
    const p = g.attributes.position;
    const s = g.attributes._surface;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      positions[(vo + i) * 3] = v.x;
      positions[(vo + i) * 3 + 1] = v.y;
      positions[(vo + i) * 3 + 2] = v.z;
      surface[vo + i] = s ? Math.round(s.getX(i)) : 0;
    }
    const idx = g.index;
    for (let i = 0; i < idx.count; i++) index[io + i] = idx.getX(i) + vo;
    vo += p.count;
    io += idx.count;
  }
  const collision = new THREE.BufferGeometry();
  collision.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  collision.setAttribute('surface', new THREE.BufferAttribute(surface, 1));
  collision.setIndex(new THREE.BufferAttribute(index, 1));

  return {
    id: def.id,
    group,
    collision: [collision],
    cylinders: [],
    // Display names come from the map definition; positions from the converter output.
    spawns: meta.spawns.map((s) => ({ ...s, name: def.spawns.find((d) => d.id === s.id)?.name ?? s.name, position: new THREE.Vector3(...s.position) })),
    sky: def.sky,
    sun: new THREE.Vector3(...def.sun).normalize(),
    lightIntensity: def.light,
    far: def.far,
    dispose() {
      texture.dispose();
      ground.dispose();
      foliage.dispose();
      meshes.forEach((m) => m.geometry.dispose());
    },
  };
}
