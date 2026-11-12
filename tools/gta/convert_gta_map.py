"""Convert a GTA San Andreas map mod (IPL + IDE + DFF + TXD) into game assets.

Usage: python tools/gta/convert_gta_map.py <map id> <mod folder (with .ipl/.ide and gta3img/)> <out dir>
Config: tools/gta/gta_maps.json (surface and foliage classification by texture name).

- Instances from the IPL are placed with their quaternion conjugated (SA stores the inverse
  rotation; verified on Shomaru by checking that neighbouring pieces share seam vertices).
- GTA is Z-up right-handed: glTF (x, y, z) = (x, z, -y), recentred near the origin.
- Each texture becomes a glTF material (alpha textures use alpha test). Foliage textures are
  visual only; everything else collides. Output format matches convert_unity_map.py, but with
  per-material textures embedded in the glb (no shared atlas).
"""
import sys, os, json, glob, re
import numpy as np

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import rw
import maptools

map_id, src, out_dir = sys.argv[1:4]
cfg = json.load(open(os.path.join(HERE, 'gta_maps.json')))[map_id]
os.makedirs(out_dir, exist_ok=True)


def find(pattern):
    hits = [p for p in glob.glob(os.path.join(src, '**', '*'), recursive=True) if re.fullmatch(pattern, os.path.basename(p), re.I)]
    return hits


ipl = rw.read_ipl(open(find(r'.*\.ipl')[0], encoding='latin-1').read())
dffs = {os.path.basename(p)[:-4].lower(): p for p in find(r'.*\.dff')}
textures = {}
for p in find(r'.*\.txd'):
    textures.update(rw.read_txd(open(p, 'rb').read(), max_size=512))
print('instances', len(ipl), 'models', len(dffs), 'textures', len(textures))


def qmat(x, y, z, w):
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def classify(tex):
    t = (tex or '').lower()
    for rule in cfg['surfaces']:
        if re.search(rule['match'], t):
            return rule['surface']
    return cfg.get('defaultSurface', 2)


foliage_re = re.compile(cfg['foliage'], re.I)
decal_re = re.compile(cfg.get('decals', '^$'), re.I)
mat_index, materials = {}, []
P, UV, IDX, TS, TM, TC = [], [], [], [], [], []
voff = 0
cache = {}
for inst in ipl:
    name = inst['model'].lower()
    if inst['lod'] != -1 and name.startswith('lod'):
        continue
    if name not in cache:
        cache[name] = rw.read_dff(open(dffs[name], 'rb').read())[0]
    cl = cache[name]
    x, y, z, w = inst['rot']
    R = qmat(-x, -y, -z, w)
    T = np.array(inst['pos'])
    for fi, gi in cl['atomics']:
        g = cl['geometries'][gi]
        fw = cl['frames'][fi].world
        p = (g.pos @ fw[:3, :3].T + fw[:3, 3]) @ R.T + T
        tri, mat = rw.triangles(g)
        uv = g.uv if g.uv is not None else np.zeros((len(p), 2), np.float32)
        for m in np.unique(mat):
            mm = g.materials[m]
            tex = (mm['texture'] or '').lower()
            key = tex or f"color_{mm['color']}"
            if key not in mat_index:
                img = textures.get(tex)
                has_alpha = img is not None and img.getextrema()[3][0] < 250
                if has_alpha:
                    img = rw.bleed_alpha(img)
                mat_index[key] = len(materials)
                materials.append({
                    # GTA multiplies the texture by the material colour (usually light grey).
                    'name': key, 'image': img, 'color': mm['color'][:3] + [255],
                    'alpha': 'MASK' if has_alpha else 'OPAQUE', 'doubleSided': True,
                    'extras': {'decal': bool(decal_re.search(tex))} if decal_re.search(tex) else None,
                })
            sel = mat == m
            IDX.append(tri[sel] + voff)
            TM.append(np.full(sel.sum(), mat_index[key]))
            TS.append(np.full(sel.sum(), classify(tex), np.uint8))
            TC.append(np.full(sel.sum(), not foliage_re.search(tex) and not decal_re.search(tex)))
        P.append(p); UV.append(uv); voff += len(p)

pos = np.concatenate(P); uv = np.concatenate(UV).astype(np.float32); idx = np.concatenate(IDX)
tmat = np.concatenate(TM); tsurf = np.concatenate(TS); tcol = np.concatenate(TC)
pos = np.stack([pos[:, 0], pos[:, 2], -pos[:, 1]], 1)
centre = np.array([(pos[:, 0].min() + pos[:, 0].max()) / 2, 0, (pos[:, 2].min() + pos[:, 2].max()) / 2]).round()
pos = pos - centre
# drop degenerate triangles (strip leftovers)
t = pos[idx]
area = np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)
keep = area > 1e-8
idx, tmat, tsurf, tcol = idx[keep], tmat[keep], tsurf[keep], tcol[keep]
nrm = maptools.smooth_normals(pos, idx)
print('triangles', len(idx), 'materials', len(materials), 'collidable', int(tcol.sum()), 'bounds', pos.min(0).round(), pos.max(0).round())

maptools.write_tiled_glb(os.path.join(out_dir, f'{map_id}.raw.glb'), pos, nrm, uv, idx, tsurf, tmat, tcol, materials, float(cfg.get('tile', 400)))
spawns, length = maptools.find_spawns(pos, idx, tsurf, tcol, cfg.get('heightSplit', 80))
meta = {'spawns': spawns, 'bounds': [pos.min(0).round(1).tolist(), pos.max(0).round(1).tolist()], 'roadLength': length, 'origin': (-centre).tolist()}
json.dump(meta, open(os.path.join(out_dir, f'{map_id}.json'), 'w'), indent=1)
print(json.dumps(spawns))
