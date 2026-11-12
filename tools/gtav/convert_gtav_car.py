"""Convert a GTA V vehicle mod (YFT fragment + YTD textures) to a glTF binary for the game.

Usage: python tools/gtav/convert_gtav_car.py <car.yft> <car.ytd> <out.glb>
Then:  node tools/optimize-car.mjs <out.glb> public/assets/cars/<name>.glb --simplify 0.2 0.004 --texsize 512

- Body: the FragDrawable's high-LOD model. Vehicle bodies are skinned to the skeleton in bind pose, so vertices
  are already in model space; each geometry is split per bone (strongest blend weight) into nodes named after
  the bone (bodyshell, door_dside_f, ...). chassis_lowlod / chassis_dummy are skipped.
- Wheels: GTA V carries one wheel (the wheel_lf fragment child drawable, in wheel-local space); like the game,
  it is placed at all four wheel bones, turned 180 degrees about the up axis on the right side. Nodes are named
  wheel_lf/rf/lb/rb. Brake calipers are skinned to the hub_* bones and become hub_* nodes, material "caliper".
- GTA is Z-up with +Y forward; glTF (x, y, z) = (x, z, -y), so the car faces -Z (spec yaw 180).
- Paint: vehicle_paint* shaders become white materials named "paint*" so the game can recolour them.
  Textures from the game's shared vehshare dictionary are not in the mod; those get flat colours.
"""
import sys, os, io, json, struct
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
import rsc

yft_path, ytd_path, out = sys.argv[1:4]
yft_data = open(yft_path, 'rb').read()
y = rsc.read_yft(yft_data)
y['children'] = rsc.read_yft_children(yft_data, y['bones'])
textures = rsc.read_ytd(open(ytd_path, 'rb').read(), max_size=1024)
textures.update(y['embedded'])
bones = y['bones']
bone_idx = {b['name']: i for i, b in enumerate(bones)}
print('bones', len(bones), 'geometries', len(y['geometries']), 'textures', len(textures))

SHADER_NAMES = ['vehicle_paint%d%s' % (i, s) for i in range(1, 10) for s in ('', '_enveff', '_lvr')] + [
    'vehicle_vehglass', 'vehicle_vehglass_inner', 'vehicle_shuts', 'vehicle_tire', 'vehicle_tire_emissive',
    'vehicle_interior', 'vehicle_interior2', 'vehicle_mesh', 'vehicle_mesh_enveff', 'vehicle_mesh2_enveff',
    'vehicle_lightsemissive', 'vehicle_lights', 'vehicle_dash_emissive', 'vehicle_dash_emissive_opaque',
    'vehicle_decal', 'vehicle_decal2', 'vehicle_detail', 'vehicle_detail2', 'vehicle_badges', 'vehicle_basic',
    'vehicle_generic', 'vehicle_cloth', 'vehicle_cutout', 'vehicle_emissive_opaque', 'vehicle_emissive_alpha',
    'vehicle_licenseplate', 'vehicle_nosplash', 'vehicle_nowater', 'vehicle_blurredrotor']
SHADER = {rsc.joaat(n): n[len('vehicle_'):] for n in SHADER_NAMES}
DIFFUSE = rsc.joaat('DiffuseSampler')
# Shared vehshare textures (not shipped with mods) -> flat colour.
FLAT = {'vehicle_generic_tyrewallblack': (0.06, 0.06, 0.06), 'vehicle_generic_detail2': (0.35, 0.35, 0.35),
        'vehicle_generic_black_plastic': (0.05, 0.05, 0.05)}
SKIP_BONES = {'chassis_lowlod', 'chassis_dummy'}

materials, mat_key = [], {}


def material(si):
    if si in mat_key:
        return mat_key[si]
    sh = y['shaders'][si]
    kind = SHADER.get(sh['hash'], 'unknown')
    tex = (sh['textures'].get(DIFFUSE) or '').lower()
    img = textures.get(tex)
    m = {'image': None, 'color': [1, 1, 1, 1], 'alpha': 'OPAQUE', 'metal': 0.0, 'rough': 0.6}
    if kind.startswith('paint'):
        m.update(name=f'paint{kind[5]}', metal=0.25, rough=0.35)
    elif kind.startswith('vehglass'):
        m.update(name=f'glass_{tex}', alpha='BLEND', rough=0.1, image=img)
        if img is None:
            m['color'] = [0.1, 0.1, 0.12, 0.4]
    else:
        prefix = {'lightsemissive': 'light_', 'tire': 'tyre_'}.get(kind, '')
        m.update(name=prefix + (tex or kind))
        if prefix:  # distinct from non-light materials sharing the texture (keeps dedup from merging them)
            m['rough'] = {'light_': 0.3, 'tyre_': 0.8}[prefix]
        if img is not None:
            m['image'] = img
            if img.getextrema()[3][0] < 250:
                m['alpha'] = 'MASK'
        else:
            m['color'] = list(FLAT.get(tex, (0.1, 0.1, 0.1) if kind.startswith('interior') else (0.4, 0.4, 0.4))) + [1]
        if tex in ('chrome', 'ref', 'gold', 'bronze'):
            m.update(metal=0.9, rough=0.25)
    m['shader'] = si
    m['kind'] = kind
    materials.append(m)
    mat_key[si] = len(materials) - 1
    return mat_key[si]


