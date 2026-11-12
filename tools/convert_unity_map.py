"""Convert a Unity "manuals" map mod (sharedassets18.assets.split0) into game assets.

Usage: python tools/convert_unity_map.py <map id> <directory containing the extracted zip> <out dir>
Config: tools/maps.json. Requires UnityPy, numpy, Pillow (see README).

Outputs <out>/<id>.raw.glb, <id>.jpg|webp (atlas, max 2048 px) and <id>.json (spawn points).
Compress the glb afterwards with tools/compress-glb.mjs.

- Map meshes are stored in world space (no scene transforms in the mod files). Unity is
  left-handed Z-up here: glTF (x, y, z) = (-xu, zu, yu); mirroring X also fixes the winding.
- Triangles are grouped into square tiles (frustum culling), by material (ground / foliage),
  and by whether they collide. Collidable tiles are named "col_*", visual-only "vis_*".
- Each vertex carries a _SURFACE id (grip class) taken from the mesh config or an atlas lookup.
- Spawns: the longest drivable road is found on a voxel graph of road triangles; its two ends
  become Downhill/Uphill (or Start A/B on flat maps), placed 20 m in and facing along the road.
"""
import sys, os, json, struct, heapq
import numpy as np
from PIL import Image
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

Image.MAX_IMAGE_PIXELS = None
map_id, src_dir, out_dir = sys.argv[1:4]
cfg = json.load(open(os.path.join(os.path.dirname(__file__), 'maps.json')))[map_id]
os.makedirs(out_dir, exist_ok=True)
ROAD_SURFACES = {0, 6}

env = UnityPy.load(*[os.path.join(src_dir, s) for s in cfg['src']])
meshes, atlas = {}, None
for o in env.objects:
    if o.type.name == 'Mesh':
        try:
            d = o.read()
        except Exception:
            continue  # zero-length stub entries
        meshes[('id', o.path_id)] = d
        meshes.setdefault(('name', d.m_Name), d)
    elif o.type.name == 'Texture2D':
        d = o.read()
        if d.m_Name == cfg['texture']:
            atlas = d.image.convert('RGBA')
assert atlas is not None, 'atlas texture not found'

# ---------- surface lookup over the atlas ----------
GW, GH = 128, 128
def color_lut():
    small = np.asarray(atlas.convert('RGB').resize((GW, GH), Image.BOX), np.float32)
    r, g, b = small[..., 0], small[..., 1], small[..., 2]
    surf = np.zeros((GH, GW), np.uint8)
    green = (g > r * 1.08) & (g > b * 1.15)
    surf[green] = 1
    bright = (np.abs(r - g) < 14) & (np.abs(g - b) < 14) & (r > cfg.get("concreteBrightness", 135))
    surf[bright & ~green] = 2
    return surf
def rect_lut():
    surf = np.zeros((GH, GW), np.uint8)
    for r in reversed(cfg['rects']):
        u0, u1 = int(r['u'][0] * GW), int(r['u'][1] * GW)
        v0, v1 = int(r['v'][0] * GH), int(r['v'][1] * GH)
        surf[v0:v1, u0:u1] = r['surface']
    return surf
def green_lut():
    surf = color_lut()
    return np.where(surf == 1, 1, 0).astype(np.uint8)  # only green texels are grass
lut = {"color": color_lut, "rects": rect_lut, "green": green_lut}.get(cfg.get("lut"), lambda: None)()

# ---------- gather triangles ----------
P, N, UV, IDX, TSURF, TMAT, TCOL = [], [], [], [], [], [], []
voff = 0
for m in cfg['meshes']:
    d = meshes[('id', m['pathId'])] if 'pathId' in m else meshes[('name', m['name'])]
    h = MeshHandler(d); h.process()
    pu = np.array(h.m_Vertices, np.float32).reshape(-1, 3)
    nu = np.array(h.m_Normals, np.float32).reshape(-1, 3)
    uv = np.array(h.m_UV0, np.float32).reshape(-1, 2)
    idx = np.array(h.m_IndexBuffer, np.uint32).reshape(-1, 3)
    pos = np.stack([-pu[:, 0], pu[:, 2], pu[:, 1]], 1)
    nrm = np.stack([-nu[:, 0], nu[:, 2], nu[:, 1]], 1)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-6)
    uv = np.stack([uv[:, 0], 1.0 - uv[:, 1]], 1).astype(np.float32)  # glTF: v down
    cu = uv[idx].mean(1)
    if m.get('surface') == 'lut':
        w = np.mod(cu, 1.0)
        ts = lut[np.clip((w[:, 1] * GH).astype(int), 0, GH - 1), np.clip((w[:, 0] * GW).astype(int), 0, GW - 1)]
    else:
        ts = np.full(len(idx), m.get('surface', 0), np.uint8)
    col = np.full(len(idx), bool(m['collide']))
    if m['collide'] == 'solid-only':
        # Foliage areas of the atlas (tree sprites, bush/forest bands, horizontally tiled bands)
        # are visual only so the car does not hit invisible leaves.
        row = np.mod(cu[:, 1], 1.0)
        foliage = (cu[:, 0] < -0.01) | (cu[:, 0] > 1.01)
        for a, b in cfg.get('foliageRows', []):
            foliage |= (row >= a) & (row <= b)
        col = ~foliage
    P.append(pos); N.append(nrm); UV.append(uv); IDX.append(idx + voff)
    TSURF.append(ts); TMAT.append(np.full(len(idx), 1 if m.get('material') == 'foliage' else 0)); TCOL.append(col)
    voff += len(pos)
    print(m.get('name', m.get('pathId')), 'verts', len(pos), 'tris', len(idx), 'collide', int(col.sum()))
