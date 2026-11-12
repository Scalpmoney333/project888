"""Convert a Unity "manuals" map mod (sharedassets18.assets.split0) into game assets.

Usage: python tools/convert_unity_map.py <map id> <directory containing the extracted zip> <out dir>
Config: tools/maps.json. Requires UnityPy, numpy, scipy, Pillow (see README).

Outputs <out>/<id>.raw.glb, <id>.jpg|webp (atlas, max 2048 px) and <id>.json (spawn points).
Compress the glb afterwards with tools/compress-glb.mjs.

- Map meshes are stored in world space (no scene transforms in the mod files). Unity is
  left-handed Z-up here: glTF (x, y, z) = (-xu, zu, yu); mirroring X also fixes the winding.
- Some mods store their scenery objects (trees, poles, rails) a fixed height too high
  ("liftFix" in maps.json); those objects are lowered onto the ground (maptools).
- Every vertex carries a _SURFACE grip id taken from the mesh config or an atlas lookup.
- Spawns: two ends of the longest drivable road (maptools.find_spawns).
"""
import sys, os, json
import numpy as np
from PIL import Image
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

sys.path.insert(0, os.path.dirname(__file__))
import maptools

Image.MAX_IMAGE_PIXELS = None
map_id, src_dir, out_dir = sys.argv[1:4]
cfg = json.load(open(os.path.join(os.path.dirname(__file__), 'maps.json')))[map_id]
os.makedirs(out_dir, exist_ok=True)

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
    bright = (np.abs(r - g) < 14) & (np.abs(g - b) < 14) & (r > 135)
    surf[bright & ~green] = 2
    return surf
def green_lut():
    return np.where(color_lut() == 1, 1, 0).astype(np.uint8)  # only green texels are grass
lut = {'color': color_lut, 'green': green_lut}.get(cfg.get('lut'), lambda: None)()

# ---------- gather triangles ----------
P, N, UV, IDX, TSURF, TMAT, TCOL, TMESH = [], [], [], [], [], [], [], []
voff = 0
for mi, m in enumerate(cfg['meshes']):
    d = meshes[('id', m['pathId'])] if 'pathId' in m else meshes[('name', m['name'])]
    h = MeshHandler(d); h.process()
    pu = np.array(h.m_Vertices, np.float32).reshape(-1, 3)
    nu = np.array(h.m_Normals, np.float32).reshape(-1, 3)
    uv = np.array(h.m_UV0, np.float32).reshape(-1, 2)
    idx = np.array(h.m_IndexBuffer, np.int64).reshape(-1, 3)
    pos = np.stack([-pu[:, 0], pu[:, 2], pu[:, 1]], 1).astype(np.float64)
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
    TMESH.append(np.full(len(idx), mi))
    voff += len(pos)
    print(m.get('name', m.get('pathId')), 'verts', len(pos), 'tris', len(idx), 'collide', int(col.sum()))
pos = np.concatenate(P); nrm = np.concatenate(N); uv = np.concatenate(UV); idx = np.concatenate(IDX)
tsurf = np.concatenate(TSURF); tmat = np.concatenate(TMAT); tcol = np.concatenate(TCOL); tmesh = np.concatenate(TMESH)

# ---------- lifted scenery objects ----------
fix = cfg.get('liftFix')
if fix:
    names = [m.get('name', m.get('pathId')) for m in cfg['meshes']]
    scen = np.isin(tmesh, [names.index(n) for n in fix['meshes']])
    ground = np.isin(tmesh, [names.index(n) for n in fix['ground']])
    pos, idx, remap = maptools.drop_lifted_objects(pos, idx, scen, ground, fix['dy'], map_id)
    dup = np.where(remap != np.arange(len(remap)))[0]  # vertices duplicated by the fix
    nrm = np.concatenate([nrm, nrm[dup]])
    uv = np.concatenate([uv, uv[dup]])

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

maptools.write_tiled_glb(os.path.join(out_dir, f'{map_id}.raw.glb'), pos, nrm, uv, idx, tsurf, tmat, tcol,
                         [{'name': 'ground'}, {'name': 'foliage'}], float(cfg.get('tile', 500)))
spawns, length = maptools.find_spawns(pos, idx, tsurf, tcol)
meta = {'texture': tex_name, 'alpha': bool(cfg.get('alpha')), 'spawns': spawns,
        'bounds': [pos.min(0).round(1).tolist(), pos.max(0).round(1).tolist()], 'roadLength': length}
json.dump(meta, open(os.path.join(out_dir, f'{map_id}.json'), 'w'), indent=1)
print(json.dumps(spawns))
