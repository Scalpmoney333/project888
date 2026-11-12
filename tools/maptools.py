"""Shared helpers for the map converters (Unity map mods and GTA SA maps).

All geometry here is already in glTF axes (Y up, metres). Triangles carry a surface id
(grip class), a material index and a collide flag.
"""
import io, json, struct, heapq
import numpy as np
from PIL import Image

ROAD_SURFACES = {0, 6}


# ------------------------------------------------------------------ connected components
def components(pos, idx):
    """Component label per triangle (vertices welded by position, 1 mm)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    q = np.round(pos * 1000).astype(np.int64)
    _, weld = np.unique(q, axis=0, return_inverse=True)
    weld = weld.ravel()
    t = weld[idx]
    n = weld.max() + 1
    rows = np.concatenate([t[:, 0], t[:, 1]])
    cols = np.concatenate([t[:, 1], t[:, 2]])
    g = coo_matrix((np.ones(len(rows), np.int8), (rows, cols)), shape=(n, n))
    _, lab = connected_components(g, directed=False)
    # compact labels to 0..k-1 over the given triangles only
    return np.unique(lab[t[:, 0]], return_inverse=True)[1].ravel()


# ------------------------------------------------------------------ ground height grid
class GroundGrid:
    """Per-cell list of ground heights (highest first) sampled from triangles."""
    def __init__(self, pos, idx, cell=1.0):
        self.c = cell
        t = pos[idx]
        pts = np.concatenate([t.mean(1), (t[:, 0] + t[:, 1]) / 2, (t[:, 1] + t[:, 2]) / 2, (t[:, 0] + t[:, 2]) / 2, pos[np.unique(idx)]])
        cx = np.floor(pts[:, 0] / cell).astype(np.int64)
        cz = np.floor(pts[:, 2] / cell).astype(np.int64)
        self.key = cx * 2000003 + cz
        order = np.lexsort((pts[:, 1], self.key))
        self.k = self.key[order]
        self.y = pts[order, 1]

    def below(self, x, z, y, margin=0.5):
        """Highest ground height at or below y + margin in the cell of (x, z); NaN if none."""
        k = np.floor(x / self.c).astype(np.int64) * 2000003 + np.floor(z / self.c).astype(np.int64)
        lo = np.searchsorted(self.k, k, 'left')
        hi = np.searchsorted(self.k, k, 'right')
        out = np.full(len(k), np.nan)
        for i in range(len(k)):
            if hi[i] > lo[i]:
                ys = self.y[lo[i]:hi[i]]
                ok = ys[ys <= y[i] + margin]
                if len(ok):
                    out[i] = ok[-1]
        return out


def drop_lifted_objects(pos, idx, scenery_mask, ground_mask, dy, label=''):
    """Fix objects that a map mod stores `-dy` metres too high.

    Each connected component of the scenery triangles is either a ground-like surface (kept)
    or an object. An object is moved by dy when that brings its lowest point closer to the
    ground beneath it (objects with no ground under them are moved too, the offset being
    systematic). Returns the new vertex positions (vertices are duplicated where needed).
    """
    pos = pos.copy()
    sidx = np.where(scenery_mask)[0]
    lab = components(pos, idx[sidx])
    t = pos[idx[sidx]]
    nrm = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    area = np.linalg.norm(nrm, axis=1) / 2
    up = np.abs(nrm[:, 1]) / np.maximum(2 * area, 1e-9)
    nlab = lab.max() + 1
    a_tot = np.bincount(lab, area, nlab)
    a_up = np.bincount(lab, area * (up > 0.7), nlab)
    lo = np.full((nlab, 3), np.inf); hi = np.full((nlab, 3), -np.inf)
    for k in range(3):
        np.minimum.at(lo, lab, t[:, k, :]); np.maximum.at(hi, lab, t[:, k, :])
    ext = hi - lo
    groundlike = (a_up > 0.6 * np.maximum(a_tot, 1e-9)) & (ext[:, 0] * ext[:, 2] > 150)
    gmask = ground_mask.copy()
    gmask[sidx[groundlike[lab]]] = True
    grid = GroundGrid(pos, idx[gmask])
    # lowest vertex of each component
    flat = t.reshape(-1, 3)
    flab = np.repeat(lab, 3)
    order = np.lexsort((flat[:, 1], flab))
    first = np.unique(flab[order], return_index=True)[1]
    bottom = flat[order][first]
    g = grid.below(bottom[:, 0], bottom[:, 2], bottom[:, 1])
    gap = bottom[:, 1] - g
    move = ~groundlike & (np.isnan(gap) | (np.abs(gap + dy) < np.abs(gap)))
    if label:
        fin = gap[np.isfinite(gap)]
        print(label, 'gap stats: finite', len(fin), 'of', len(gap), 'pct', np.percentile(fin, [5, 25, 50, 75, 95]).round(2) if len(fin) else '-')
    tri_move = move[lab]
    vids = np.unique(idx[sidx[tri_move]])
    # vertices shared with triangles that stay put would drag them along: duplicate those
    keep_v = np.zeros(len(pos), bool)
    keep_v[idx[sidx[~tri_move]]] = True
    keep_v[idx[~scenery_mask]] = True
    shared = vids[keep_v[vids]]
    new_pos = [pos]
    remap = np.arange(len(pos))
    if len(shared):
        remap[shared] = np.arange(len(pos), len(pos) + len(shared))
        new_pos.append(pos[shared])
    pos = np.concatenate(new_pos)
    moved_tris = sidx[tri_move]
    idx[moved_tris] = remap[idx[moved_tris]]
    vmove = np.unique(idx[moved_tris])
    pos[vmove, 1] += dy
    print(f'{label} lifted-object fix: {int(move.sum())}/{nlab} components ({int(tri_move.sum())} tris) moved by {dy} m; '
          f'{int(groundlike.sum())} ground-like kept; median gap before {np.nanmedian(gap[move]):.2f} m')
    return pos, idx, remap


# ------------------------------------------------------------------ glTF writer
def write_tiled_glb(path, pos, nrm, uv, idx, tsurf, tmat, tcol, materials, tile):
    """Tiles of TILE metres, split by material and collide flag. Nodes 'col_*' collide.

    materials: list of dicts {name, image (PIL.Image | None), alpha: OPAQUE|MASK|BLEND,
    doubleSided, color [r,g,b,a]}.
    """
    tp = pos[idx]
    cent = tp.mean(1)
    tx = np.floor(cent[:, 0] / tile).astype(np.int64)
    tz = np.floor(cent[:, 2] / tile).astype(np.int64)
    nm = len(materials)
    keys = (((tx + 1000) * 2000 + (tz + 1000)) * nm + tmat) * 2 + tcol.astype(np.int64)
    order = np.argsort(keys, kind='stable')
    uk, starts = np.unique(keys[order], return_index=True)
    ends = list(starts[1:]) + [len(order)]
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
        a = {'bufferView': view(arr.tobytes(), target), 'componentType': comp, 'count': int(arr.shape[0]), 'type': typ}
        if minmax:
            a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
        accs.append(a)
        return len(accs) - 1

    for k, s0, e0 in zip(uk, starts, ends):
        sel = order[s0:e0]
        tris = idx[sel]
        vkey = tris.astype(np.int64) * 16 + tsurf[sel][:, None].astype(np.int64)
        used, inv = np.unique(vkey.ravel(), return_inverse=True)
        vid = (used // 16).astype(np.int64)
        prim = {'attributes': {
            'POSITION': acc(pos[vid].astype(np.float32), 34962, minmax=True),
            'NORMAL': acc(nrm[vid].astype(np.float32), 34962),
            'TEXCOORD_0': acc(uv[vid].astype(np.float32), 34962, typ='VEC2'),
            '_SURFACE': acc((used % 16).astype(np.float32), 34962, typ='SCALAR'),
        }, 'indices': acc(inv.astype(np.uint32), 34963, comp=5125, typ='SCALAR'), 'material': int((k // 2) % nm)}
        name = f"{'col' if k % 2 else 'vis'}_{len(nodes)}"
        meshes.append({'name': name, 'primitives': [prim]})
        nodes.append({'name': name, 'mesh': len(meshes) - 1})

    gmats, images, textures = [], [], []
    for m in materials:
        pbr = {'metallicFactor': 0, 'roughnessFactor': 1, 'baseColorFactor': [c / 255 for c in m.get('color', [255, 255, 255, 255])]}
        if m.get('image') is not None:
            buf = io.BytesIO()
            im = m['image']
            if m.get('alpha', 'OPAQUE') == 'OPAQUE':
                im.convert('RGB').save(buf, 'JPEG', quality=88); mime = 'image/jpeg'
            else:
                im.save(buf, 'PNG', optimize=True); mime = 'image/png'
            images.append({'bufferView': view(buf.getvalue()), 'mimeType': mime})
            textures.append({'source': len(images) - 1, 'sampler': 0})
            pbr['baseColorTexture'] = {'index': len(textures) - 1}
        gm = {'name': m['name'], 'doubleSided': m.get('doubleSided', True), 'pbrMetallicRoughness': pbr, 'alphaMode': m.get('alpha', 'OPAQUE')}
        if gm['alphaMode'] == 'MASK':
            gm['alphaCutoff'] = 0.5
        if m.get('extras'):
            gm['extras'] = m['extras']
        gmats.append(gm)
    gltf = {'asset': {'version': '2.0', 'generator': 'maptools.py'}, 'scene': 0,
            'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': meshes, 'materials': gmats,
            'buffers': [{'byteLength': off[0]}], 'bufferViews': views, 'accessors': accs}
    if images:
        gltf['images'] = images; gltf['textures'] = textures
        gltf['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
    js = json.dumps(gltf).encode(); js += b' ' * ((-len(js)) % 4)
    binb = b''.join(chunks)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binb)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(binb), 0x004E4942)); f.write(binb)
    print('tiles', len(nodes), 'tris', len(idx))


# ------------------------------------------------------------------ spawns
def find_spawns(pos, idx, tsurf, tcol, height_split=80):
    tp = pos[idx]
    cent = tp.mean(1)
    gn = np.cross(tp[:, 1] - tp[:, 0], tp[:, 2] - tp[:, 0])
    area = np.linalg.norm(gn, axis=1) / 2
    up = np.abs(gn[:, 1]) / np.maximum(2 * area, 1e-9)
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
                    if j is not None and j != i and abs(vpos[i][1] - vpos[j][1]) < 1.6:
                        adj[i].append((j, float(np.linalg.norm(vpos[i] - vpos[j]))))

    def dijkstra(src):
        dist = np.full(len(uniq), np.inf); dist[src] = 0; pq = [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u]:
                continue
            for v, w in adj[u]:
                if d + w < dist[v]:
                    dist[v] = d + w; heapq.heappush(pq, (d + w, v))
        return dist
    d0 = dijkstra(int(np.argmax(cnt)))
    reach = np.isfinite(d0)
    for seed in np.argsort(-cnt)[:20]:
        if reach.sum() >= len(uniq) * 0.3:
            break
        dd = dijkstra(int(seed))
        if np.isfinite(dd).sum() > reach.sum():
            d0, reach = dd, np.isfinite(dd)
    a = int(np.argmax(np.where(reach, d0, -1)))
    da = dijkstra(a)
    b = int(np.argmax(np.where(np.isfinite(da), da, -1)))
    db = dijkstra(b)
    print('road voxels', len(uniq), 'component', int(reach.sum()), 'longest road', round(float(da[b])), 'm')

    def spawn_at(dist):
        band = np.where((dist > 17) & (dist < 23))[0]
        ahead = np.where((dist > 37) & (dist < 43))[0]
        deg = np.array([len(adj[k]) for k in band])
        near = np.linalg.norm(vpos[band] - vpos[band].mean(0), axis=1)
        i = band[np.lexsort((near, -deg))[0]]
        j = ahead[np.argmin(np.linalg.norm(vpos[ahead] - vpos[ahead].mean(0), axis=1))]
        p, q = vpos[i], vpos[j]
        return [round(float(x), 2) for x in p], round(float(np.arctan2(q[0] - p[0], q[2] - p[2])), 4)
    pa, ya = spawn_at(da)
    pb, yb = spawn_at(db)
    if abs(pa[1] - pb[1]) > height_split:
        hi, lo = ((pa, ya), (pb, yb)) if pa[1] > pb[1] else ((pb, yb), (pa, ya))
        spawns = [{'id': 'downhill', 'name': 'Downhill', 'position': hi[0], 'yaw': hi[1]},
                  {'id': 'uphill', 'name': 'Uphill', 'position': lo[0], 'yaw': lo[1]}]
    else:
        spawns = [{'id': 'a', 'name': 'Start A', 'position': pa, 'yaw': ya},
                  {'id': 'b', 'name': 'Start B', 'position': pb, 'yaw': yb}]
    return spawns, round(float(da[b]))


def smooth_normals(pos, idx):
    n = np.zeros_like(pos)
    t = pos[idx]
    fn = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    for k in range(3):
        np.add.at(n, idx[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
