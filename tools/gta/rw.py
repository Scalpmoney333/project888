"""Minimal RenderWare (GTA San Andreas, PC) reader: DFF models and TXD texture dictionaries.

Only what the converters need: frames (hierarchy, names, transforms), geometries (positions,
normals, prelit colours, UVs, triangles with material ids), materials (colour, texture name),
atomics (frame/geometry links), and D3D8/D3D9 native textures decoded to RGBA (via
texture2ddecoder for DXT, plain unpacking for the uncompressed formats).
"""
import struct
import numpy as np

CHUNK_STRUCT, CHUNK_STRING, CHUNK_EXTENSION = 0x01, 0x02, 0x03
CHUNK_TEXTURE, CHUNK_MATERIAL, CHUNK_MATLIST = 0x06, 0x07, 0x08
CHUNK_FRAMELIST, CHUNK_GEOMETRY, CHUNK_CLUMP = 0x0E, 0x0F, 0x10
CHUNK_ATOMIC, CHUNK_TEXNATIVE, CHUNK_TEXDICT, CHUNK_GEOMLIST = 0x14, 0x15, 0x16, 0x1A
CHUNK_FRAME_NAME = 0x253F2FE
CHUNK_BINMESH = 0x50E


def unpack_version(v):
    if v & 0xFFFF0000:
        return (((v >> 14) & 0x3FF00) + 0x30000) | ((v >> 16) & 0x3F)
    return v << 8


class Reader:
    def __init__(self, data):
        self.d = data

    def chunks(self, start, end):
        """Yield (type, data_start, data_end, version) for chunks between start and end."""
        p = start
        while p + 12 <= end:
            t, size, ver = struct.unpack_from('<III', self.d, p)
            ds = p + 12
            de = min(ds + size, end)
            yield t, ds, de, unpack_version(ver)
            p = ds + size

    def find(self, start, end, typ):
        for t, s, e, v in self.chunks(start, end):
            if t == typ:
                return s, e, v
        return None


class Frame:
    __slots__ = ('rot', 'pos', 'parent', 'name', 'matrix', 'world')


class Geometry:
    pass


def read_dff(data):
    r = Reader(data)
    out = []  # clumps
    for t, s, e, v in r.chunks(0, len(data)):
        if t != CHUNK_CLUMP:
            continue
        clump = {'frames': [], 'geometries': [], 'atomics': []}
        for ct, cs, ce, cv in r.chunks(s, e):
            if ct == CHUNK_FRAMELIST:
                clump['frames'] = _read_frames(r, cs, ce)
            elif ct == CHUNK_GEOMLIST:
                clump['geometries'] = _read_geometries(r, cs, ce)
            elif ct == CHUNK_ATOMIC:
                st = r.find(cs, ce, CHUNK_STRUCT)
                fi, gi = struct.unpack_from('<II', data, st[0])
                clump['atomics'].append((fi, gi))
        _world_matrices(clump['frames'])
        out.append(clump)
    return out


def _read_frames(r, s, e):
    d = r.d
    st = r.find(s, e, CHUNK_STRUCT)
    n = struct.unpack_from('<I', d, st[0])[0]
    frames = []
    p = st[0] + 4
    for _ in range(n):
        f = Frame()
        vals = struct.unpack_from('<12fiI', d, p)
        f.rot = np.array(vals[0:9], np.float64).reshape(3, 3)  # rows = right, up(forward), at
        f.pos = np.array(vals[9:12], np.float64)
        f.parent = vals[12]
        f.name = ''
        frames.append(f)
        p += 56
    # extensions after the struct: one per frame, in order
    i = 0
    for t, cs, ce, v in r.chunks(st[1], e):
        if t != CHUNK_EXTENSION:
            continue
        nm = r.find(cs, ce, CHUNK_FRAME_NAME)
        if nm and i < n:
            frames[i].name = d[nm[0]:nm[1]].split(b'\0')[0].decode('latin-1')
        i += 1
    return frames


