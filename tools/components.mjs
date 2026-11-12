// Dev tool: connected-component breakdown of selected meshes (by welded positions).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const want = process.argv.slice(3);
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh || (want.length && !want.includes(mesh.getName()) && !want.includes(node.getName()))) continue;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION').getArray();
    const idx = prim.getIndices().getArray();
    const n = pos.length / 3;
    const key = new Map();
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const k = `${pos[i * 3].toFixed(4)},${pos[i * 3 + 1].toFixed(4)},${pos[i * 3 + 2].toFixed(4)}`;
      parent[i] = key.has(k) ? key.get(k) : (key.set(k, i), i);
    }
    const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
    for (let t = 0; t < idx.length; t += 3) {
      const a = find(idx[t]), b = find(idx[t + 1]), c = find(idx[t + 2]);
      parent[b] = a; parent[find(c)] = a;
    }
    const comps = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      let c = comps.get(r);
      if (!c) comps.set(r, (c = { v: 0, mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }));
      c.v++;
      for (let j = 0; j < 3; j++) { c.mn[j] = Math.min(c.mn[j], pos[i * 3 + j]); c.mx[j] = Math.max(c.mx[j], pos[i * 3 + j]); }
    }
    const list = [...comps.values()].sort((a, b) => b.v - a.v);
    console.log(`${mesh.getName()} comps=${list.length}`);
    for (const c of list.slice(0, +process.env.TOP || 12)) console.log(`  v=${c.v} ${c.mn.map((x) => x.toFixed(2))} / ${c.mx.map((x) => x.toFixed(2))}`);
  }
}
