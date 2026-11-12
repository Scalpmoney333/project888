"""Convert a GTA V map mod (loose YDR + YTD + YMAP resources) into game assets.

Usage: python tools/gtav/convert_gtav_map.py <map id> <mod folder (loose .ydr/.ytd/.ymap)> <out dir>
       node tools/compress-glb.mjs <out dir>/<map id>.raw.glb public/assets/maps/<map id>.glb
Config: tools/gtav/gtav_maps.json. Requires numpy, scipy, pillow, texture2ddecoder.

- Drawables are placed by the CEntityDef records of the configured ymaps (archetype name = file
  name); drawables without a placement are not part of the map in game and are skipped.
- Only the highest LOD is converted. GTA is Z-up right-handed: glTF (x, y, z) = (x, z, -y),
  recentred near the origin (same as convert_gta_map.py).
- One glTF material per diffuse texture. 'default' shaders are opaque in game even when the
  texture has alpha; 'decal' shaders (render bucket 2) use alpha test, and their geometry is
  visual-only and flagged as decal so the loader applies polygon offset.
- Surfaces come from texture-name rules; everything except decals and `visualOnly` collides.
- Spawns: config `spawns` give GTA world XY points ("at" and a point "toward" which the car
  faces); height is taken from the highest collidable road surface there. Without them,
  maptools.find_spawns picks two points on the longest road.
"""
import sys, os, json, glob, re
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import rsc
import maptools
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "gta"))
import rw  # noqa: E402  (bleed_alpha from the SA converter)

map_id, src, out_dir = sys.argv[1:4]
cfg = json.load(open(os.path.join(HERE, 'gtav_maps.json')))[map_id]
os.makedirs(out_dir, exist_ok=True)
files = {os.path.basename(p).lower(): p for p in glob.glob(os.path.join(src, '**', '*'), recursive=True)}
ydrs = {k[:-4]: p for k, p in files.items() if k.endswith('.ydr')}

textures = {}
for name in cfg['ytds']:
    textures.update(rsc.read_ytd(open(files[name.lower()], 'rb').read(), cfg.get('maxTexture', 512)))
entities = []
for name in cfg['ymaps']:
    entities += rsc.read_ymap_entities(open(files[name.lower()], 'rb').read(), list(ydrs))
print('entities', len(entities), 'drawables', len(ydrs), 'textures', len(textures))
print('unplaced drawables (skipped):', sorted(set(ydrs) - {e['name'].lower() for e in entities}))


def qmat(x, y, z, w):
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def classify(tex):
    for rule in cfg['surfaces']:
        if re.search(rule['match'], tex or ''):
            return rule['surface']
    return cfg.get('defaultSurface', 2)


def preblend(img, blend):
    """The loader only alpha-tests, so soft alpha-blended decals (skidmarks) would render as hard
    black shapes. Bake the blend over the mean colour of the surface beneath, then alpha-test
    at a low cutoff."""
    from PIL import Image
    under = np.asarray(textures[blend['over']].convert('RGB'), np.float32).reshape(-1, 3).mean(0)
    a = np.asarray(img.getchannel('A'), np.float32)[..., None] / 255
    rgb = np.asarray(img.convert('RGB'), np.float32)
    out = Image.fromarray(np.clip(under * (1 - a) + rgb * a, 0, 255).astype(np.uint8), 'RGB')
    out.putalpha(Image.fromarray(np.where(a[..., 0] > blend['cutoff'], 255, 0).astype(np.uint8)))
    return out


