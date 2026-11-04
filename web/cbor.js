// Minimal CBOR codec for SMP payloads. Encodes definite-length only; decodes
// indefinite-length maps/arrays too, since zcbor emits them when not canonical.

export function encode(value) {
  const out = [];
  const head = (major, n) => {
    const m = major << 5;
    if (n < 24) out.push(m | n);
    else if (n < 0x100) out.push(m | 24, n);
    else if (n < 0x10000) out.push(m | 25, n >> 8, n & 0xff);
    else if (n < 0x100000000) out.push(m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    else throw new Error('CBOR: integer too large');
  };
  const chunks = [];
  const flush = () => { if (out.length) { chunks.push(Uint8Array.from(out)); out.length = 0; } };
  const enc = (v) => {
    if (v === null || v === undefined) out.push(0xf6);
    else if (v === false) out.push(0xf4);
    else if (v === true) out.push(0xf5);
    else if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new Error('CBOR: floats not supported');
      if (v >= 0) head(0, v); else head(1, -1 - v);
    } else if (typeof v === 'string') {
      const b = new TextEncoder().encode(v);
      head(3, b.length); flush(); chunks.push(b);
    } else if (v instanceof Uint8Array) {
      head(2, v.length); flush(); chunks.push(v);
    } else if (Array.isArray(v)) {
      head(4, v.length); v.forEach(enc);
    } else if (typeof v === 'object') {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      head(5, keys.length);
      for (const k of keys) { enc(k); enc(v[k]); }
    } else throw new Error(`CBOR: unsupported type ${typeof v}`);
  };
  enc(value);
  flush();
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf;
}

const BREAK = Symbol('break');

export function decode(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const arg = (info) => {
    if (info < 24) return info;
    if (info === 24) return dv.getUint8(p++);
    if (info === 25) { const v = dv.getUint16(p); p += 2; return v; }
    if (info === 26) { const v = dv.getUint32(p); p += 4; return v; }
    if (info === 27) { const v = Number(dv.getBigUint64(p)); p += 8; return v; }
    if (info === 31) return -1;
    throw new Error(`CBOR: bad additional info ${info}`);
  };
  const bytes = (n) => { const b = buf.slice(p, p + n); p += n; return b; };
  const concatStr = (major) => {
    const parts = [];
    for (;;) { const v = item(); if (v === BREAK) break; parts.push(v); }
    if (major === 3) return parts.join('');
    const len = parts.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of parts) { out.set(c, o); o += c.length; }
    return out;
  };
  const item = () => {
    const ib = dv.getUint8(p++);
    const major = ib >> 5, info = ib & 0x1f;
    if (ib === 0xff) return BREAK;
    switch (major) {
      case 0: return arg(info);
      case 1: return -1 - arg(info);
      case 2: case 3: {
        const n = arg(info);
        if (n < 0) return concatStr(major);
        const b = bytes(n);
        return major === 3 ? new TextDecoder().decode(b) : b;
      }
      case 4: {
        const n = arg(info), a = [];
        if (n < 0) { for (;;) { const v = item(); if (v === BREAK) break; a.push(v); } }
        else for (let i = 0; i < n; i++) a.push(item());
        return a;
      }
      case 5: {
        const n = arg(info), m = {};
        if (n < 0) { for (;;) { const k = item(); if (k === BREAK) break; m[k] = item(); } }
        else for (let i = 0; i < n; i++) { const k = item(); m[k] = item(); }
        return m;
      }
      case 6: arg(info); return item(); // ignore tags
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) { const v = dv.getFloat16 ? dv.getFloat16(p) : NaN; p += 2; return v; }
        if (info === 26) { const v = dv.getFloat32(p); p += 4; return v; }
        if (info === 27) { const v = dv.getFloat64(p); p += 8; return v; }
        throw new Error(`CBOR: unsupported simple ${info}`);
    }
    throw new Error('CBOR: unreachable');
  };
  return buf.length ? item() : {};
}