def _world_matrices(frames):
    for i, f in enumerate(frames):
        m = np.eye(4)
        m[:3, :3] = f.rot.T  # RW stores row vectors; column-vector matrix is the transpose
        m[:3, 3] = f.pos
        f.matrix = m
    for f in frames:
        w, p = f.matrix.copy(), f.parent
        seen = 0
        while p >= 0 and seen < 64:
            w = frames[p].matrix @ w
            p = frames[p].parent
            seen += 1
        f.world = w


def _read_geometries(r, s, e):
    d = r.d
    geoms = []
    for t, gs, ge, v in r.chunks(s, e):
        if t != CHUNK_GEOMETRY:
            continue
        st = r.find(gs, ge, CHUNK_STRUCT)
        p = st[0]
        flags, ntri, nvert, nmorph = struct.unpack_from('<IIII', d, p)
        p += 16
        if v < 0x34000:
            p += 12
        g = Geometry()
        g.flags = flags
        native = flags & 0x01000000
        nuv = (flags >> 16) & 0xFF
        if not nuv:
            nuv = 2 if flags & 0x80 else (1 if flags & 0x04 else 0)
        g.colors = None
        g.uv = None
        g.tris = np.zeros((0, 4), np.uint16)
        if not native:
            if flags & 0x08:
                g.colors = np.frombuffer(d, np.uint8, nvert * 4, p).reshape(-1, 4)
                p += nvert * 4
            if nuv:
                g.uv = np.frombuffer(d, np.float32, nvert * 2, p).reshape(-1, 2).copy()
                p += nvert * 8 * nuv
            # each triangle: vertex2, vertex1, materialId, vertex3
            g.tris = np.frombuffer(d, np.uint16, ntri * 4, p).reshape(-1, 4)
            p += ntri * 8
        p += 16  # bounding sphere
        has_v, has_n = struct.unpack_from('<II', d, p)
        p += 8
        g.pos = np.frombuffer(d, np.float32, nvert * 3, p).reshape(-1, 3).astype(np.float64) if has_v else None
        p += nvert * 12 if has_v else 0
        g.nrm = np.frombuffer(d, np.float32, nvert * 3, p).reshape(-1, 3).astype(np.float64) if has_n else None
        g.materials = []
        ml = r.find(st[1], ge, CHUNK_MATLIST)
        if ml:
            mst = r.find(ml[0], ml[1], CHUNK_STRUCT)
            nmat = struct.unpack_from('<I', d, mst[0])[0]
            idx = struct.unpack_from(f'<{nmat}i', d, mst[0] + 4)
            mats = []
            for mt, ms, me, mv in r.chunks(mst[1], ml[1]):
                if mt == CHUNK_MATERIAL:
                    mats.append(_read_material(r, ms, me))
            g.materials = [mats[i] if i < 0 else mats[i] for i in range(nmat)] if len(mats) == nmat else [mats[j] if j >= 0 else None for j in idx]
            # instanced materials (-1 = new, n = copy of n)
            res = []
            k = 0
            for j in idx:
                if j < 0:
                    res.append(mats[k] if k < len(mats) else None)
                    k += 1
                else:
                    res.append(res[j])
            g.materials = res
        # BinMesh (per-material triangle lists/strips) is authoritative when present: some
        # exporters leave every material id in the plain triangle list at 0.
        ext = r.find(st[1], ge, CHUNK_EXTENSION)
        if ext:
            bm = r.find(ext[0], ext[1], CHUNK_BINMESH)
            if bm:
                g.tris = _binmesh(d, bm[0], bm[1])
        geoms.append(g)
    return geoms


def _binmesh(d, s, e):
    strip, nsplit, _ = struct.unpack_from('<III', d, s)
    p = s + 12
    tris = []
    for _ in range(nsplit):
        n, mat = struct.unpack_from('<II', d, p)
        p += 8
        ind = np.frombuffer(d, np.uint32, n, p)
        p += 4 * n
        if strip:
            for i in range(n - 2):
                a, b, c = ind[i], ind[i + 1], ind[i + 2]
                if a == b or b == c or a == c:
                    continue
                if i % 2:
                    a, b = b, a
                tris.append((b, a, mat, c))
        else:
            for i in range(0, n - 2, 3):
                tris.append((ind[i + 1], ind[i], mat, ind[i + 2]))
    return np.array(tris, np.uint32).reshape(-1, 4)