visual_re = re.compile(cfg.get('visualOnly', '^$'), re.I)
mat_index, materials = {}, []
P, UV, IDX, TS, TM, TC = [], [], [], [], [], []
voff = 0
cache = {}
for ent in entities:
    name = ent['name'].lower()
    if name not in cache:
        cache[name] = rsc.read_ydr(open(ydrs[name], 'rb').read())
    d = cache[name]
    textures.update({k: v for k, v in d['embedded'].items() if k not in textures})
    # Top-level ymap entities store the inverse rotation (as CodeWalker inverts it); identity here.
    x, y, z, w = ent['rot']
    R = qmat(-x, -y, -z, w) * np.array(ent['scale'])[None, :]
    T = np.array(ent['pos'])
    for g in d['geometries']:
        sh = d['shaders'][g['shader']]
        tex = rsc.diffuse_of(sh) or ''
        decal = sh['hash'] == rsc.joaat('decal')
        p = g['pos'] @ R.T + T
        key = f'{tex}|{"decal" if decal else "opaque"}'
        if key not in mat_index:
            img = textures.get(tex)
            if img is None:
                print('missing texture', tex)
            has_alpha = decal and img is not None and img.getextrema()[3][0] < 250
            if has_alpha:
                img = rw.bleed_alpha(img)
                blend = cfg.get('preblend')
                if blend and re.search(blend['match'], tex):
                    img = preblend(img, blend)
            mat_index[key] = len(materials)
            materials.append({'name': tex or 'untextured', 'image': img, 'color': [255, 255, 255, 255],
                              'alpha': 'MASK' if has_alpha else 'OPAQUE', 'doubleSided': True,
                              'extras': {'decal': True} if decal else None})
        n = len(g['idx'])
        IDX.append(g['idx'] + voff)
        TM.append(np.full(n, mat_index[key]))
        TS.append(np.full(n, classify(tex), np.uint8))
        TC.append(np.full(n, not decal and not visual_re.search(tex)))
        UV.append(g['uv'] if g['uv'] is not None else np.zeros((len(p), 2), np.float32))
        P.append(p); voff += len(p)

pos = np.concatenate(P); uv = np.concatenate(UV).astype(np.float32); idx = np.concatenate(IDX)
tmat = np.concatenate(TM); tsurf = np.concatenate(TS); tcol = np.concatenate(TC)
gta_pos = pos
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


def road_height(x, z):
    """Highest collidable road-surface point under glTF (x, z), or None."""
    road = tcol & np.isin(tsurf, list(maptools.ROAD_SURFACES))
    tp = pos[idx[road]]
    a, b, c = tp[:, 0], tp[:, 1], tp[:, 2]
    den = (b[:, 2] - c[:, 2]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 2] - c[:, 2])
    ok = np.abs(den) > 1e-9
    den = np.where(ok, den, 1)
    l1 = ((b[:, 2] - c[:, 2]) * (x - c[:, 0]) + (c[:, 0] - b[:, 0]) * (z - c[:, 2])) / den
    l2 = ((c[:, 2] - a[:, 2]) * (x - c[:, 0]) + (a[:, 0] - c[:, 0]) * (z - c[:, 2])) / den
    l3 = 1 - l1 - l2
    hit = ok & (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
    if not hit.any():
        return None
    return float((l1 * a[:, 1] + l2 * b[:, 1] + l3 * c[:, 1])[hit].max())


if cfg.get('spawns'):
    spawns = []
    for s in cfg['spawns']:
        (ax, ay), (bx, by) = s['at'], s['toward']
        x, z = ax - centre[0], -ay - centre[2]
        y = road_height(x, z)
        if y is None:
            raise SystemExit(f'spawn {s["id"]} is not above the road')
        yaw = float(np.arctan2(bx - ax, -(by - ay)))
        spawns.append({'id': s['id'], 'name': s['name'], 'position': [round(x, 2), round(y, 2), round(z, 2)], 'yaw': round(yaw, 4)})
    _, length = maptools.find_spawns(pos, idx, tsurf, tcol, cfg.get('heightSplit', 80))
else:
    spawns, length = maptools.find_spawns(pos, idx, tsurf, tcol, cfg.get('heightSplit', 80))
meta = {'spawns': spawns, 'bounds': [pos.min(0).round(1).tolist(), pos.max(0).round(1).tolist()], 'roadLength': length, 'origin': (-centre).tolist()}
json.dump(meta, open(os.path.join(out_dir, f'{map_id}.json'), 'w'), indent=1)
print(json.dumps(spawns))
