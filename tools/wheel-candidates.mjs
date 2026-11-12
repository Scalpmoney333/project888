// Dev tool: list mesh nodes with world-space bounds, flagging wheel-like (round) parts.
// Usage: node tools/wheel-candidates.mjs <file.glb> [all]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { Matrix4, Vector3 } from 'three';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const rows = [];
const all = [[1e9, 1e9, 1e9], [-1e9, -1e9, -1e9]];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = new Matrix4().fromArray(node.getWorldMatrix());
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  let v = 0;
  for (const p of mesh.listPrimitives()) {
    const a = p.getAttribute('POSITION');
    v += a.getCount();
    const lo = a.getMin([]), hi = a.getMax([]);
    for (let i = 0; i < 8; i++) {
      const c = new Vector3(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]).applyMatrix4(m).toArray();

      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c[k]); mx[k] = Math.max(mx[k], c[k]); }
    }
  }
  for (let k = 0; k < 3; k++) { all[0][k] = Math.min(all[0][k], mn[k]); all[1][k] = Math.max(all[1][k], mx[k]); }
  rows.push({ name: node.getName(), mats: mesh.listPrimitives().map((p) => p.getMaterial()?.getName()).join('|'), v, mn, mx });
}
console.log('scene bounds', all.map((a) => a.map((x) => +x.toPrecision(4)).join(',')).join(' / '));
const f = (a) => a.map((x) => +x.toPrecision(3)).join(',');
for (const r of rows) {
  const s = r.mx.map((x, i) => x - r.mn[i]);
  const sorted = [...s].sort((a, b) => b - a);
  const round = sorted[1] / sorted[0] > 0.85 && sorted[2] < sorted[0] * 0.75;
  if (round || process.argv[3] === 'all') console.log(`${round ? 'ROUND' : '     '} ${r.name.slice(0, 60)} v=${r.v} mats=${r.mats.slice(0, 50)} c=${f(r.mn.map((x, i) => (x + r.mx[i]) / 2))} size=${f(s)}`);
}