def _read_material(r, s, e):
    d = r.d
    st = r.find(s, e, CHUNK_STRUCT)
    flags, rgba, unused, textured = struct.unpack_from('<IIII', d, st[0])
    m = {'color': [rgba & 255, (rgba >> 8) & 255, (rgba >> 16) & 255, (rgba >> 24) & 255], 'texture': None, 'mask': None}
    if textured:
        tx = r.find(st[1], e, CHUNK_TEXTURE)
        if tx:
            names = [d[ns:ne].split(b'\0')[0].decode('latin-1') for t, ns, ne, v in r.chunks(tx[0], tx[1]) if t == CHUNK_STRING]
            if names:
                m['texture'] = names[0]
                m['mask'] = names[1] if len(names) > 1 else None
    return m


def triangles(g):
    """(N,3) vertex indices in counter-clockwise order + (N,) material ids."""
    t = np.asarray(g.tris).astype(np.int64)
    return np.stack([t[:, 1], t[:, 0], t[:, 3]], 1), t[:, 2]


# ---------------------------------------------------------------- textures
def read_txd(data, max_size=None):
    """Returns {lowercase name: PIL.Image RGBA}."""
    from PIL import Image
    import texture2ddecoder as t2d
    r = Reader(data)
    out = {}
    for t, s, e, v in r.chunks(0, len(data)):
        if t != CHUNK_TEXDICT:
            continue
        for ct, cs, ce, cv in r.chunks(s, e):
            if ct != CHUNK_TEXNATIVE:
                continue
            st = r.find(cs, ce, CHUNK_STRUCT)
            p = st[0]
            platform, filt = struct.unpack_from('<II', data, p)
            name = data[p + 8:p + 40].split(b'\0')[0].decode('latin-1').lower()
            raster, fmt = struct.unpack_from('<II', data, p + 72)
            w, h, depth, levels, rtype, cflags = struct.unpack_from('<HHBBBB', data, p + 80)
            q = p + 88
            if raster & 0x2000:  # PAL8
                pal = np.frombuffer(data, np.uint8, 1024, q).reshape(256, 4)
                q += 1024
            elif raster & 0x4000:  # PAL4
                pal = np.frombuffer(data, np.uint8, 128 * 4, q).reshape(-1, 4)
                q += 128
            size = struct.unpack_from('<I', data, q)[0]
            q += 4
            buf = bytes(data[q:q + size])
            try:
                img = _decode(platform, raster, fmt, w, h, buf, cflags, depth, locals().get('pal'), t2d)
            except Exception as ex:  # unknown format: skip texture
                print('txd: cannot decode', name, hex(raster), fmt, ex)
                continue
            im = Image.frombytes('RGBA', (w, h), img)
            if max_size and max(w, h) > max_size:
                k = max_size / max(w, h)
                im = im.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)
            out[name] = im
    return out