pos = np.concatenate(P); nrm = np.concatenate(N); uv = np.concatenate(UV); idx = np.concatenate(IDX)
tsurf = np.concatenate(TSURF); tmat = np.concatenate(TMAT); tcol = np.concatenate(TCOL)
tp = pos[idx]
gn = np.cross(tp[:, 1] - tp[:, 0], tp[:, 2] - tp[:, 0])
print('winding agrees with normals:', float(((gn * nrm[idx].mean(1)).sum(1) > 0).mean()))

# ---------- atlas ----------
W, H = atlas.size
s = min(1.0, 2048 / max(W, H))
img = atlas.resize((max(1, round(W * s)), max(1, round(H * s))), Image.LANCZOS) if s < 1 else atlas
if cfg.get('alpha'):
    tex_name = f'{map_id}.webp'
    img.save(os.path.join(out_dir, tex_name), quality=88, method=6)
else:
    tex_name = f'{map_id}.jpg'
    img.convert('RGB').save(os.path.join(out_dir, tex_name), quality=86)

# ---------- tiles -> glb ----------
TILE = float(cfg.get('tile', 500))
cent = tp.mean(1)
tx = np.floor(cent[:, 0] / TILE).astype(np.int64)
tz = np.floor(cent[:, 2] / TILE).astype(np.int64)
keys = ((tx + 1000) * 2000 + (tz + 1000)) * 4 + tmat * 2 + tcol.astype(np.int64)
order = np.argsort(keys, kind='stable')
uk, starts = np.unique(keys[order], return_index=True)
ends = list(starts[1:]) + [len(order)]
chunks, views, accs, gmeshes, nodes = [], [], [], [], []
offset = 0
def add(arr, target, comp=5126, typ='VEC3', minmax=False):
    global offset
    data = arr.tobytes(); pad = (-len(data)) % 4
    v = {'buffer': 0, 'byteOffset': offset, 'byteLength': len(data), 'target': target}
    views.append(v); chunks.append(data + b'\0' * pad); offset += len(data) + pad
    a = {'bufferView': len(views) - 1, 'componentType': comp, 'count': int(arr.shape[0]), 'type': typ}
    if minmax:
        a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
    accs.append(a)
    return len(accs) - 1
