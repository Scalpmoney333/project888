// Prepare a car GLB for mobile: textures resized to at most 1024 px and re-encoded as WebP.
// Geometry, node transforms and materials are untouched (the wheel rig is built at runtime).
// Usage: node tools/optimize-car.mjs <in.glb> <out.glb>
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, prune, dedup } from '@gltf-transform/functions';
import sharp from 'sharp';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
await doc.transform(
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }),
);
await io.write(process.argv[3], doc);
