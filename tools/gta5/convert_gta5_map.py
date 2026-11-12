"""Convert a GTA V map mod (loose RSC7: .ydr drawables, .ytd textures, .ymap placements) into the
same raw GLB + JSON as tools/gta/convert_gta_map.py.

Usage: python tools/gta5/convert_gta5_map.py <map id> <mod folder> <out dir>
Config: tools/gta5/gta5_maps.json (surface / foliage / decal classification by texture name).

- Drawable = archetype: entity archetype hash == joaat(lowercase ydr file name). Highest LOD only.
  Entities whose archetype has no .ydr (vanilla props, trees) are skipped and reported.
- Entity rotation quaternions are conjugated like SA IPLs unless config "conjugate" is false.
- GTA V is Z-up: glTF (x, y, z) = (x, z, -y), recentred like convert_gta_map.py.
"""
import sys, os, json, glob, re
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE)))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'gta'))
import rsc
import rw
import maptools

map_id, src, out_dir = sys.argv[1:4]
cfg = json.load(open(os.path.join(HERE, 'gta5_maps.json')))[map_id]
os.makedirs(out_dir, exist_ok=True)
src = os.path.join(src, cfg['source']) if os.path.isdir(os.path.join(src, cfg['source'])) else src


def files(ext):
    return sorted(p for p in glob.glob(os.path.join(src, '**', '*'), recursive=True) if p.lower().endswith(ext))


textures = {}
for p in files('.ytd'):
    textures.update(rsc.read_ytd(p, cfg.get('maxTexture', 512)))
drawables = {rsc.joaat(os.path.basename(p)[:-4]): os.path.basename(p)[:-4] for p in files('.ydr')}
paths = {rsc.joaat(os.path.basename(p)[:-4]): p for p in files('.ydr')}
ents = []
for p in files('.ymap'):
    ents += rsc.read_entities(p)
print('textures', len(textures), 'drawables', len(drawables), 'entities', len(ents))

# Drawables without any placement are placed like the entity of the drawable named in "alsoPlaceAs".
placed = {e['arch'] for e in ents}
for name, like in cfg.get('alsoPlaceAs', {}).items():
    h = rsc.joaat(name)
    if h in drawables and h not in placed:
        for e in [e for e in ents if e['arch'] == rsc.joaat(like)]:
            ents.append(dict(e, arch=h))

DIFFUSE = rsc.joaat('diffusesampler')


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
mat_index, materials = {}, []
P, UV, IDX, TS, TM, TC = [], [], [], [], [], []
voff = 0
cache, skipped, per_drawable = {}, {}, {}
for e in ents:
    h = e['arch']
    if h not in drawables:
        skipped[h] = skipped.get(h, 0) + 1
        continue
    if h not in cache:
        cache[h] = rsc.read_ydr(paths[h])
    x, y, z, w = e['rot']
    R = qmat(-x, -y, -z, w) if cfg.get('conjugate', True) else qmat(x, y, z, w)
    R = R * np.array([e['sxy'], e['sxy'], e['sz']])
    T = np.array(e['pos'])
    for g in cache[h]:
        p = g['pos'].astype(np.float64) @ R.T + T
        tex = g['shader']['textures'].get(DIFFUSE, '')
        uv = g['uv'][:, :2] if g['uv'] is not None else np.zeros((len(p), 2), np.float32)
        key = tex or f"color_{g['shader']['file']:x}"
        if key not in mat_index:
            img = textures.get(tex)
            has_alpha = img is not None and img.getextrema()[3][0] < 250
            if has_alpha:
                img = rw.bleed_alpha(img)
            mat_index[key] = len(materials)
            materials.append({'name': key, 'image': img, 'color': [255, 255, 255, 255],
                              'alpha': 'MASK' if has_alpha else 'OPAQUE', 'doubleSided': True,
                              'extras': {'decal': True} if decal_re.search(tex) else None})
        tri = g['idx']
        IDX.append(tri + voff)
        TM.append(np.full(len(tri), mat_index[key]))
        TS.append(np.full(len(tri), classify(tex), np.uint8))
        TC.append(np.full(len(tri), not foliage_re.search(tex) and not decal_re.search(tex)))
        per_drawable[drawables[h]] = per_drawable.get(drawables[h], 0) + len(tri)
        P.append(p); UV.append(uv); voff += len(p)

pos = np.concatenate(P); uv = np.concatenate(UV).astype(np.float32); idx = np.concatenate(IDX)
tmat = np.concatenate(TM); tsurf = np.concatenate(TS); tcol = np.concatenate(TC)
pos = np.stack([pos[:, 0], pos[:, 2], -pos[:, 1]], 1)
centre = np.array([(pos[:, 0].min() + pos[:, 0].max()) / 2, 0, (pos[:, 2].min() + pos[:, 2].max()) / 2]).round()
pos = pos - centre
t = pos[idx]
area = np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)
keep = area > 1e-8
idx, tmat, tsurf, tcol = idx[keep], tmat[keep], tsurf[keep], tcol[keep]

rng = np.random.default_rng(1234)
for rule in cfg.get('thin', []):
    rx = re.compile(rule['match'], re.I)
    mids = [i for i, m in enumerate(materials) if rx.search(m['name'])]
    sel = np.where(np.isin(tmat, mids))[0]
    if not len(sel):
        continue
    lab = np.arange(len(sel)) // 2 if rule.get('unit') == 'quad' else maptools.components(pos, idx[sel])
    keep_lab = rng.random(lab.max() + 1) < rule['keep']
    drop = sel[~keep_lab[lab]]
    mask = np.ones(len(idx), bool); mask[drop] = False
    idx, tmat, tsurf, tcol = idx[mask], tmat[mask], tsurf[mask], tcol[mask]
    print(f"thin {rule['match']}: {lab.max() + 1} pieces, kept {rule['keep']:.0%}, removed {len(drop)} tris")

nrm = maptools.smooth_normals(pos, idx)
print('triangles per drawable (before degenerate/thin)', per_drawable)
print('skipped archetypes (hash: entities)', {hex(k): v for k, v in skipped.items()})
print('materials', [(m['name'], m['alpha']) for m in materials])
print('triangles', len(idx), 'materials', len(materials), 'collidable', int(tcol.sum()), 'bounds', pos.min(0).round(), pos.max(0).round())

maptools.write_tiled_glb(os.path.join(out_dir, f'{map_id}.raw.glb'), pos, nrm, uv, idx, tsurf, tmat, tcol, materials, float(cfg.get('tile', 400)))
spawns, length = maptools.find_spawns(pos, idx, tsurf, tcol, cfg.get('heightSplit', 80))
meta = {'spawns': spawns, 'bounds': [pos.min(0).round(1).tolist(), pos.max(0).round(1).tolist()], 'roadLength': length, 'origin': (-centre).tolist()}
json.dump(meta, open(os.path.join(out_dir, f'{map_id}.json'), 'w'), indent=1)
print(json.dumps(spawns))
np.savez(os.path.join(out_dir, f'{map_id}_debug.npz'), pos=pos, idx=idx, tsurf=tsurf, tcol=tcol, tmat=tmat)
