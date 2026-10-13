// MCUboot image header/TLV parsing and minimal .zip extraction.

const IMAGE_MAGIC = 0x96f3b83d;
const TLV_INFO_MAGIC = 0x6907;
const TLV_PROT_INFO_MAGIC = 0x6908;
const TLV_SHA256 = 0x10;
const TLV_SHA384 = 0x11;
const TLV_SHA512 = 0x12;

export const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

export function parseImage(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 32 || dv.getUint32(0, true) !== IMAGE_MAGIC) {
    throw new Error('not an MCUboot image (bad magic) - use the *.signed.bin');
  }
  const hdrSize = dv.getUint16(8, true);
  const protTlvSize = dv.getUint16(10, true);
  const imgSize = dv.getUint32(12, true);
  const flags = dv.getUint32(16, true);
  const version = `${dv.getUint8(20)}.${dv.getUint8(21)}.${dv.getUint16(22, true)}+${dv.getUint32(24, true)}`;

  let off = hdrSize + imgSize;
  if (protTlvSize) {
    if (dv.getUint16(off, true) !== TLV_PROT_INFO_MAGIC) throw new Error('bad protected TLV magic');
    off += protTlvSize;
  }
  if (off + 4 > data.length || dv.getUint16(off, true) !== TLV_INFO_MAGIC) throw new Error('bad TLV magic');
  const tlvEnd = off + dv.getUint16(off + 2, true);
  let hash = null;
  for (let p = off + 4; p + 4 <= tlvEnd;) {
    const type = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    if ([TLV_SHA256, TLV_SHA384, TLV_SHA512].includes(type)) hash = data.slice(p + 4, p + 4 + len);
    p += 4 + len;
  }
  return { version, hdrSize, imgSize, flags, hash, size: data.length };
}

// Returns [{name, read: () => Promise<Uint8Array>}] for every file in the zip.
export function listZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    entries.push({
      name,
      read: async () => {
        const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
        const comp = buf.subarray(start, start + csize);
        if (method === 0) return comp.slice();
        if (method !== 8) throw new Error(`unsupported zip method ${method}`);
        const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      },
    });
  }
  return entries;
}
