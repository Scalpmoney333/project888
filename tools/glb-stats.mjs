// Quick GLB stats from the JSON chunk only (works on meshopt-compressed files).
import fs from 'node:fs';

for (const f of process.argv.slice(2)) {
  const b = fs.readFileSync(f);
  const len = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + len).toString());
  let tris = 0, prims = 0, verts = 0;
  for (const m of j.meshes || []) for (const p of m.primitives) {
    prims++;
    verts += j.accessors[p.attributes.POSITION].count;
    tris += p.indices !== undefined ? j.accessors[p.indices].count / 3 : 0;
  }
  const imgBytes = (j.images || []).map((im) => (im.bufferView !== undefined ? j.bufferViews[im.bufferView].byteLength : 0));
  const sizes = [];
  for (const im of j.images || []) {
    const bv = j.bufferViews[im.bufferView];
    const data = b.subarray(20 + len + 8 + (bv.byteOffset || 0), 20 + len + 8 + (bv.byteOffset || 0) + bv.byteLength);
    let w = 0, h = 0;
    if (data[0] === 0x89) { w = data.readUInt32BE(16); h = data.readUInt32BE(20); }
    else if (data.subarray(8, 12).toString() === 'WEBP') {
      const t = data.subarray(12, 16).toString();
      if (t === 'VP8 ') { w = data.readUInt16LE(26) & 0x3fff; h = data.readUInt16LE(28) & 0x3fff; }
      else if (t === 'VP8L') { const v = data.readUInt32LE(21); w = (v & 0x3fff) + 1; h = ((v >> 14) & 0x3fff) + 1; }
      else if (t === 'VP8X') { w = 1 + data.readUIntLE(24, 3); h = 1 + data.readUIntLE(27, 3); }
    } else if (data[0] === 0xff) {
      for (let i = 2; i < data.length;) { const m = data[i + 1]; const l = data.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) { h = data.readUInt16BE(i + 5); w = data.readUInt16BE(i + 7); break; } i += 2 + l; }
    }
    sizes.push(w * h);
  }
  const texPixels = sizes.reduce((a, x) => a + x, 0);
  console.log(f.split('/').pop(), {
    nodes: (j.nodes || []).length, meshes: (j.meshes || []).length, prims, materials: (j.materials || []).length,
    images: (j.images || []).length, imageMB: +(imgBytes.reduce((a, x) => a + x, 0) / 1e6).toFixed(1),
    texMPix: +(texPixels / 1e6).toFixed(1), gpuMB_rgba_mips: +(texPixels * 4 * 1.33 / 1e6).toFixed(0),
    verts, tris: Math.round(tris), ext: j.extensionsUsed,
  });
}