def to_gltf(p):
    return np.stack([p[:, 0], p[:, 2], -p[:, 1]], 1)


parts = {}  # node name -> list of (pos, nrm, uv, mat, tri)


def add(name, pos, nrm, uv, mat, tri):
    parts.setdefault(name, []).append((to_gltf(pos), to_gltf(nrm), uv, mat, tri))


for g in y['geometries']:
    k = np.argmax(g['weights'], 1)
    vb = np.array(g['bone_ids'])[g['joints'].astype(int)[np.arange(len(k)), k]] if g['skinned'] else np.full(len(k), g['bone'])
    if not g['skinned']:  # rigid model: vertices in bone space
        M = bones[g['bone']]['world']
        g['pos'] = g['pos'] @ M[:3, :3].T + M[:3, 3]
        g['normal'] = g['normal'] @ M[:3, :3].T
    tri = g['idx']
    tb = vb[tri[:, 0]]
    mat = material(g['shader'])
    for b in np.unique(tb):
        name = bones[b]['name']
        if name in SKIP_BONES:
            continue
        t = tri[tb == b]
        used = np.unique(t)
        remap = np.zeros(len(g['pos']), np.int64)
        remap[used] = np.arange(len(used))
        mi = mat
        if name.startswith('hub_'):  # brake calipers: steer with the wheel but do not spin
            mi = len(materials) if 'caliper' not in [x['name'] for x in materials] else [x['name'] for x in materials].index('caliper')
            if mi == len(materials):
                materials.append({'name': 'caliper', 'image': None, 'color': [0.15, 0.15, 0.16, 1], 'alpha': 'OPAQUE',
                                  'metal': 0.3, 'rough': 0.4, 'shader': -1, 'kind': 'caliper'})
        add(name, g['pos'][used], g['normal'][used], g['uv'][used] if g['uv'] is not None else np.zeros((len(used), 2)),
            mi, remap[t])

# Wheel: the fragment child drawable bound to wheel_lf (wheel-local space).
wheel = y['children'].get('wheel_lf')
assert wheel, 'no wheel_lf child drawable'
for corner, bname in (('lf', 'wheel_lf'), ('rf', 'wheel_rf'), ('lb', 'wheel_lr'), ('rb', 'wheel_rr')):
    M = np.eye(4)
    M[:3, 3] = bones[bone_idx[bname]]['world'][:3, 3]
    if corner[0] == 'r':
        M[:3, :3] = np.diag([-1, -1, 1])  # 180 degrees about the up axis
    for g in wheel:
        add(f'wheel_{corner}', g['pos'] @ M[:3, :3].T + M[:3, 3], g['normal'] @ M[:3, :3].T,
            g['uv'] if g['uv'] is not None else np.zeros((len(g['pos']), 2)), material(g['shader']), g['idx'])

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
for name, plist in parts.items():
    prims = []
    for pos, nrm, uv, m, tri in plist:
        nrm = nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
        prims.append({'attributes': {'POSITION': acc(pos.astype(np.float32), 34962, minmax=True),
                                     'NORMAL': acc(nrm.astype(np.float32), 34962),
                                     'TEXCOORD_0': acc(uv.astype(np.float32), 34962, typ='VEC2')},
                      'indices': acc(tri.astype(np.uint32).ravel(), 34963, comp=5125, typ='SCALAR'), 'material': m})
        total += len(tri)
    meshes.append({'name': name, 'primitives': prims})
    nodes.append({'name': name, 'mesh': len(meshes) - 1})

gm, images, texs = [], [], []
for m in materials:
    pbr = {'baseColorFactor': m['color'], 'metallicFactor': m['metal'], 'roughnessFactor': m['rough']}
    if m['image'] is not None:
        buf = io.BytesIO()
        if m['alpha'] == 'OPAQUE':
            m['image'].convert('RGB').save(buf, 'JPEG', quality=90); mime = 'image/jpeg'
        else:
            m['image'].save(buf, 'PNG'); mime = 'image/png'
        images.append({'bufferView': view(buf.getvalue()), 'mimeType': mime})
        texs.append({'source': len(images) - 1, 'sampler': 0})
        pbr['baseColorTexture'] = {'index': len(texs) - 1}
    mat = {'name': m['name'], 'pbrMetallicRoughness': pbr, 'alphaMode': m['alpha'], 'doubleSided': True}
    if m['alpha'] == 'MASK':
        mat['alphaCutoff'] = 0.5
    gm.append(mat)

root = {'name': 'gtav_car', 'children': list(range(len(nodes)))}
gltf = {'asset': {'version': '2.0', 'generator': 'convert_gtav_car.py'}, 'scene': 0, 'scenes': [{'nodes': [len(nodes)]}],
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
print('nodes', len(nodes), 'materials', len(materials), 'triangles', total, 'MB', round((len(js) + len(binb)) / 1e6, 1))
for n, pl in parts.items():
    print(' ', n, sum(len(p[4]) for p in pl), sorted(set(materials[p[3]]['name'] for p in pl)))