def _decode(platform, raster, fmt, w, h, buf, cflags, depth, pal, t2d):
    fourcc = fmt if platform == 9 else 0
    if platform == 8:  # D3D8: compression in the flags byte
        fourcc = {1: 0x31545844, 3: 0x33545844, 5: 0x35545844}.get(cflags >> 4 & 0xF if cflags & 0xF0 else cflags, 0) if (raster & 0xF00) not in (0x500, 0x600) else 0
        if cflags in (1, 3, 5) or (cflags >> 4) in (1, 3, 5):
            fourcc = {1: 0x31545844, 3: 0x33545844, 5: 0x35545844}[cflags if cflags in (1, 3, 5) else cflags >> 4]
    if fourcc == 0x31545844:  # DXT1
        return _bgra_to_rgba(t2d.decode_bc1(buf, w, h))
    if fourcc == 0x33545844:  # DXT3
        return _decode_dxt3(buf, w, h)
    if fourcc == 0x35545844:  # DXT5
        return _bgra_to_rgba(t2d.decode_bc3(buf, w, h))
    a = np.frombuffer(buf, np.uint8)
    if pal is not None:
        idx = a[:w * h]
        return pal[idx].tobytes()
    kind = raster & 0xF00
    if kind in (0x500, 0x600):  # 8888 / 888 (BGRA in memory)
        px = a[:w * h * 4].reshape(-1, 4)
        rgba = px[:, [2, 1, 0, 3]].copy()
        if kind == 0x600:
            rgba[:, 3] = 255
        return rgba.tobytes()
    v = np.frombuffer(buf, '<u2')[:w * h].astype(np.uint32)
    if kind == 0x100:  # 1555
        r_, g_, b_, al = (v >> 10) & 31, (v >> 5) & 31, v & 31, (v >> 15) * 255
        rgba = np.stack([r_ * 255 // 31, g_ * 255 // 31, b_ * 255 // 31, al], 1)
    elif kind == 0x200:  # 565
        r_, g_, b_ = (v >> 11) & 31, (v >> 5) & 63, v & 31
        rgba = np.stack([r_ * 255 // 31, g_ * 255 // 63, b_ * 255 // 31, np.full_like(v, 255)], 1)
    elif kind == 0x300:  # 4444
        rgba = np.stack([((v >> 8) & 15) * 17, ((v >> 4) & 15) * 17, (v & 15) * 17, ((v >> 12) & 15) * 17], 1)
    else:
        raise ValueError(f'raster {hex(raster)}')
    return rgba.astype(np.uint8).tobytes()


def bleed_alpha(img, passes=6):
    """Spread opaque colours into transparent texels so alpha-tested edges don't show the
    (often white) colour stored under transparent pixels."""
    from PIL import Image
    from scipy.ndimage import uniform_filter
    a = np.asarray(img.getchannel('A'), np.float32) / 255
    rgb = np.asarray(img.convert('RGB'), np.float32)
    known = (a > 0.5).astype(np.float32)
    acc = rgb * known[..., None]
    w = known.copy()
    for _ in range(passes):
        blur = lambda x: uniform_filter(x, size=5, mode="nearest")
        acc_b = np.stack([blur(acc[..., c]) for c in range(3)], -1)
        w_b = blur(w)
        fill = (w < 0.5) & (w_b > 1e-3)
        acc[fill] = acc_b[fill] / w_b[fill][:, None]
        w[fill] = 1
    out = np.where(known[..., None] > 0, rgb, np.where(w[..., None] > 0, acc, rgb))
    res = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGB')
    res.putalpha(img.getchannel('A'))
    return res


def _bgra_to_rgba(b):
    a = np.frombuffer(b, np.uint8).reshape(-1, 4)
    return a[:, [2, 1, 0, 3]].tobytes()


def _decode_dxt3(buf, w, h):
    """DXT3/BC2: explicit 4-bit alpha + always-opaque 4-colour BC1 block."""
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    blk = np.frombuffer(buf, np.uint8, bw * bh * 16).reshape(bh, bw, 16)
    alpha_bits = blk[..., :8].reshape(bh, bw, 8)
    a = np.stack([alpha_bits & 15, alpha_bits >> 4], -1).reshape(bh, bw, 16).astype(np.uint16) * 17
    c0 = blk[..., 8].astype(np.uint32) | (blk[..., 9].astype(np.uint32) << 8)
    c1 = blk[..., 10].astype(np.uint32) | (blk[..., 11].astype(np.uint32) << 8)
    def rgb(c):
        return np.stack([((c >> 11) & 31) * 255 // 31, ((c >> 5) & 63) * 255 // 63, (c & 31) * 255 // 31], -1).astype(np.int32)
    p0, p1 = rgb(c0), rgb(c1)
    pal = np.stack([p0, p1, (2 * p0 + p1) // 3, (p0 + 2 * p1) // 3], 2)  # bh,bw,4,3
    bits = blk[..., 12:16].astype(np.uint32)
    code = bits[..., 0] | (bits[..., 1] << 8) | (bits[..., 2] << 16) | (bits[..., 3] << 24)
    sel = np.stack([(code >> (2 * i)) & 3 for i in range(16)], -1)  # bh,bw,16
    col = np.take_along_axis(pal, sel[..., None].repeat(3, -1).astype(np.int64), 2)  # bh,bw,16,3
    px = np.concatenate([col, a[..., None]], -1).reshape(bh, bw, 4, 4, 4).transpose(0, 2, 1, 3, 4).reshape(bh * 4, bw * 4, 4)
    return px[:h, :w].astype(np.uint8).tobytes()


# ---------------------------------------------------------------- IPL / IDE
def read_mta_resource(map_xml, client_lua):
    """Placements from an MTA:SA map resource (<object model posX.. rotX..> in a .map file, with
    engineLoadDFF/engineReplaceModel calls in client.lua mapping model ids to DFF files).
    Returns IPL-style dicts; rotations are MTA euler degrees converted to a quaternion."""
    import re
    var_file = dict(re.findall(r"local\s+(\w+)\s*=\s*engineLoadDFF\s*\(\s*['\"]([^'\"]+)['\"]", client_lua))
    model_file = {}
    for var, mid in re.findall(r"engineReplaceModel\s*\(\s*(\w+)\s*,\s*(\d+)\s*\)", client_lua):
        if var in var_file:
            model_file[int(mid)] = var_file[var]
    out = []
    for attrs in re.findall(r'<object\s([^>]*)>', map_xml):
        a = dict(re.findall(r'(\w+)="([^"]*)"', attrs))
        mid = int(a['model'])
        if mid not in model_file:
            continue
        rx, ry, rz = (np.radians(float(a.get(k, 0))) for k in ('rotX', 'rotY', 'rotZ'))
        # MTA applies Z, then X, then Y (ZXY) in degrees; build the quaternion of that rotation.
        def q(axis, ang):
            v = np.zeros(3); v[axis] = np.sin(ang / 2)
            return np.array([*v, np.cos(ang / 2)])
        def mul(a, b):
            ax, ay, az, aw = a; bx, by, bz, bw = b
            return np.array([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
                             aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz])
        quat = mul(mul(q(2, rz), q(0, rx)), q(1, ry))
        out.append({'id': mid, 'model': model_file[mid].rsplit('.', 1)[0], 'pos': [float(a['posX']), float(a['posY']), float(a['posZ'])],
                    'rot': quat.tolist(), 'lod': -1, 'mta': True, 'scale': float(a.get('scale', 1))})
    return out


def read_ipl(text):
    """Instances from the 'inst' section: (id, model, interior, pos(3), quat xyzw(4), lod)."""
    out, sec = [], None
    for line in text.splitlines():
        line = line.split('#')[0].strip()
        if not line:
            continue
        low = line.lower()
        if low in ('inst', 'cull', 'pick', 'path', 'grge', 'enex', 'jump', 'auzo', 'mult', 'cars', 'occl', 'tcyc'):
            sec = low
            continue
        if low == 'end':
            sec = None
            continue
        if sec == 'inst':
            f = [x.strip() for x in line.split(',')]
            out.append({'id': int(f[0]), 'model': f[1], 'pos': [float(x) for x in f[3:6]], 'rot': [float(x) for x in f[6:10]], 'lod': int(f[10])})
    return out


def read_ide(text):
    out, sec = {}, None
    for line in text.splitlines():
        line = line.split('#')[0].strip()
        if not line:
            continue
        low = line.lower()
        if low in ('objs', 'tobj', 'anim', 'cars', 'peds', 'weap', 'hier', 'txdp', '2dfx', 'path'):
            sec = low
            continue
        if low == 'end':
            sec = None
            continue
        if sec in ('objs', 'tobj', 'anim'):
            f = [x.strip() for x in line.split(',')]
            out[f[1].lower()] = {'id': int(f[0]), 'txd': f[2].lower(), 'draw': float(f[3]) if len(f) > 3 else 0, 'flags': int(f[-1]) if f[-1].lstrip('-').isdigit() else 0}
    return out
