"""Convert a GTA IV map mod (IMG v3 archives + IDE + binary WPL) into game assets.

Usage: python tools/gta4/convert_gta4_map.py <map id> <mod folder (with *.img/*.ide/*.wpl)> <out dir>
Config: tools/gta4/gta4_maps.json (surface, foliage and decal classification by texture name).
Then: node tools/compress-glb.mjs <out dir>/<map id>.raw.glb public/assets/maps/<map id>.glb

- IMG archives are not opened through their (encrypted) table of contents: rage.py scans them
  for RSC5 resources, so no game key is needed. Drawables (WDR) are matched to WPL instances
  by the model-name hash; texture dictionaries (WTD) from all archives are pooled.
- Only the highest LOD of each drawable is used.
- GTA is Z-up right-handed: glTF (x, y, z) = (x, z, -y), recentred near the origin.
- Output format matches tools/gta/convert_gta_map.py (per-texture materials embedded in the glb,
  'col_*' tiles collide, '_SURFACE' grip class per vertex, foliage/decals visual only).
"""
import sys, os, json, glob, re, struct
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'gta'))
import rage
import maptools
import rw  # SA helpers (alpha bleeding)

map_id, src, out_dir = sys.argv[1:4]
cfg = json.load(open(os.path.join(HERE, 'gta4_maps.json')))[map_id]
os.makedirs(out_dir, exist_ok=True)


def find(ext):
    return sorted(p for p in glob.glob(os.path.join(src, '**', '*'), recursive=True) if p.lower().endswith(ext))


def joaat(s):
    h = 0
    for c in s.lower().encode():
        h = (h + c) & 0xFFFFFFFF; h = (h + (h << 10)) & 0xFFFFFFFF; h ^= h >> 6
    h = (h + (h << 3)) & 0xFFFFFFFF; h ^= h >> 11
    return (h + (h << 15)) & 0xFFFFFFFF


def read_wpl(data):
    """Binary IV IPL: u32 version, 16 u32 section counts, then 48-byte instances
    (pos xyz, quat xyzw, model hash, flags, lod index, unk, lod distance)."""
    n = struct.unpack_from('<I', data, 4)[0]
    out = []
    for i in range(n):
        f = struct.unpack_from('<7fIIiIf', data, 0x44 + 48 * i)
        out.append({'pos': f[0:3], 'rot': f[3:7], 'hash': f[7], 'lod': f[9]})
    return out


drawables, textures = {}, {}
for p in find('.img'):
    for off, typ, s, g in rage.scan_img(open(p, 'rb').read()):
        if typ == 110:
            # One drawable per archive in these mods; it is named after the archive/IDE entry.
            drawables[joaat(os.path.basename(p)[:-4])] = (os.path.basename(p)[:-4].lower(), rage.read_drawable(s, g))
        elif typ == 8:
            textures.update(rage.read_wtd(s, g, max_size=512))
instances = [i for p in find('.wpl') for i in read_wpl(open(p, 'rb').read())]
print('instances', len(instances), 'drawables', [v[0] for v in drawables.values()], 'textures', len(textures))


def qmat(x, y, z, w):
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def classify(tex):
    for rule in cfg['surfaces']:
        if re.search(rule['match'], tex):
            return rule['surface']
    return cfg.get('defaultSurface', 2)


foliage_re = re.compile(cfg['foliage'], re.I)
decal_re = re.compile(cfg.get('decals', '^$'), re.I)
spawn_re = re.compile(cfg.get('spawnRoad', '.'), re.I)
mat_index, materials = {}, []
P, N, UV, IDX, TS, TM, TC, TR = [], [], [], [], [], [], [], []
voff = 0
for inst in instances:
    if inst['hash'] not in drawables:
        print('missing drawable for hash', hex(inst['hash']))
        continue
    name, dr = drawables[inst['hash']]
    x, y, z, w = inst['rot']
    # Same convention as the SA converter (conjugated); the shipped instances are all identity.
    R = qmat(-x, -y, -z, w)
    T = np.array(inst['pos'])
    for geom in dr['lods'][0]:
        tex = next(iter(dr['shaders'][geom['shader']]['textures'].values()), '')
        v = geom['v']
        p = v['pos'].astype(np.float64) @ R.T + T
        n = v['normal'].astype(np.float64) @ R.T if 'normal' in v else np.zeros_like(p)
        uv = v.get('uv0', np.zeros((len(p), 2), np.float32))
        tri = geom['idx']
        if tex not in mat_index:
            img = textures.get(tex)
            if img is None:
                print('missing texture', tex)
            has_alpha = img is not None and img.getextrema()[3][0] < 128
            if has_alpha:
                img = rw.bleed_alpha(img)
            elif img is not None:
                img = img.convert('RGB')
            mat_index[tex] = len(materials)
            materials.append({'name': tex, 'image': img, 'color': [255, 255, 255, 255],
                              'alpha': 'MASK' if has_alpha else 'OPAQUE', 'doubleSided': True,
                              'extras': {'decal': True} if decal_re.search(tex) else None})
        k = len(tri)
        IDX.append(tri + voff)
        TM.append(np.full(k, mat_index[tex]))
        TS.append(np.full(k, classify(tex), np.uint8))
        TC.append(np.full(k, not foliage_re.search(tex) and not decal_re.search(tex)))
        TR.append(np.full(k, bool(spawn_re.search(tex))))
        P.append(p); N.append(n); UV.append(uv); voff += len(p)

