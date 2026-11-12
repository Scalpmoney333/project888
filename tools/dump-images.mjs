// Dev tool: dump embedded images of a GLB into a directory.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'fs';
import path from 'path';

const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(process.argv[2]);
const out = process.argv[3];
doc.getRoot().listTextures().forEach((t, i) => {
  const ext = t.getMimeType() === 'image/jpeg' ? 'jpg' : 'png';
  fs.writeFileSync(path.join(out, 'img_' + i + '_' + (t.getName() || 'tex') + '.' + ext), t.getImage());
});
