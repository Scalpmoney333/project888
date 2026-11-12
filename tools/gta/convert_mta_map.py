"""Convert a GTA San Andreas MTA (Multi Theft Auto) map resource into game assets.

Usage: python tools/gta/convert_mta_map.py <map id> <resource folder (with .map, client .lua, dff/txd)> <out dir>
Config: tools/gta/gta_maps.json (surface, foliage, decal and optional noCollide classification
by texture name).

Same output contract as convert_gta_map.py; only the instance list differs:
- Placements come from the .map XML (<object model posX posY posZ rotX rotY rotZ scale collisions>).
- Model ids map to custom DFFs through the client script's engineLoadDFF / engineReplaceModel calls;
  objects whose model is not replaced are base-game SA models that the mod does not ship (skipped).
- MTA object rotations are Euler degrees applied Z, then X, then Y (R = Rz Rx Ry). Usui only has
  zero rotations, so this convention is not verified against real data yet.
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
    return [p for p in glob.glob(os.path.join(src, '**', '*'), recursive=True) if re.fullmatch(pattern, os.path.basename(p), re.I)]


def read_mta(src):
    files = {os.path.basename(p).lower(): p for p in find(r'.*\.(dff|txd)')}
    model_dff = {}
    for lua in find(r'.*\.lua'):
        text = open(lua, encoding='latin-1').read()
        loads = dict(re.findall(r"""(\w+)\s*=\s*engineLoadDFF\s*\(\s*['"]([^'"]+)['"]""", text))
        for var, mid in re.findall(r'engineReplaceModel\s*\(\s*(\w+)\s*,\s*(\d+)', text):
            if var in loads:
                model_dff[int(mid)] = loads[var]
    instances, skipped = [], {}
    for mp in find(r'.*\.map'):
        for tag in re.findall(r'<object\b[^>]*>', open(mp, encoding='latin-1').read()):
            a = dict(re.findall(r'(\w+)="([^"]*)"', tag))
            mid = int(a['model'])
            dff = model_dff.get(mid)
            if dff is None or dff.lower() not in files:
                skipped[mid] = skipped.get(mid, 0) + 1
                continue
            instances.append({
                'model': dff.lower(), 'id': a.get('id', ''),
                'pos': [float(a['posX']), float(a['posY']), float(a['posZ'])],
                'rot': [float(a.get(k, 0)) for k in ('rotX', 'rotY', 'rotZ')],
                'scale': float(a.get('scale', 1)),
                'collide': a.get('collisions', 'true') != 'false',
            })
    textures = {}
    for name, p in files.items():
        if name.endswith('.txd'):
            textures.update(rw.read_txd(open(p, 'rb').read(), max_size=512))
    return instances, {k: files[k] for k in files if k.endswith('.dff')}, textures, skipped


def euler_zxy(rx, ry, rz):
    x, y, z = np.radians([rx, ry, rz])
    Rx = np.array([[1, 0, 0], [0, np.cos(x), -np.sin(x)], [0, np.sin(x), np.cos(x)]])
    Ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    Rz = np.array([[np.cos(z), -np.sin(z), 0], [np.sin(z), np.cos(z), 0], [0, 0, 1]])
    return Rz @ Rx @ Ry


instances, dffs, textures, skipped = read_mta(src)
print('instances', len(instances), 'models', len(dffs), 'textures', len(textures))
if skipped:
    print('skipped (base-game models not shipped):', json.dumps(skipped))


def classify(tex):
    t = (tex or '').lower()
    for rule in cfg['surfaces']:
        if re.search(rule['match'], t):
            return rule['surface']
    return cfg.get('defaultSurface', 2)


BOX_TRI = np.array([[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4],
                    [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]])


def boxify(pos, tri):
    """Replace every connected part with its PCA-oriented bounding box (12 triangles).

    For dense, tiny, flat-textured detail (guardrail brackets) that the map simplifier keeps whole.
    """
    lab = maptools.components(pos, tri)
    P, T = [], []
    for c in range(lab.max() + 1):
        v = pos[np.unique(tri[lab == c])]
        mid = v.mean(0)
        axes = np.linalg.svd(v - mid, full_matrices=False)[2] if len(v) > 2 else np.eye(3)
        if len(axes) < 3:
            axes = np.eye(3)
        local = (v - mid) @ axes.T
        lo, hi = local.min(0), local.max(0)
        corners = np.array([[(hi if i & 4 else lo)[0], (hi if i & 2 else lo)[1], (hi if i & 1 else lo)[2]] for i in range(8)])
        T.append(BOX_TRI + 8 * len(P)); P.append(corners @ axes + mid)
    return np.concatenate(P), np.concatenate(T)


foliage_re = re.compile(cfg['foliage'], re.I)
box_re = re.compile(cfg.get('boxify', '^$'), re.I)
decal_re = re.compile(cfg.get('decals', '^$'), re.I)
# Small solid detail (bolts, brackets) that is drawn but not worth colliding with.
nocol_re = re.compile(cfg.get('noCollide', '^$'), re.I)
mat_index, materials = {}, []
P, UV, IDX, TS, TM, TC = [], [], [], [], [], []
voff = 0
cache = {}


def add(t, key, tex, inst):
    IDX.append(t)
    TM.append(np.full(len(t), mat_index[key]))
    TS.append(np.full(len(t), classify(tex), np.uint8))
    TC.append(np.full(len(t), inst['collide'] and not foliage_re.search(tex) and not decal_re.search(tex) and not nocol_re.search(tex)))


for inst in instances:
    name = inst['model']
    if name not in cache:
        cache[name] = rw.read_dff(open(dffs[name], 'rb').read())[0]
    cl = cache[name]
    R = euler_zxy(*inst['rot']) * inst['scale']
    T = np.array(inst['pos'])
    for fi, gi in cl['atomics']:
        g = cl['geometries'][gi]
        fw = cl['frames'][fi].world
        p = (g.pos @ fw[:3, :3].T + fw[:3, 3]) @ R.T + T
        tri, mat = rw.triangles(g)
        uv = g.uv if g.uv is not None else np.zeros((len(p), 2), np.float32)
        extra = []
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
                    'extras': {'decal': True} if decal_re.search(tex) else None,
                })
            sel = mat == m
            if box_re.search(tex):
                extra.append((*boxify(p, tri[sel]), key, tex))
                continue
            add(tri[sel] + voff, key, tex, inst)
        P.append(p); UV.append(uv); voff += len(p)
        for bp, bt, key, tex in extra:
            add(bt + voff, key, tex, inst)
            P.append(bp); UV.append(np.full((len(bp), 2), 0.5, np.float32)); voff += len(bp)

pos = np.concatenate(P); uv = np.concatenate(UV).astype(np.float32); idx = np.concatenate(IDX)
tmat = np.concatenate(TM); tsurf = np.concatenate(TS); tcol = np.concatenate(TC)
pos = np.stack([pos[:, 0], pos[:, 2], -pos[:, 1]], 1)
centre = np.array([(pos[:, 0].min() + pos[:, 0].max()) / 2, 0, (pos[:, 2].min() + pos[:, 2].max()) / 2]).round()
pos = pos - centre
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
