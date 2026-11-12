"""Readers for loose GTA V (legacy / gen8) RSC7 resources: drawables (.ydr), texture
dictionaries (.ytd) and meta files (.ymap/.ytyp). Struct layouts follow CodeWalker."""
import struct
import zlib
import numpy as np

SYS_BASE, GFX_BASE = 0x50000000, 0x60000000


def joaat(s):
    h = 0
    for c in s.lower().encode('latin-1'):
        h = (h + c) & 0xFFFFFFFF
        h = (h + (h << 10)) & 0xFFFFFFFF
        h ^= h >> 6
    h = (h + (h << 3)) & 0xFFFFFFFF
    h ^= h >> 11
    h = (h + (h << 15)) & 0xFFFFFFFF
    return h


def page_size(flags):
    """Total size in bytes of a resource's page set (CodeWalker RpfResourcePageFlags)."""
    s = (((flags >> 27) & 1) + (((flags >> 26) & 1) << 1) + (((flags >> 25) & 1) << 2)
         + (((flags >> 24) & 1) << 3) + (((flags >> 17) & 0x7F) << 4) + (((flags >> 11) & 0x3F) << 5)
         + (((flags >> 7) & 0xF) << 6) + (((flags >> 5) & 3) << 7) + (((flags >> 4) & 1) << 8))
    return (0x200 << (flags & 0xF)) * s


class Res:
    def __init__(self, path):
        d = open(path, 'rb').read()
        magic, self.version, sf, gf = struct.unpack_from('<4sIII', d, 0)
        assert magic == b'RSC7', path
        raw = zlib.decompressobj(-15).decompress(d[16:])
        ssz, gsz = page_size(sf), page_size(gf)
        self.sys = raw[:ssz]
        self.gfx = raw[ssz:ssz + gsz]
        self.raw = raw

    def _loc(self, addr):
        if addr >> 28 == 5:
            return self.sys, addr - SYS_BASE
        if addr >> 28 == 6:
            return self.gfx, addr - GFX_BASE
        raise ValueError(hex(addr))

    def unpack(self, fmt, addr):
        buf, o = self._loc(addr)
        return struct.unpack_from('<' + fmt, buf, o)

    def u16(self, a): return self.unpack('H', a)[0]
    def u32(self, a): return self.unpack('I', a)[0]
    def u64(self, a): return self.unpack('Q', a)[0]

    def bytes(self, addr, n):
        buf, o = self._loc(addr)
        return buf[o:o + n]

    def cstr(self, addr):
        buf, o = self._loc(addr)
        return buf[o:buf.index(b'\0', o)].decode('latin-1')


# --------------------------------------------------------------------------- drawables
SEM_SIZE = {0: 0, 1: 4, 2: 4, 3: 8, 4: 0, 5: 8, 6: 12, 7: 16, 8: 4, 9: 4, 10: 4}
POS, NRM, UV0 = 0, 3, 6


def _decl_offsets(flags, types):
    off, out = 0, {}
    for k in range(16):
        if flags >> k & 1:
            t = types >> (4 * k) & 0xF
            out[k] = (off, t)
            off += SEM_SIZE.get(t, 0)
    return out, off


def _decode(buf, count, stride, off, t, ncomp=None):
    arr = np.frombuffer(buf, np.uint8, count * stride).reshape(count, stride)
    if t == 6:
        return arr[:, off:off + 12].copy().view('<f4').reshape(count, 3)
    if t == 5:
        return arr[:, off:off + 8].copy().view('<f4').reshape(count, 2)
    if t == 7:
        return arr[:, off:off + 16].copy().view('<f4').reshape(count, 4)
    if t == 1:
        return arr[:, off:off + 4].copy().view('<f2').reshape(count, 2).astype(np.float32)
    if t == 3:
        return arr[:, off:off + 8].copy().view('<f2').reshape(count, 4).astype(np.float32)
    return None


