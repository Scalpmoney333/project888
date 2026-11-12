"""Minimal readers for GTA V PC resources (RSC7): YDR drawables, YTD texture dictionaries, YMAP entities.

Layouts follow CodeWalker's open-source definitions (gen8 / legacy PC resources). Only what the map
converter needs is decoded: highest-LOD geometry, shader diffuse textures, texture pixels, placements.
"""
import struct, zlib
import numpy as np
from PIL import Image


def joaat(s):
    h = 0
    for c in s.lower().encode():
        h = (h + c) & 0xFFFFFFFF
        h = (h + (h << 10)) & 0xFFFFFFFF
        h ^= h >> 6
    h = (h + (h << 3)) & 0xFFFFFFFF
    h ^= h >> 11
    return (h + (h << 15)) & 0xFFFFFFFF


def _page_size(flags):
    s = ((flags >> 27) & 1) + (((flags >> 26) & 1) << 1) + (((flags >> 25) & 1) << 2) + (((flags >> 24) & 1) << 3) \
        + (((flags >> 17) & 0x7f) << 4) + (((flags >> 11) & 0x3f) << 5) + (((flags >> 7) & 0xf) << 6) \
        + (((flags >> 5) & 3) << 7) + (((flags >> 4) & 1) << 8)
    return (0x200 << (flags & 0xf)) * s


class Resource:
    """Decompressed RSC7 body split into system (0x5...) and graphics (0x6...) segments."""

    def __init__(self, data):
        magic, self.version, sf, gf = struct.unpack_from('<4sIII', data)
        if magic != b'RSC7':
            raise ValueError('not an RSC7 resource (encrypted or packed files are not supported)')
        body = zlib.decompress(data[16:], -15)
        ss = _page_size(sf)
        self.sys, self.gfx = body[:ss], body[ss:]

    def seg(self, ptr):
        top = ptr >> 28
        if top == 5:
            return self.sys, ptr & 0x0FFFFFFF
        if top == 6:
            return self.gfx, ptr & 0x0FFFFFFF
        raise ValueError(f'bad pointer {ptr:#x}')

    def u(self, fmt, ptr, off=0):
        buf, o = self.seg(ptr)
        return struct.unpack_from('<' + fmt, buf, o + off)

    def bytes(self, ptr, n):
        buf, o = self.seg(ptr)
        return buf[o:o + n]

    def cstr(self, ptr):
        if not ptr:
            return None
        buf, o = self.seg(ptr)
        return buf[o:buf.index(b'\0', o)].decode('latin-1')

    def ptr_list(self, ptr, off):
        """ResourcePointerList64: {u64 entries, u16 count, u16 capacity}."""
        lp, cnt = self.u('QH', ptr, off)
        return list(self.u(f'{cnt}Q', lp)) if lp and cnt else []


# ------------------------------------------------------------------ textures
FMT_DXT1, FMT_DXT3, FMT_DXT5 = 0x31545844, 0x33545844, 0x35545844
FMT_ATI1, FMT_ATI2, FMT_BC7 = 0x31495441, 0x32495441, 0x20374342
FMT_A8R8G8B8, FMT_A1R5G5B5, FMT_A8, FMT_A8B8G8R8, FMT_L8 = 0x15, 0x19, 0x1C, 0x20, 0x32


def _mip_bytes(fmt, w, h):
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    if fmt in (FMT_DXT1, FMT_ATI1):
        return bw * bh * 8
    if fmt in (FMT_DXT3, FMT_DXT5, FMT_ATI2, FMT_BC7):
        return bw * bh * 16
    if fmt in (FMT_A8, FMT_L8):
        return w * h
    if fmt == FMT_A1R5G5B5:
        return w * h * 2
    return w * h * 4


