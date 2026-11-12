// Prepare a car GLB for mobile: textures resized to at most 1024 px and re-encoded as WebP.
// Materials and node transforms are untouched (the wheel rig is built at runtime).
// Optional "--simplify <ratio>" reduces very dense meshes (e.g. GTA mod cars) with
// meshoptimizer while keeping the silhouette (default error bound 0.05% of the model size).
// Usage: node tools/optimize-car.mjs <in.glb> <out.glb> [--simplify <ratio> [maxError]]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, prune, dedup, weld, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const si = process.argv.indexOf('--simplify');
const steps = [dedup(), prune()];
if (si > 0) {
  await MeshoptSimplifier.ready;
  steps.push(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: +process.argv[si + 1], error: +(process.argv[si + 2] || 0.0005), lockBorder: true }));
}
steps.push(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }));
await doc.transform(...steps);
await io.write(process.argv[3], doc);
