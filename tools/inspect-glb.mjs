// Dev tool: print node hierarchy, transforms and mesh bounds of a GLB.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const f = (a) => a.map((x) => +x.toFixed(3)).join(',');
console.log('extensions', root.listExtensionsUsed().map((e) => e.extensionName));
console.log('meshes', root.listMeshes().length, 'materials', root.listMaterials().length);
console.log('textures', root.listTextures().map((t) => `${t.getName()}:${t.getMimeType()}:${(t.getSize() || []).join('x')}`).join(', '));

function walk(n, d) {
  const m = n.getMesh();
  let info = '';
  if (m) {
    let v = 0;
    const bb = [[1e9, 1e9, 1e9], [-1e9, -1e9, -1e9]];
    for (const p of m.listPrimitives()) {
      const a = p.getAttribute('POSITION');
      v += a.getCount();
      const mn = a.getMin([]), mx = a.getMax([]);
      for (let i = 0; i < 3; i++) { bb[0][i] = Math.min(bb[0][i], mn[i]); bb[1][i] = Math.max(bb[1][i], mx[i]); }
    }
    info = ` MESH v=${v} prims=${m.listPrimitives().length} mats=${m.listPrimitives().map((p) => p.getMaterial()?.getName()).join('|')} bb=${f(bb[0])} / ${f(bb[1])}`;
  }
  console.log(`${' '.repeat(d * 2)}${n.getName()} t=${f(n.getTranslation())} r=${f(n.getRotation())} s=${f(n.getScale())}${info}`);
  n.listChildren().forEach((c) => walk(c, d + 1));
}
for (const s of root.listScenes()) s.listChildren().forEach((n) => walk(n, 0));