pos = np.concatenate(P); nrm = np.concatenate(N); uv = np.concatenate(UV).astype(np.float32); idx = np.concatenate(IDX)
tmat = np.concatenate(TM); tsurf = np.concatenate(TS); tcol = np.concatenate(TC); troad = np.concatenate(TR)
pos = np.stack([pos[:, 0], pos[:, 2], -pos[:, 1]], 1)
nrm = np.stack([nrm[:, 0], nrm[:, 2], -nrm[:, 1]], 1)
centre = np.array([(pos[:, 0].min() + pos[:, 0].max()) / 2, 0, (pos[:, 2].min() + pos[:, 2].max()) / 2]).round()
pos = pos - centre
t = pos[idx]
area = np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)
keep = area > 1e-8
idx, tmat, tsurf, tcol, troad = idx[keep], tmat[keep], tsurf[keep], tcol[keep], troad[keep]
# Prefer the authored normals; fall back to smooth normals where a geometry has none.
ln = np.linalg.norm(nrm, axis=1)
bad = ln < 0.5
if bad.any():
    nrm[bad] = maptools.smooth_normals(pos, idx)[bad]
nrm = nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
print('triangles', len(idx), 'materials', len(materials), 'collidable', int(tcol.sum()), 'bounds', pos.min(0).round(), pos.max(0).round())
for m in materials:
    sel = tmat == mat_index[m['name']]
    print(f"  {m['name']:28s} tris {int(sel.sum()):6d} surface {int(tsurf[sel][0]) if sel.any() else -1} "
          f"{'collide' if sel.any() and tcol[sel][0] else 'visual'} {m['alpha']} {m['image'].size if m['image'] else None}")

maptools.write_tiled_glb(os.path.join(out_dir, f'{map_id}.raw.glb'), pos, nrm, uv, idx, tsurf, tmat, tcol, materials, float(cfg.get('tile', 400)))
# Spawns only on the course tarmac (not the paddock/pit areas, which share the road surface class).
spawn_surf = np.where(troad, tsurf, 2).astype(np.uint8)
spawns, length = maptools.find_spawns(pos, idx, spawn_surf, tcol, cfg.get('heightSplit', 80))


def snap_spawn(hint):
    """Place a spawn on the course tarmac nearest to hint['near'] ([x, z] in output coordinates),
    centred across the road and facing along it towards hint['toward']."""
    tp = pos[idx]
    cent = tp.mean(1)
    gn = np.cross(tp[:, 1] - tp[:, 0], tp[:, 2] - tp[:, 0])
    up = np.abs(gn[:, 1]) / np.maximum(np.linalg.norm(gn, axis=1), 1e-9)
    road = troad & tcol & (up > 0.85)
    rc = cent[road][:, [0, 2]]
    c = rc[np.argmin(np.linalg.norm(rc - hint['near'], axis=1))]
    nb = rc[np.linalg.norm(rc - c, axis=1) < 15]
    m = nb.mean(0)
    axis = np.linalg.svd(nb - m)[2][0]
    if np.dot(axis, np.array(hint['toward']) - c) < 0:
        axis = -axis
    side = np.array([-axis[1], axis[0]])
    c = c + side * np.dot(m - c, side)  # recentre across the road
    # surface height under c: highest course triangle containing it
    a, b, d = tp[road][:, 0][:, [0, 2]], tp[road][:, 1][:, [0, 2]], tp[road][:, 2][:, [0, 2]]
    den = (b[:, 1] - d[:, 1]) * (a[:, 0] - d[:, 0]) + (d[:, 0] - b[:, 0]) * (a[:, 1] - d[:, 1])
    l1 = ((b[:, 1] - d[:, 1]) * (c[0] - d[:, 0]) + (d[:, 0] - b[:, 0]) * (c[1] - d[:, 1])) / den
    l2 = ((d[:, 1] - a[:, 1]) * (c[0] - d[:, 0]) + (a[:, 0] - d[:, 0]) * (c[1] - d[:, 1])) / den
    l3 = 1 - l1 - l2
    inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
    ys = (l1 * tp[road][:, 0, 1] + l2 * tp[road][:, 1, 1] + l3 * tp[road][:, 2, 1])[inside]
    y = float(ys.max()) if len(ys) else float(tp[road][np.argmin(np.linalg.norm(rc - c, axis=1))][:, 1].mean())
    return {'id': hint['id'], 'name': hint['name'], 'position': [round(float(c[0]), 2), round(y, 2), round(float(c[1]), 2)],
            'yaw': round(float(np.arctan2(axis[0], axis[1])), 4)}


if cfg.get('spawns'):
    spawns = [snap_spawn(h) for h in cfg['spawns']]
meta = {'spawns': spawns, 'bounds': [pos.min(0).round(1).tolist(), pos.max(0).round(1).tolist()], 'roadLength': length, 'origin': (-centre).tolist()}
json.dump(meta, open(os.path.join(out_dir, f'{map_id}.json'), 'w'), indent=1)
print(json.dumps(spawns))
