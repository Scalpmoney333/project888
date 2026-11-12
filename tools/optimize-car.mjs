// Prepare a car GLB for mobile: textures resized to at most 1024 px and re-encoded as WebP.
// Materials and node transforms are untouched (the wheel rig is built at runtime).
// Optional "--simplify <ratio>" reduces very dense meshes (e.g. GTA mod cars) with
// meshoptimizer while keeping the silhouette (default error bound 0.05% of the model size).
// "--texsize <px>" lowers the texture cap (GTA cars carry dozens of textures; 512 keeps GPU memory low).
// Usage: node tools/optimize-car.mjs <in.glb> <out.glb> [--simplify <ratio> [maxError]] [--texsize <px>]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, prune, dedup, weld, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
// "--drop <regex>" removes parts that are never visible (e.g. a full engine under a closed bonnet).
const di = process.argv.indexOf('--drop');
if (di > 0) {
  const re = new RegExp(process.argv[di + 1], 'i');
  for (const n of doc.getRoot().listNodes()) if (re.test(n.getName())) n.dispose();
}
const si = process.argv.indexOf('--simplify');
const steps = [dedup(), prune()];
if (si > 0) {
  await MeshoptSimplifier.ready;
  steps.push(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: +process.argv[si + 1], error: +(process.argv[si + 2] || 0.0005), lockBorder: true }));
}
const ti = process.argv.indexOf('--texsize');
const tex = ti > 0 ? +process.argv[ti + 1] : 1024;
steps.push(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [tex, tex], quality: 85 }));
await doc.transform(...steps);
await io.write(process.argv[3], doc);
