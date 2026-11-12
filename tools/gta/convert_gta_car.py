"""Convert a GTA San Andreas vehicle (DFF + TXD) to a glTF binary for the game.

Usage: python tools/gta/convert_gta_car.py <car folder with .dff/.txd> <out.glb>
Then: node tools/optimize-car.mjs <out.glb> public/assets/cars/<name>.glb --simplify 0.3

- Damage (_dam) and low-detail (_vlo) parts are skipped.
- GTA cars carry one wheel model (under wheel_rf_dummy); like the game, it is copied to all four
  wheel dummies, turned 180 degrees about the vertical axis on the left side. Nodes are named
  wheel_rf/lf/rb/lb so the game's wheel detection finds them; brake hubs keep their names.
- GTA is Z-up with +Y forward; glTF (x, y, z) = (x, z, -y), so the car faces -Z (spec yaw 180).
- Paint: SA marks body colour with material colours (60,255,0) primary / (255,0,175) secondary;
  those become materials named "paint*" in white so the game can recolour them.
"""
import sys, os, io, json, struct, glob
import numpy as np
from PIL import Image

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
import rw

src, out = sys.argv[1], sys.argv[2]
dff = glob.glob(os.path.join(src, '*.dff'))[0]
clump = rw.read_dff(open(dff, 'rb').read())[0]
textures = {}
for p in glob.glob(os.path.join(src, '*.txd')):
    textures.update(rw.read_txd(open(p, 'rb').read(), max_size=1024))
for p in glob.glob(os.path.join(src, '*.dds')) + glob.glob(os.path.join(src, '*.png')):
    name = os.path.splitext(os.path.basename(p))[0].lower()
    if name not in textures:
        im = Image.open(p).convert('RGBA')
        if max(im.size) > 1024:
            im.thumbnail((1024, 1024), Image.LANCZOS)
        textures[name] = im
print('textures', len(textures))

PAINT = {(60, 255, 0): 'paint_primary', (255, 0, 175): 'paint_secondary'}
frames = clump['frames']
geoms = clump['geometries']
by_name = {f.name.lower(): i for i, f in enumerate(frames)}
skip = lambda n: n.endswith('_dam') or n.endswith('_vlo') or n.endswith('_lo')

materials, mat_key = [], {}
def material(m):
    col = tuple(m['color'][:3])
    tex = (m['texture'] or '').lower()
    paint = PAINT.get(col)
    key = (paint, tex, col if not paint else None, m['color'][3])
    if key in mat_key:
        return mat_key[key]
    img = textures.get(tex)
    alpha = m['color'][3] / 255
    tex_alpha = img is not None and img.getextrema()[3][0] < 250
    mode = 'BLEND' if alpha < 0.98 else ('MASK' if tex_alpha else 'OPAQUE')
    if tex_alpha:
        img = rw.bleed_alpha(img)
    color = [1, 1, 1, alpha] if paint else [c / 255 for c in col] + [alpha]
    name = paint or tex or f'color_{col[0]}_{col[1]}_{col[2]}'
    materials.append({'name': name, 'image': img, 'color': color, 'alpha': mode})
    mat_key[key] = len(materials) - 1
    return mat_key[key]

def to_gltf(p):
    return np.stack([p[:, 0], p[:, 2], -p[:, 1]], 1)

parts = []  # (node name, positions, normals, uvs, {material: tri indices})
def add_part(name, g, M):
    pos = g.pos @ M[:3, :3].T + M[:3, 3]
    nrm = g.nrm @ M[:3, :3].T if g.nrm is not None else None
    tri, mat = rw.triangles(g)
    if np.linalg.det(M[:3, :3]) < 0:
        tri = tri[:, [0, 2, 1]]
    groups = {}
    for m in np.unique(mat):
        groups.setdefault(material(g.materials[m]), []).append(tri[mat == m])
    parts.append((name, to_gltf(pos), to_gltf(nrm) if nrm is not None else None,
                  g.uv if g.uv is not None else np.zeros((len(pos), 2), np.float32),
                  {k: np.concatenate(v) for k, v in groups.items()}))

wheel_geom = None
for fi, gi in clump['atomics']:
    f = frames[fi]
    n = f.name.lower()
    if skip(n):
        continue
    if n == 'wheel' or (frames[f.parent].name.lower().startswith('wheel_') if f.parent >= 0 else False):
        wheel_geom = (geoms[gi], f)
        continue
    add_part(f.name, geoms[gi], f.world)