def read_ydr(path, lod='high'):
    """Return list of geometries: dict(pos, nrm, uv, idx, texture dict {param hash: name}, shader)."""
    r = Res(path)
    B = SYS_BASE
    shader_group = r.u64(B + 0x10)
    shaders_ptr = r.u64(shader_group + 0x10)
    shaders_cnt = r.u16(shader_group + 0x18)
    shaders = []
    for i in range(shaders_cnt):
        sp = r.u64(shaders_ptr + 8 * i)
        params_ptr = r.u64(sp)
        shader_name = r.u32(sp + 8)
        fname = r.u32(sp + 0x18)
        n = r.bytes(sp + 0x10, 1)[0]
        recs = [r.unpack('BBHIQ', params_ptr + 16 * j) for j in range(n)]
        extra = sum(t[0] for t in recs if t[0])
        hashes = [r.u32(params_ptr + 16 * n + 16 * extra + 4 * j) for j in range(n)]
        tex = {}
        for h, rec in zip(hashes, recs):
            if rec[0] == 0 and rec[4]:
                nm = r.u64(rec[4] + 0x28)
                if nm:
                    tex[h] = r.cstr(nm).lower()
        shaders.append({'name': shader_name, 'file': fname, 'textures': tex})
    off = {'high': 0x50, 'med': 0x58, 'low': 0x60, 'vlow': 0x68}[lod]
    mh = r.u64(B + off)
    models_ptr, mcount = r.u64(mh), r.u16(mh + 8)
    geoms = []
    for mi in range(mcount):
        m = r.u64(models_ptr + 8 * mi)
        gptr, gcnt = r.u64(m + 8), r.u16(m + 0x10)
        smap_ptr = r.u64(m + 0x20)
        for gi in range(gcnt):
            g = r.u64(gptr + 8 * gi)
            sid = r.u16(smap_ptr + 2 * gi)
            vb, ib = r.u64(g + 0x18), r.u64(g + 0x38)
            nidx = r.u32(g + 0x58)
            nvert = r.u16(g + 0x60)
            stride = r.u16(vb + 8)
            vdata = r.u64(vb + 0x10) or r.u64(vb + 0x20)
            vcount = r.u32(vb + 0x18)
            info = r.u64(vb + 0x30)
            flags, istride, _, ncomp, types = r.unpack('IHBBQ', info)
            offs, tot = _decl_offsets(flags, types)
            assert tot == stride == istride, (tot, stride, istride, hex(types))
            vbuf = r.bytes(vdata, vcount * stride)
            pos = _decode(vbuf, vcount, stride, *offs[POS])
            nrm = _decode(vbuf, vcount, stride, *offs[NRM]) if NRM in offs else None
            uv = _decode(vbuf, vcount, stride, *offs[UV0]) if UV0 in offs else None
            idx = np.frombuffer(r.bytes(r.u64(ib + 0x10), nidx * 2), '<u2').astype(np.int64).reshape(-1, 3)
            geoms.append({'pos': pos, 'nrm': nrm, 'uv': uv, 'idx': idx,
                          'shader': shaders[sid] if sid < len(shaders) else {'name': 0, 'file': 0, 'textures': {}}})
    return geoms


