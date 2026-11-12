// Quantize + meshopt-compress a map GLB for mobile delivery.
// Usage: node tools/compress-glb.mjs <in.glb> <out.glb> [--simplify <ratio> <maxError>]
// --simplify reduces dense meshes with meshoptimizer (error is relative to the tile size; add
// --lock-border to keep open edges fixed). Embedded textures (GTA maps) are re-encoded as WebP.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { quantize, reorder, weld, simplify, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(process.argv[2]);
const si = process.argv.indexOf('--simplify');
const steps = [weld()];
if (si > 0) steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: +process.argv[si + 1], error: +process.argv[si + 2], lockBorder: process.argv.includes('--lock-border') }));
steps.push(
  reorder({ encoder: MeshoptEncoder }),
  // Custom attributes (_SURFACE grip ids) must stay exact, so only standard ones are quantized.
  quantize({ quantizePosition: 16, quantizeNormal: 8, quantizeTexcoord: 14, pattern: /^(POSITION|NORMAL|TEXCOORD_0)$/ }),
);
if (doc.getRoot().listTextures().length) steps.push(textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 85 }));
await doc.transform(...steps);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await io.write(process.argv[3], doc);
let tris = 0;
for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) tris += p.getIndices().getCount() / 3;
console.log('triangles', tris);