assert wheel_geom, 'no wheel model'
g, wf = wheel_geom
local = np.linalg.inv(frames[wf.parent].world) @ wf.world  # wheel relative to its dummy
for corner in ('rf', 'lf', 'rb', 'lb'):
    d = frames[by_name[f'wheel_{corner}_dummy']].world
    flip = np.eye(4)
    if corner[0] == 'l':
        flip[:3, :3] = np.diag([-1, -1, 1])  # 180 degrees about the up axis
    add_part(f'wheel_{corner}', g, d @ flip @ local)

# ---------------------------------------------------------------- write glb
chunks, views, accs, meshes, nodes = [], [], [], [], []
off = [0]
def view(data, target=None):
    pad = (-len(data)) % 4
    v = {'buffer': 0, 'byteOffset': off[0], 'byteLength': len(data)}
    if target:
        v['target'] = target
    views.append(v); chunks.append(data + b'\0' * pad); off[0] += len(data) + pad
    return len(views) - 1
def acc(arr, target, comp=5126, typ='VEC3', minmax=False):
    a = {'bufferView': view(np.ascontiguousarray(arr).tobytes(), target), 'componentType': comp, 'count': int(arr.shape[0]), 'type': typ}
    if minmax:
        a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
    accs.append(a)
    return len(accs) - 1

total = 0
for name, pos, nrm, uv, groups in parts:
    if nrm is None:
        nrm = np.zeros_like(pos)
        for t in groups.values():
            tp = pos[t]
            fn = np.cross(tp[:, 1] - tp[:, 0], tp[:, 2] - tp[:, 0])
            for k in range(3):
                np.add.at(nrm, t[:, k], fn)
    nrm = nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
    a_p = acc(pos.astype(np.float32), 34962, minmax=True)
    a_n = acc(nrm.astype(np.float32), 34962)
    a_t = acc(uv.astype(np.float32), 34962, typ='VEC2')
    prims = []
    for m, t in groups.items():
        prims.append({'attributes': {'POSITION': a_p, 'NORMAL': a_n, 'TEXCOORD_0': a_t},
                      'indices': acc(t.astype(np.uint32).ravel(), 34963, comp=5125, typ='SCALAR'), 'material': m})
        total += len(t)
    meshes.append({'name': name, 'primitives': prims})
    nodes.append({'name': name, 'mesh': len(meshes) - 1})

gm, images, texs = [], [], []
for m in materials:
    pbr = {'baseColorFactor': m['color'], 'metallicFactor': 0.0, 'roughnessFactor': 0.6}
    if m['image'] is not None:
        buf = io.BytesIO()
        if m['alpha'] == 'OPAQUE':
            m['image'].convert('RGB').save(buf, 'JPEG', quality=90); mime = 'image/jpeg'
        else:
            m['image'].save(buf, 'PNG'); mime = 'image/png'
        images.append({'bufferView': view(buf.getvalue()), 'mimeType': mime})
        texs.append({'source': len(images) - 1, 'sampler': 0})
        pbr['baseColorTexture'] = {'index': len(texs) - 1}
    if m['name'].startswith('paint'):
        pbr.update(metallicFactor=0.25, roughnessFactor=0.35)
    if m['name'] in ('chrms', 'chrome_int', 'chromes14', 'exhaust'):
        pbr.update(metallicFactor=0.9, roughnessFactor=0.25)
    mat = {'name': m['name'], 'pbrMetallicRoughness': pbr, 'alphaMode': m['alpha'], 'doubleSided': True}
    if m['alpha'] == 'MASK':
        mat['alphaCutoff'] = 0.5
    gm.append(mat)

root = {'name': 'gta_car', 'children': list(range(len(nodes)))}
gltf = {'asset': {'version': '2.0', 'generator': 'convert_gta_car.py'}, 'scene': 0, 'scenes': [{'nodes': [len(nodes)]}],
        'nodes': nodes + [root], 'meshes': meshes, 'materials': gm, 'buffers': [{'byteLength': off[0]}],
        'bufferViews': views, 'accessors': accs}
if images:
    gltf.update(images=images, textures=texs, samplers=[{'magFilter': 9729, 'minFilter': 9987}])
js = json.dumps(gltf).encode(); js += b' ' * ((-len(js)) % 4)
binb = b''.join(chunks)
with open(out, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binb)))
    f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
    f.write(struct.pack('<II', len(binb), 0x004E4942)); f.write(binb)
print('parts', len(parts), 'materials', len(materials), 'triangles', total, 'MB', round((len(js) + len(binb)) / 1e6, 1))
