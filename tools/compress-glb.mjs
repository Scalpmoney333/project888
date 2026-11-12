// Quantize + meshopt-compress a GLB for mobile delivery (geometry is preserved, only encoded).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { quantize, reorder, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(process.argv[2]);
await doc.transform(
  weld(),
  reorder({ encoder: MeshoptEncoder }),
  quantize({ quantizePosition: 16, quantizeNormal: 8, quantizeTexcoord: 14 }),
);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await io.write(process.argv[3], doc);
