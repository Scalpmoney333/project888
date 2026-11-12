"""Minimal reader for GTA IV RAGE resources (RSC5) stored in IMG v3 archives.

The IMG table of contents is encrypted, so resources are located by scanning 2048-byte sectors
for the RSC5 magic instead of reading the TOC; resource bodies are plain zlib. Layouts follow the
public SparkIV/RageLib sources (rage::rmcDrawable, grmModel, grmGeometryQB, grcTexturePC).
"""
import struct, zlib
import numpy as np
from PIL import Image

TYPES = {110: 'wdr', 8: 'wtd', 32: 'wbn', 1: 'wdd'}


def scan_img(data):
    """Yield (offset, type, sys bytes, gfx bytes) for every RSC5 resource in an IMG archive."""
    for off in range(0, len(data), 2048):
        if data[off:off + 4] != b'RSC\x05':
            continue
        typ, flags = struct.unpack_from('<II', data, off + 4)
        vs = (flags & 0x7FF) << (((flags >> 11) & 0xF) + 8)
        body = zlib.decompressobj().decompress(data[off + 12:])
        yield off, typ, body[:vs], body[vs:]


class Res:
    def __init__(self, sys_, gfx):
        self.s, self.g = sys_, gfx

    def u32(self, o):
        return struct.unpack_from('<I', self.s, o)[0]

    def u16(self, o):
        return struct.unpack_from('<H', self.s, o)[0]

    def ptr(self, o):
        """System-segment pointer at sys offset o -> sys offset (or None)."""
        v = self.u32(o)
        if v == 0:
            return None
        assert v >> 28 == 5, hex(v)
        return v & 0x0FFFFFFF

    def dptr(self, o):
        v = self.u32(o)
        assert v >> 28 == 6, hex(v)
        return v & 0x0FFFFFFF

    def cstr(self, o):
        return self.s[o:self.s.index(b'\0', o)].decode('latin-1')

    def ptrs(self, o):
        """PtrCollection at o: (array ptr, u16 count, u16 size) -> list of item offsets."""
        arr, n = self.ptr(o), self.u16(o + 4)
        return [self.ptr(arr + 4 * i) for i in range(n)] if arr is not None else []


SIZES = [2, 4, 6, 8, 4, 8, 12, 16, 4, 4, 4, 0, 0, 0, 0, 0]


def read_vertices(r, vb):
    count = r.u16(vb + 4)
    data = r.dptr(vb + 8) if r.u32(vb + 8) else r.dptr(vb + 0x18)  # locked-data ptr is often null
    stride = r.u32(vb + 12)
    decl = r.ptr(vb + 16)
    usage, dstride = r.u32(decl), r.u16(decl + 4)
    types = struct.unpack_from('<Q', r.s, decl + 8)[0]
    assert dstride == stride, (dstride, stride)
    raw = np.frombuffer(r.g, np.uint8, count * stride, data).reshape(count, stride)
    out, off = {}, 0
    for i in range(16):
        if not usage >> i & 1:
            continue
        t = types >> (4 * i) & 0xF
        sz = SIZES[t]
        col = raw[:, off:off + sz].copy()
        if t in (4, 5, 6, 7):
            val = col.view(np.float32)
        elif t in (0, 1, 2, 3):
            val = col.view(np.float16).astype(np.float32)
        else:
            val = col
        name = {0: 'pos', 3: 'normal', 4: 'color', 6: 'uv0', 7: 'uv1'}.get(i, f'u{i}')
        out[name] = val
        off += sz
    assert off == stride, (off, stride, hex(usage), hex(types))
    return out


def read_drawable(sys_, gfx):
    """-> {'shaders': [ {name, textures{hash: name}} ], 'lods': [[geometry dicts]]}."""
    r = Res(sys_, gfx)
    sg = r.ptr(0x08)
    shaders = []
    for sh in r.ptrs(sg + 8) if sg is not None else []:
        n = r.u32(sh + 0x1C)
        offs, types, names = r.ptr(sh + 0x14), r.ptr(sh + 0x24), r.ptr(sh + 0x34)
        tex = {}
        for i in range(n):
            if r.s[types + i] == 0:  # texture param
                p = r.ptr(offs + 4 * i)
                if p is not None:
                    tex[r.u32(names + 4 * i)] = r.cstr(r.ptr(p + 0x14)).lower()
        shaders.append({'name': r.cstr(r.ptr(sh + 0x44)), 'textures': tex})
    lods = []
    for li in range(4):
        mc = r.ptr(0x40 + 4 * li)
        if mc is None:
            continue
        geoms = []
        for m in r.ptrs(mc):
            gl = r.ptrs(m + 4)
            mapping = r.ptr(m + 0x10)
            for gi, g in enumerate(gl):
                vb, ib = r.ptr(g + 0x0C), r.ptr(g + 0x1C)
                v = read_vertices(r, vb)
                icount = r.u32(ib + 4)
                idx = np.frombuffer(r.g, np.uint16, icount, r.dptr(ib + 8)).astype(np.int64)
                geoms.append({'shader': r.u16(mapping + 2 * gi), 'v': v, 'idx': idx.reshape(-1, 3),
                              'prim': r.u16(g + 0x36)})
        lods.append(geoms)
    return {'shaders': shaders, 'lods': lods}


def _decode(fmt, w, h, buf):
    import texture2ddecoder as t2d
    if fmt == 0x31545844:
        return t2d.decode_bc1(buf, w, h), (w * h) // 2
    if fmt == 0x33545844:
        return t2d.decode_bc2(buf, w, h), w * h
    if fmt == 0x35545844:
        return t2d.decode_bc3(buf, w, h), w * h
    if fmt == 0x15:
        return bytes(buf[:w * h * 4]), w * h * 4
    if fmt == 0x32:
        a = np.frombuffer(buf, np.uint8, w * h)
        return np.stack([a, a, a, np.full_like(a, 255)], 1).tobytes(), w * h
    raise ValueError(hex(fmt))


def read_wtd(sys_, gfx, max_size=512):
    """Texture dictionary -> {name: PIL RGBA image}, using the first mip <= max_size."""
    r = Res(sys_, gfx)
    out = {}
    for t in r.ptrs(0x18):
        name = r.cstr(r.ptr(t + 0x14)).lower()
        name = name.rsplit('/', 1)[-1].rsplit(':', 1)[-1]
        if name.endswith('.dds'):
            name = name[:-4]
        w, h, fmt = r.u16(t + 0x1C), r.u16(t + 0x1E), r.u32(t + 0x20)
        levels = r.s[t + 0x27]
        off = r.dptr(t + 0x48)
        lvl = 0
        while lvl + 1 < levels and max(w, h) > max_size:
            _, n = _decode_size(fmt, w, h)
            off += n; w = max(w // 2, 4 if fmt >> 8 else 1); h = max(h // 2, 4 if fmt >> 8 else 1); lvl += 1
        rgba, _ = _decode(fmt, w, h, r.g[off:off + _decode_size(fmt, w, h)[1]])
        # BCn decoders return BGRA; A8R8G8B8 is BGRA in memory too.
        img = Image.frombytes('RGBA', (w, h), rgba, 'raw', 'BGRA')
        if max(w, h) > max_size:
            s = max_size / max(w, h)
            img = img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
        out[name] = img
    return out


def _decode_size(fmt, w, h):
    if fmt == 0x31545844:
        return None, max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * 8
    if fmt in (0x33545844, 0x35545844):
        return None, max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * 16
    if fmt == 0x15:
        return None, w * h * 4
    return None, w * h
