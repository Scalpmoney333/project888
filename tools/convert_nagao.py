"""Convert the Nagao Unity map (sharedassets18.assets.split0) into a mobile-friendly GLB.

Usage: python tools/convert_nagao.py <sharedassets file> <out dir>
Requires: UnityPy, numpy, Pillow.

- Reads the world mesh `default_0` and atlas `MEIHAN_MAIN_TEXTURE` (other meshes in the file
  have no scene transforms, or are empty stubs, so their placement is unknown).
- Unity is left-handed and this mesh is Z-up: we mirror X (which also fixes winding) and rotate
  Z-up -> Y-up, giving glTF coordinates (x, y, z) = (-xu, zu, yu).
- Splits triangles into square tiles so the renderer can frustum-cull the 8 km mesh.
- Writes a grip lookup grid over the atlas (0 = tarmac, 1 = grass/dirt, 2 = concrete) and
  candidate spawn data.
"""
import sys, json, struct, io, os
import numpy as np
from PIL import Image
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

Image.MAX_IMAGE_PIXELS = None
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
TILE = 500.0

env = UnityPy.load(src)
mesh = atlas = None
for o in env.objects:
    if o.type.name == 'Mesh':
        try:
            d = o.read()
        except Exception:
            continue  # zero-length stub entries
        if d.m_Name == 'default_0':
            mesh = d
    elif o.type.name == 'Texture2D':
        d = o.read()
        if d.m_Name == 'MEIHAN_MAIN_TEXTURE':
            atlas = d.image.convert('RGB')

h = MeshHandler(mesh)
h.process()
pu = np.array(h.m_Vertices, np.float32).reshape(-1, 3)
nu = np.array(h.m_Normals, np.float32).reshape(-1, 3)
uv = np.array(h.m_UV0, np.float32).reshape(-1, 2)
idx = np.array(h.m_IndexBuffer, np.uint32).reshape(-1, 3)

pos = np.stack([-pu[:, 0], pu[:, 2], pu[:, 1]], 1)
nrm = np.stack([-nu[:, 0], nu[:, 2], nu[:, 1]], 1)
nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-6)
uv = np.stack([uv[:, 0], 1.0 - uv[:, 1]], 1).astype(np.float32)
# Mirroring X turns Unity's clockwise front faces into glTF counter-clockwise ones; keep winding.

# Geometric normal check: after conversion, flat road faces should face +Y.
tp = pos[idx]
gn = np.cross(tp[:, 1] - tp[:, 0], tp[:, 2] - tp[:, 0])
agree = (gn * nrm[idx].mean(1)).sum(1)
print('winding agrees with normals:', float((agree > 0).mean()))

# ---- atlas: downscale for mobile, build grip lookup grid ----
W, H = 4096, 3228
atlas.resize((W, H), Image.LANCZOS).save(os.path.join(out, 'nagao_atlas_4k.jpg'), quality=85)
atlas.resize((2048, 1614), Image.LANCZOS).save(os.path.join(out, 'nagao_atlas_2k.jpg'), quality=85)
GW, GH = 128, 101
small = np.asarray(atlas.resize((GW, GH), Image.BOX), np.float32)
r, g, b = small[..., 0], small[..., 1], small[..., 2]
surf = np.zeros((GH, GW), np.uint8)
green = (g > r * 1.08) & (g > b * 1.15)
surf[green] = 1
bright = (np.abs(r - g) < 14) & (np.abs(g - b) < 14) & (r > 135)
surf[bright & ~green] = 2

# per-triangle surface for spawn search
cu = uv[idx].mean(1)
cx = np.clip((cu[:, 0] * GW).astype(int), 0, GW - 1)
cy = np.clip((cu[:, 1] * GH).astype(int), 0, GH - 1)
tsurf = surf[cy, cx]

# ---- tiles ----
cent = tp.mean(1)
tx = np.floor(cent[:, 0] / TILE).astype(int)
tz = np.floor(cent[:, 2] / TILE).astype(int)
keys = tx * 100000 + tz
order = np.argsort(keys, kind='stable')
uk, starts = np.unique(keys[order], return_index=True)
ends = list(starts[1:]) + [len(order)]

bin_chunks, buffer_views, accessors, meshes, nodes = [], [], [], [], []
offset = 0
def add(arr, target=None, comp=5126, typ='VEC3', minmax=False):
    global offset
    data = arr.tobytes()
    pad = (-len(data)) % 4
    bv = {'buffer': 0, 'byteOffset': offset, 'byteLength': len(data)}
    if target:
        bv['target'] = target
    buffer_views.append(bv)
    bin_chunks.append(data + b'\0' * pad)
    offset += len(data) + pad
    acc = {'bufferView': len(buffer_views) - 1, 'componentType': comp, 'count': int(arr.shape[0]) if arr.ndim > 1 else int(arr.size), 'type': typ}
    if minmax:
        acc['min'] = arr.min(0).tolist(); acc['max'] = arr.max(0).tolist()
    accessors.append(acc)
    return len(accessors) - 1

for k, s, e in zip(uk, starts, ends):
    tris = idx[order[s:e]]
    used, inv = np.unique(tris.ravel(), return_inverse=True)
    local = inv.reshape(-1, 3).astype(np.uint32)
    p = pos[used].astype(np.float32)
    a_p = add(p, 34962, minmax=True)
    a_n = add(nrm[used].astype(np.float32), 34962)
    a_t = add(uv[used].astype(np.float32), 34962, typ='VEC2')
    a_i = add(local.ravel(), 34963, comp=5125, typ='SCALAR')
    meshes.append({'name': 'tile_%d' % len(meshes), 'primitives': [{'attributes': {'POSITION': a_p, 'NORMAL': a_n, 'TEXCOORD_0': a_t}, 'indices': a_i, 'material': 0}]})
    nodes.append({'name': 'tile_%d' % len(nodes), 'mesh': len(meshes) - 1})

gltf = {
    'asset': {'version': '2.0', 'generator': 'convert_nagao.py'},
    'scene': 0,
    'scenes': [{'nodes': list(range(len(nodes)))}],
    'nodes': nodes, 'meshes': meshes,
    'materials': [{'name': 'MEIHAN GROUND', 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0, 'roughnessFactor': 1}}],
    'buffers': [{'byteLength': offset}], 'bufferViews': buffer_views, 'accessors': accessors,
}
js = json.dumps(gltf).encode()
js += b' ' * ((-len(js)) % 4)
binb = b''.join(bin_chunks)
with open(os.path.join(out, 'nagao_raw.glb'), 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binb)))
    f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
    f.write(struct.pack('<II', len(binb), 0x004E4942)); f.write(binb)
print('tiles', len(meshes), 'tris', len(idx))

# ---- road analysis for spawn: tarmac, near-flat, upward ----
up = nrm[idx].mean(1)[:, 1]
road = (tsurf == 0) & (up > 0.93)
area = np.linalg.norm(gn, axis=1) / 2
road &= area > 0.05
rc = cent[road]
print('road tris', int(road.sum()), 'x', np.percentile(rc[:, 0], [0, 50, 100]), 'z', np.percentile(rc[:, 2], [0, 50, 100]), 'y', np.percentile(rc[:, 1], [0, 50, 100]))
np.save(os.path.join(out, 'road_centroids.npy'), rc)
json.dump({'grid': [GW, GH], 'surface': ''.join(str(int(v)) for v in surf.ravel())}, open(os.path.join(out, 'nagao_surface.json'), 'w'))