# --------------------------------------------------------------------------- textures
def read_ytd(path, max_size=512):
    import texture2ddecoder as td
    from PIL import Image
    r = Res(path)
    tp, tcount = r.u64(SYS_BASE + 0x30), r.u16(SYS_BASE + 0x38)
    out = {}
    for i in range(tcount):
        t = r.u64(tp + 8 * i)
        name = r.cstr(r.u64(t + 0x28)).lower()
        w, h, _, stride, fmt = r.unpack('HHHHI', t + 0x50)
        levels = r.bytes(t + 0x5D, 1)[0]
        data = r.u64(t + 0x70)
        try:
            if fmt == 0x31545844:    # DXT1
                raw = td.decode_bc1(r.bytes(data, w * h // 2), w, h); mode = 'BGRA'
            elif fmt in (0x33545844, 0x35545844):    # DXT3 / DXT5
                raw = td.decode_bc3(r.bytes(data, w * h), w, h); mode = 'BGRA'
                if fmt == 0x33545844:
                    raw = _dxt3(r.bytes(data, w * h), w, h)
            elif fmt == 0x20374342:  # BC7
                raw = td.decode_bc7(r.bytes(data, w * h), w, h); mode = 'BGRA'
            elif fmt == 0x31495441:  # ATI1
                g = np.frombuffer(td.decode_bc4(r.bytes(data, w * h // 2), w, h), np.uint8).reshape(-1, 4)[:, 2]
                raw = np.stack([g, g, g, np.full_like(g, 255)], 1).tobytes(); mode = 'RGBA'
            elif fmt == 0x32495441:  # ATI2 (normal map)
                raw = td.decode_bc5(r.bytes(data, w * h), w, h); mode = 'BGRA'
            elif fmt in (21, 22, 32):
                raw = r.bytes(data, w * h * 4); mode = 'BGRA' if fmt != 32 else 'RGBA'
                if fmt == 22:
                    a = bytearray(raw); a[3::4] = b'\xff' * (w * h); raw = bytes(a)
            elif fmt in (28, 50):
                g = np.frombuffer(r.bytes(data, w * h), np.uint8)
                raw = np.stack([g, g, g, np.full_like(g, 255)], 1).tobytes(); mode = 'RGBA'
            else:
                continue
        except Exception as e:
            print('texture decode failed', name, hex(fmt), e)
            continue
        img = Image.frombuffer('RGBA', (w, h), raw, 'raw', mode, 0, 1)
        if max(w, h) > max_size:
            s = max_size / max(w, h)
            img = img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
        out[name] = img
    return out


def _dxt3(buf, w, h):
    """Decode DXT3 to BGRA (texture2ddecoder has no BC2): colour from the BC1 half, alpha explicit."""
    import texture2ddecoder as td
    a = np.frombuffer(buf, np.uint8).reshape(-1, 16)
    bw, bh = (w + 3) // 4, (h + 3) // 4
    col = np.zeros((a.shape[0], 8), np.uint8)
    col[:] = a[:, 8:]
    c = np.frombuffer(td.decode_bc1(col.tobytes(), w, h), np.uint8).reshape(h, w, 4).copy()
    al = np.zeros((a.shape[0], 16), np.uint8)
    al[:, 0::2] = (a[:, :8] & 0xF)
    al[:, 1::2] = (a[:, :8] >> 4)
    al = (al * 17).reshape(bh, bw, 4, 4).transpose(0, 2, 1, 3).reshape(bh * 4, bw * 4)[:h, :w]
    c[..., 3] = al
    return c.tobytes()


# --------------------------------------------------------------------------- meta
def meta_blocks(path):
    """Return list of (structure name hash, bytes) for a Meta (.ymap/.ytyp) resource."""
    r = Res(path)
    dbp, dbc = r.u64(SYS_BASE + 0x30), r.u16(SYS_BASE + 0x4C)
    out = []
    for i in range(dbc):
        h, ln, ptr = r.unpack('IiQ', dbp + 16 * i)
        out.append((h, r.bytes(ptr, ln)))
    return out


def read_entities(path):
    """CEntityDef (128 bytes) records from a ymap."""
    ents = []
    for h, b in meta_blocks(path):
        if h != joaat('CEntityDef'):
            continue
        for o in range(0, len(b) - 127, 128):
            arch, flags, guid = struct.unpack_from('<III', b, o + 8)
            pos = struct.unpack_from('<3f', b, o + 32)
            rot = struct.unpack_from('<4f', b, o + 48)
            sxy, sz = struct.unpack_from('<2f', b, o + 64)
            lod = struct.unpack_from('<f', b, o + 76)[0]
            ents.append({'arch': arch, 'flags': flags, 'pos': pos, 'rot': rot, 'sxy': sxy, 'sz': sz, 'lodDist': lod})
    return ents


def read_archetypes(path):
    """name hash -> (asset name hash, flags) from a ytyp (CBaseArchetypeDef, 144 bytes)."""
    out = {}
    for h, b in meta_blocks(path):
        if h not in (joaat('CBaseArchetypeDef'), joaat('CBaseArchetypeDef_v2')) and len(b) % 144:
            continue
        if h != joaat('CBaseArchetypeDef'):
            continue
        for o in range(0, len(b) - 143, 144):
            flags = struct.unpack_from('<I', b, o + 4)[0]
            name, asset = struct.unpack_from('<I', b, o + 72)[0], struct.unpack_from('<I', b, o + 96)[0]
            out[name] = (asset, flags)
    return out