for k, s0, e0 in zip(uk, starts, ends):
    sel = order[s0:e0]
    tris = idx[sel]
    # vertices are duplicated per surface so every triangle reads its own grip class
    vkey = tris.astype(np.int64) * 16 + tsurf[sel][:, None].astype(np.int64)
    used, inv = np.unique(vkey.ravel(), return_inverse=True)
    vid = (used // 16).astype(np.int64)
    vs = (used % 16).astype(np.float32)
    a_p = add(pos[vid].astype(np.float32), 34962, minmax=True)
    a_n = add(nrm[vid].astype(np.float32), 34962)
    a_t = add(uv[vid].astype(np.float32), 34962, typ='VEC2')
    a_s = add(vs, 34962, typ='SCALAR')
    a_i = add(inv.astype(np.uint32), 34963, comp=5125, typ='SCALAR')
    mat = int((k // 2) % 2); col = int(k % 2)
    name = f"{'col' if col else 'vis'}_{len(nodes)}"
    gmeshes.append({'name': name, 'primitives': [{'attributes': {'POSITION': a_p, 'NORMAL': a_n, 'TEXCOORD_0': a_t, '_SURFACE': a_s}, 'indices': a_i, 'material': mat}]})
    nodes.append({'name': name, 'mesh': len(gmeshes) - 1})
gltf = {
    'asset': {'version': '2.0', 'generator': 'convert_unity_map.py'},
    'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': gmeshes,
    'materials': [
        {'name': 'ground', 'doubleSided': True, 'pbrMetallicRoughness': {'metallicFactor': 0, 'roughnessFactor': 1}},
        {'name': 'foliage', 'doubleSided': True, 'pbrMetallicRoughness': {'metallicFactor': 0, 'roughnessFactor': 1}},
    ],
    'buffers': [{'byteLength': offset}], 'bufferViews': views, 'accessors': accs,
}
js = json.dumps(gltf).encode(); js += b' ' * ((-len(js)) % 4)
binb = b''.join(chunks)
with open(os.path.join(out_dir, f'{map_id}.raw.glb'), 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binb)))
    f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
    f.write(struct.pack('<II', len(binb), 0x004E4942)); f.write(binb)
print('tiles', len(nodes), 'tris', len(idx))

# ---------- spawns from the road graph ----------
up = nrm[idx].mean(1)[:, 1]
area = np.linalg.norm(gn, axis=1) / 2
road = tcol & np.isin(tsurf, list(ROAD_SURFACES)) & (up > 0.85) & (area > 0.02)
rc = cent[road]
V = 3.0
vk = np.floor(rc / V).astype(np.int64)
uniq, inv = np.unique(vk, axis=0, return_inverse=True)
inv = inv.ravel()
cnt = np.bincount(inv)
vpos = np.stack([np.bincount(inv, rc[:, i]) / cnt for i in range(3)], 1)
cell = {tuple(k): i for i, k in enumerate(uniq)}
adj = [[] for _ in range(len(uniq))]
for i, k in enumerate(uniq):
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                j = cell.get((k[0] + dx, k[1] + dy, k[2] + dz))
                if j is not None and j != i:
                    d = np.linalg.norm(vpos[i] - vpos[j])
                    if abs(vpos[i][1] - vpos[j][1]) < 1.6:
                        adj[i].append((j, d))
def dijkstra(src):
    dist = np.full(len(uniq), np.inf); dist[src] = 0; pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        for v, w in adj[u]:
            nd = d + w
            if nd < dist[v]:
                dist[v] = nd; heapq.heappush(pq, (nd, v))
    return dist
# largest component: start from the node with the most road around it
d0 = dijkstra(int(np.argmax(cnt)))
comp_size = np.isfinite(d0).sum()
best = None
reach = np.isfinite(d0)
if comp_size < len(uniq) * 0.3:  # seed was in a small island: retry from a random big area
    for seed in np.argsort(-cnt)[:20]:
        dd = dijkstra(int(seed))
        if np.isfinite(dd).sum() > comp_size:
            d0, comp_size, reach = dd, np.isfinite(dd).sum(), np.isfinite(dd)
a = int(np.argmax(np.where(reach, d0, -1)))
da = dijkstra(a)
b = int(np.argmax(np.where(np.isfinite(da), da, -1)))
db = dijkstra(b)
print('road voxels', len(uniq), 'component', int(comp_size), 'longest road', round(float(da[b])), 'm')
def spawn_at(dist):
    # Snap to real road nodes, preferring the most interior one (most road neighbours), so the
    # car starts mid-road rather than on an edge or off a hairpin.
    band = np.where((dist > 17) & (dist < 23))[0]
    ahead = np.where((dist > 37) & (dist < 43))[0]
    deg = np.array([len(adj[k]) for k in band])
    near = np.linalg.norm(vpos[band] - vpos[band].mean(0), axis=1)
    i = band[np.lexsort((near, -deg))[0]]
    j = ahead[np.argmin(np.linalg.norm(vpos[ahead] - vpos[ahead].mean(0), axis=1))]
    p, q = vpos[i], vpos[j]
    yaw = float(np.arctan2(q[0] - p[0], q[2] - p[2]))
    return [round(float(p[0]), 2), round(float(p[1]), 2), round(float(p[2]), 2)], round(yaw, 4)
pa, ya = spawn_at(da)
pb, yb = spawn_at(db)
if abs(pa[1] - pb[1]) > 80:
    hi, lo = ((pa, ya), (pb, yb)) if pa[1] > pb[1] else ((pb, yb), (pa, ya))
    spawns = [{'id': 'downhill', 'name': 'Downhill', 'position': hi[0], 'yaw': hi[1]},
              {'id': 'uphill', 'name': 'Uphill', 'position': lo[0], 'yaw': lo[1]}]
else:
    spawns = [{'id': 'a', 'name': 'Start A', 'position': pa, 'yaw': ya},
              {'id': 'b', 'name': 'Start B', 'position': pb, 'yaw': yb}]
meta = {'texture': tex_name, 'alpha': bool(cfg.get('alpha')), 'spawns': spawns,
        'bounds': [pos.min(0).round(1).tolist(), pos.max(0).round(1).tolist()], 'roadLength': round(float(da[b]))}
json.dump(meta, open(os.path.join(out_dir, f'{map_id}.json'), 'w'), indent=1)
print(json.dumps(spawns))