def _decode_dxt3(data, w, h):
    """BC2: 4-bit explicit alpha + always-4-colour BC1 block (texture2ddecoder has no BC2)."""
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    b = np.frombuffer(data, np.uint8)[:bw * bh * 16].reshape(bh, bw, 16)
    a4 = b[:, :, :8]
    alpha = np.stack([a4 & 15, a4 >> 4], -1).reshape(bh, bw, 16).astype(np.uint8) * 17
    c = b[:, :, 8:].astype(np.uint32)
    c0 = c[:, :, 0] | (c[:, :, 1] << 8)
    c1 = c[:, :, 2] | (c[:, :, 3] << 8)

    def rgb(v):
        return np.stack([(v >> 11 & 31) * 255 // 31, (v >> 5 & 63) * 255 // 63, (v & 31) * 255 // 31], -1)
    p0, p1 = rgb(c0), rgb(c1)
    pal = np.stack([p0, p1, (2 * p0 + p1) // 3, (p0 + 2 * p1) // 3], 2)  # bh,bw,4,3
    bits = c[:, :, 4] | (c[:, :, 5] << 8) | (c[:, :, 6] << 16) | (c[:, :, 7] << 24)
    sel = (bits[:, :, None] >> (2 * np.arange(16))) & 3
    col = np.take_along_axis(pal, sel[..., None].astype(np.int64).repeat(3, -1), 2)
    px = np.concatenate([col, alpha[..., None]], -1).astype(np.uint8).reshape(bh, bw, 4, 4, 4)
    px = px.transpose(0, 2, 1, 3, 4).reshape(bh * 4, bw * 4, 4)[:h, :w]
    return Image.fromarray(np.ascontiguousarray(px), 'RGBA')


def decode_pixels(fmt, w, h, data):
    import texture2ddecoder as t2d
    if fmt == FMT_DXT1:
        raw = t2d.decode_bc1(data, w, h)
    elif fmt == FMT_DXT3:
        return _decode_dxt3(data, w, h)
    elif fmt == FMT_DXT5:
        raw = t2d.decode_bc3(data, w, h)
    elif fmt == FMT_ATI1:
        raw = t2d.decode_bc4(data, w, h)
    elif fmt == FMT_ATI2:
        raw = t2d.decode_bc5(data, w, h)
    elif fmt == FMT_BC7:
        raw = t2d.decode_bc7(data, w, h)
    elif fmt in (FMT_A8R8G8B8, FMT_A8B8G8R8):
        a = np.frombuffer(data, np.uint8).reshape(h, w, 4)
        if fmt == FMT_A8B8G8R8:
            return Image.fromarray(a.copy(), 'RGBA')
        return Image.fromarray(a[:, :, [2, 1, 0, 3]].copy(), 'RGBA')
    elif fmt in (FMT_A8, FMT_L8):
        a = np.frombuffer(data, np.uint8).reshape(h, w)
        return Image.fromarray(a.copy(), 'L').convert('RGBA')
    else:
        raise ValueError(f'unsupported texture format {fmt:#x}')
    return Image.frombytes('RGBA', (w, h), raw, 'raw', 'BGRA')  # texture2ddecoder outputs BGRA


def read_texture(r, tp, max_size=512):
    """Texture (0x90): name @0x28, width/height @0x50, format @0x58, levels @0x5D, data @0x70.

    Picks the first mip level not larger than max_size so big textures are never fully decoded."""
    name = r.cstr(r.u('Q', tp, 0x28)[0])
    w, h, _, stride, fmt, _, levels = r.u('HHHHIBB', tp, 0x50)
    dp = r.u('Q', tp, 0x70)[0]
    off = 0
    for lvl in range(max(1, levels)):
        mw, mh = max(1, w >> lvl), max(1, h >> lvl)
        if (max(mw, mh) <= max_size or lvl == levels - 1) and mw >= 4 and mh >= 4:
            img = decode_pixels(fmt, mw, mh, r.bytes(dp + off, _mip_bytes(fmt, mw, mh)))
            return name, img, (w, h, fmt)
        off += _mip_bytes(fmt, mw, mh)
    img = decode_pixels(fmt, w, h, r.bytes(dp, _mip_bytes(fmt, w, h)))
    return name, img.resize((min(w, max_size), min(h, max_size))), (w, h, fmt)


def read_texture_dict(r, ptr, max_size=512):
    """TextureDictionary: textures pointer list @0x30."""
    out = {}
    for tp in r.ptr_list(ptr, 0x30):
        name, img, info = read_texture(r, tp, max_size)
        out[name.lower()] = img
    return out


def read_ytd(data, max_size=512):
    r = Resource(data)
    return read_texture_dict(r, 0x50000000, max_size)


# ------------------------------------------------------------------ drawables
# VertexDeclaration component types (CodeWalker VertexComponentType) -> (numpy dtype, count)
_VTYPES = {1: ('f2', 2), 2: ('f4', 1), 3: ('f2', 4), 4: ('f4', 1), 5: ('f4', 2), 6: ('f4', 3), 7: ('f4', 4),
           8: ('u1', 4), 9: ('u1', 4), 10: ('u4', 1)}
SEM_POS, SEM_NORMAL, SEM_COLOUR0, SEM_UV0 = 0, 3, 4, 6
DIFFUSE_HASHES = {joaat('DiffuseSampler'), joaat('DiffuseSampler2'), joaat('DiffuseTex')}


def _read_shaders(r, sgp):
    """ShaderGroup: shaders list @0x10. Returns per-shader dict {name, textures {param hash: tex name}}."""
    shaders = []
    if not sgp:
        return shaders, {}
    tdp = r.u('Q', sgp, 0x08)[0]
    embedded = read_texture_dict(r, tdp) if tdp else {}
    for sp in r.ptr_list(sgp, 0x10):
        pp, sname, _, pcount = r.u('QIIB', sp, 0)
        params = [r.u('BBHIQ', pp, i * 16) for i in range(pcount)]
        data_size = sum(16 * p[0] for p in params if p[0])
        hashes = r.u(f'{pcount}I', pp, pcount * 16 + data_size)
        tex = {}
        for (dt, _, _, _, dptr), h in zip(params, hashes):
            if dt == 0 and dptr:
                tex[h] = r.cstr(r.u('Q', dptr, 0x28)[0])
        shaders.append({'hash': sname, 'textures': tex})
    return shaders, embedded


def diffuse_of(shader):
    for h, t in shader['textures'].items():
        if h in DIFFUSE_HASHES and t:
            return t.lower()
    names = [t for t in shader['textures'].values() if t]
    return names[0].lower() if names else None


def _read_geometry(r, gp):
    vbp = r.u('Q', gp, 0x18)[0]
    ibp = r.u('Q', gp, 0x38)[0]
    stride, _, _, dp1, vcount, _, dp2 = r.u('HHIQIIQ', vbp, 0x08)
    dp1 = dp1 or dp2
    declp = r.u('Q', vbp, 0x30)[0]
    flags, dstride, _, _, types = r.u('IHBBQ', declp, 0)
    if dstride != stride:
        raise ValueError(f'stride mismatch {dstride} {stride}')
    fields, off = {}, 0
    for sem in range(16):
        if not (flags >> sem) & 1:
            continue
        ct = (types >> (sem * 4)) & 0xF
        dt, n = _VTYPES[ct]
        fields[sem] = (off, dt, n)
        off += np.dtype(dt).itemsize * n
    if off != stride:
        raise ValueError(f'declaration size {off} != stride {stride}')
    raw = np.frombuffer(r.bytes(dp1, stride * vcount), np.uint8).reshape(vcount, stride)

    def attr(sem):
        if sem not in fields:
            return None
        o, dt, n = fields[sem]
        sz = np.dtype(dt).itemsize * n
        return np.ascontiguousarray(raw[:, o:o + sz]).view(dt).reshape(vcount, n).astype(np.float32)
    icount, _, ip = r.u('IIQ', ibp, 0x08)
    idx = np.frombuffer(r.bytes(ip, icount * 2), np.uint16).astype(np.int64).reshape(-1, 3)
    uv = attr(SEM_UV0)
    col = attr(SEM_COLOUR0)
    return {'pos': attr(SEM_POS)[:, :3], 'uv': uv[:, :2] if uv is not None else None,
            'colour': col / 255 if col is not None else None, 'idx': idx}


def read_ydr(data):
    """Returns {name, bbox, shaders, embedded textures, geometries [{pos, uv, idx, shader}]} for the high LOD."""
    r = Resource(data)
    base = 0x50000000
    sgp = r.u('Q', base, 0x10)[0]
    bmin = r.u('3f', base, 0x30)
    bmax = r.u('3f', base, 0x40)
    lods = r.u('4Q', base, 0x50)
    name = r.cstr(r.u('Q', base, 0xA8)[0])
    shaders, embedded = _read_shaders(r, sgp)
    geoms = []
    for mp in r.ptr_list(lods[0], 0):  # highest LOD only
        gps = r.ptr_list(mp, 0x08)
        smp = r.u('Q', mp, 0x20)[0]
        smap = r.u(f'{len(gps)}H', smp) if smp else [0] * len(gps)
        for gp, si in zip(gps, smap):
            g = _read_geometry(r, gp)
            g['shader'] = si
            geoms.append(g)
    return {'name': name, 'bbox': (bmin, bmax), 'shaders': shaders, 'embedded': embedded, 'geometries': geoms,
            'lod_models': [len(r.ptr_list(p, 0)) if p else 0 for p in lods]}


# ------------------------------------------------------------------ ymap
def read_ymap_entities(data, names):
    """Finds CEntityDef records by scanning for known archetype hashes (META resource).

    CEntityDef: archetypeName @+8, position @+32, rotation quaternion @+48, scaleXY @+64, scaleZ @+68."""
    r = Resource(data)
    buf = r.sys + r.gfx
    by_hash = {joaat(n): n for n in names}
    out = []
    a = np.frombuffer(buf[:len(buf) // 4 * 4], '<u4')
    for i in np.nonzero(np.isin(a, list(by_hash)))[0]:
        o = i * 4 - 8
        if o < 0 or o % 16:
            continue
        pos = struct.unpack_from('<3f', buf, o + 32)
        rot = struct.unpack_from('<4f', buf, o + 48)
        sxy, sz = struct.unpack_from('<2f', buf, o + 64)
        if abs(sum(q * q for q in rot) - 1) > 1e-3:
            continue
        out.append({'name': by_hash[int(a[i])], 'pos': pos, 'rot': rot, 'scale': (sxy, sxy, sz)})
    return out
