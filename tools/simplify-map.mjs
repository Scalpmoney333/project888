// Thin out a converted map GLB for phones: weld, then simplify every tile with an error bound
// in metres. Collidable tiles (col_*) get a tight bound and locked borders so the driving
// surface stays exact; scenery gets a looser bound.
// Usage: node tools/simplify-map.mjs <in.glb> <out.raw.glb> [roadError=0.02] [sceneryError=0.12] [--stats]
// Then: node tools/compress-glb.mjs <out.raw.glb> public/assets/maps/<id>.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, weld, simplifyPrimitive, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';

await Promise.all([MeshoptDecoder.ready, MeshoptSimplifier.ready]);
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [input, output] = args;
const roadErr = +(args[2] ?? 0.02);
const sceneryErr = +(args[3] ?? 0.12);
const statsOnly = process.argv.includes('--stats');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(input);
await doc.transform(dequantize(), weld());

const tris = (p) => (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3;
const total = () => {
  const t = { road: 0, scenery: 0, byMat: {} };
  for (const n of doc.getRoot().listNodes()) {
    const m = n.getMesh();
    if (!m) continue;
    const col = /^col_/.test(n.getName()) || /^col_/.test(m.getName());
    for (const p of m.listPrimitives()) {
      const c = tris(p);
      t[col ? 'road' : 'scenery'] += c;
      const k = p.getMaterial()?.getName() || '?';
      t.byMat[k] = (t.byMat[k] || 0) + c;
    }
  }
  return t;
};
const before = total();
console.log('before: collidable', Math.round(before.road), 'scenery', Math.round(before.scenery));
if (statsOnly) {
  const top = Object.entries(before.byMat).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [k, v] of top) console.log(`  ${k}: ${Math.round(v)}`);
  process.exit(0);
}

for (const n of doc.getRoot().listNodes()) {
  const m = n.getMesh();
  if (!m) continue;
  const col = /^col_/.test(n.getName()) || /^col_/.test(m.getName());
  for (const p of m.listPrimitives()) {
    // Alpha-tested foliage is built from crossed cards that the simplifier erases entirely.
    if (p.getMaterial()?.getAlphaMode() === 'MASK') continue;
    const pos = p.getAttribute('POSITION');
    const mn = pos.getMin([]), mx = pos.getMax([]);
    const extent = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-3);
    const before = tris(p);
    const oldIndices = p.getIndices();
    p.setIndices(oldIndices.clone());
    simplifyPrimitive(p, {
      simplifier: MeshoptSimplifier,
      ratio: 0,
      error: (col ? roadErr : sceneryErr) / extent,
      // Lock borders so tile seams and open edges (road sides, walls) keep their shape.
      lockBorder: true,
    });
    // Thin flat pieces (decals, signs) can collapse to nothing: keep those as they were.
    if (tris(p) < before * 0.05) p.setIndices(oldIndices);
  }
}
await doc.transform(prune());
// Written uncompressed; compress-glb.mjs re-applies quantization + meshopt.
for (const e of doc.getRoot().listExtensionsUsed()) {
  if (['EXT_meshopt_compression', 'KHR_mesh_quantization'].includes(e.extensionName)) e.dispose();
}
const after = total();
console.log('after:  collidable', Math.round(after.road), 'scenery', Math.round(after.scenery));
await io.write(output, doc);
