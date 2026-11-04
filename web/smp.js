// SMP (MCUmgr) client over Web Serial, using Zephyr's console framing:
// lines of `06 09 | 04 14` + base64 + '\n', each at most 127 bytes; the
// base64 stream carries [len BE16][packet][crc16-xmodem BE16].
import { encode, decode } from './cbor.js';

export const OP_READ = 0;
export const OP_WRITE = 2;
export const GRP_OS = 0;
export const GRP_IMG = 1;

const SMP_VERSION = 1;
const SMP_HDR_LEN = 8;
const FRAME_MAX = 127;                  // MCUMGR_SERIAL_MAX_FRAME
const B64_PER_FRAME = FRAME_MAX - 3;    // minus 2-byte marker and '\n'; multiple of 4
const BSTR_HDR_MAX = 3;                 // CBOR bstr head for lengths < 64 KiB

const MGMT_ERR = ['OK', 'EUNKNOWN', 'ENOMEM', 'EINVAL', 'ETIMEOUT', 'ENOENT', 'EBADSTATE',
  'EMSGSIZE', 'ENOTSUP', 'ECORRUPT', 'EBUSY', 'EACCESSDENIED', 'UNSUPPORTED_TOO_OLD',
  'UNSUPPORTED_TOO_NEW'];
const IMG_ERR = ['OK', 'UNKNOWN', 'FLASH_CONFIG_QUERY_FAIL', 'NO_IMAGE', 'NO_TLVS', 'INVALID_TLV',
  'TLV_MULTIPLE_HASHES_FOUND', 'TLV_INVALID_SIZE', 'HASH_NOT_FOUND', 'NO_FREE_SLOT',
  'FLASH_OPEN_FAILED', 'FLASH_READ_FAILED', 'FLASH_WRITE_FAILED', 'FLASH_ERASE_FAILED',
  'INVALID_SLOT', 'NO_FREE_MEMORY', 'FLASH_CONTEXT_ALREADY_SET', 'FLASH_CONTEXT_NOT_SET',
  'FLASH_AREA_DEVICE_NULL', 'INVALID_PAGE_OFFSET', 'INVALID_OFFSET', 'INVALID_LENGTH',
  'INVALID_IMAGE_HEADER', 'INVALID_IMAGE_HEADER_MAGIC', 'INVALID_HASH', 'INVALID_FLASH_ADDRESS',
  'VERSION_GET_FAILED', 'CURRENT_VERSION_IS_NEWER', 'IMAGE_ALREADY_PENDING',
  'INVALID_IMAGE_VECTOR_TABLE', 'INVALID_IMAGE_TOO_LARGE', 'INVALID_IMAGE_DATA_OVERRUN',
  'IMAGE_CONFIRMATION_DENIED', 'IMAGE_SETTING_TEST_TO_ACTIVE_DENIED', 'ACTIVE_SLOT_NOT_KNOWN'];

export class SmpError extends Error {
  constructor(msg, rsp) { super(msg); this.rsp = rsp; }
}
export class SmpTimeout extends Error {}

function crc16(buf) {
  let crc = 0;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function b64enc(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64dec(str) {
  const s = atob(str);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

function frame(pkt) {
  const raw = new Uint8Array(pkt.length + 4);
  const total = pkt.length + 2;
  const crc = crc16(pkt);
  raw[0] = total >> 8; raw[1] = total & 0xff;
  raw.set(pkt, 2);
  raw[raw.length - 2] = crc >> 8; raw[raw.length - 1] = crc & 0xff;
  const b64 = new TextEncoder().encode(b64enc(raw));
  const lines = [];
  for (let i = 0; i < b64.length; i += B64_PER_FRAME) {
    const part = b64.subarray(i, i + B64_PER_FRAME);
    const line = new Uint8Array(part.length + 3);
    line.set(i === 0 ? [0x06, 0x09] : [0x04, 0x14]);
    line.set(part, 2);
    line[line.length - 1] = 0x0a;
    lines.push(line);
  }
  return lines;
}

export function describeRc(rsp, group) {
  if (rsp.err) {
    const names = rsp.err.group === GRP_IMG ? IMG_ERR : null;
    return `group ${rsp.err.group} rc ${rsp.err.rc}${names?.[rsp.err.rc] ? ` (${names[rsp.err.rc]})` : ''}`;
  }
  return `rc ${rsp.rc}${MGMT_ERR[rsp.rc] ? ` (${MGMT_ERR[rsp.rc]})` : ''}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SmpSerial {
  constructor({ log = () => {}, onClose = () => {} } = {}) {
    this.log = log;
    this.onClose = onClose;
    this.port = null;
    this.seq = 0;
    this.pending = new Map();
    this.line = [];
    this.rx = null;
    this.lineDelayMs = 0;
  }

  get connected() { return !!this.port; }

  async open(port) {
    await port.open({ baudRate: 115200 });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.readDone = this._readLoop();
  }

  async close() {
    if (!this.port) return;
    const port = this.port;
    this.port = null;
    try { await this.reader?.cancel(); } catch {}
    await this.readDone;
    try { this.writer.releaseLock(); } catch {}
    try { await port.close(); } catch {}
    this._failPending(new Error('port closed'));
    this.onClose();
  }

  _failPending(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  async _readLoop() {
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const b of value) {
          if (b === 0x0a) { this._onLine(Uint8Array.from(this.line)); this.line = []; }
          else this.line.push(b);
        }
      }
    } catch (e) {
      if (this.port) this.log(`read error: ${e.message}`, 'err');
    } finally {
      this.reader.releaseLock();
      this.reader = null;
    }
    // Device went away (e.g. reset re-enumerates USB) rather than a user close.
    if (this.port) {
      const port = this.port;
      this.port = null;
      try { this.writer.releaseLock(); } catch {}
      try { await port.close(); } catch {}
      this._failPending(new Error('device disconnected'));
      this.onClose();
    }
  }

  _onLine(line) {
    let end = line.length;
    while (end && line[end - 1] === 0x0d) end--;
    line = line.subarray(0, end);
    if (line.length < 2) return;
    const start = line[0] === 0x06 && line[1] === 0x09;
    const cont = line[0] === 0x04 && line[1] === 0x14;
    if (!start && !cont) {
      this.log(`non-SMP: ${new TextDecoder().decode(line)}`, 'dim');
      return;
    }
    let dec;
    try { dec = b64dec(new TextDecoder().decode(line.subarray(2))); }
    catch { this.log('bad base64 in frame', 'err'); this.rx = null; return; }
    if (start) {
      if (dec.length < 2) return;
      this.rx = { len: (dec[0] << 8) | dec[1], parts: [dec.subarray(2)], got: dec.length - 2 };
    } else if (this.rx) {
      this.rx.parts.push(dec);
      this.rx.got += dec.length;
    } else return;
    if (this.rx.got < this.rx.len) return;
    const buf = new Uint8Array(this.rx.got);
    let o = 0;
    for (const p of this.rx.parts) { buf.set(p, o); o += p.length; }
    const len = this.rx.len;
    this.rx = null;
    if (buf.length !== len || crc16(buf) !== 0) { this.log('bad length/CRC in response', 'err'); return; }
    this._onPacket(buf.subarray(0, len - 2));
  }

  _onPacket(pkt) {
    if (pkt.length < SMP_HDR_LEN) return;
    const len = (pkt[2] << 8) | pkt[3];
    const group = (pkt[4] << 8) | pkt[5];
    const seq = pkt[6];
    const id = pkt[7];
    let body;
    try { body = decode(pkt.subarray(SMP_HDR_LEN, SMP_HDR_LEN + len)); }
    catch (e) { this.log(`CBOR decode failed: ${e.message}`, 'err'); return; }
    const p = this.pending.get(seq);
    if (!p || p.group !== group || p.id !== id) {
      this.log(`unmatched response seq=${seq} grp=${group} id=${id}`, 'dim');
      return;
    }
    this.pending.delete(seq);
    clearTimeout(p.timer);
    p.resolve(body);
  }

  packetLen(body) { return SMP_HDR_LEN + encode(body).length; }

  // Raw request: resolves with the decoded response map, rc included.
  async raw(op, group, id, body = {}, timeoutMs = 3000) {
    if (!this.port) throw new Error('not connected');
    const payload = encode(body);
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    const pkt = new Uint8Array(SMP_HDR_LEN + payload.length);
    pkt[0] = (SMP_VERSION << 3) | op;
    pkt[2] = payload.length >> 8; pkt[3] = payload.length & 0xff;
    pkt[4] = group >> 8; pkt[5] = group & 0xff;
    pkt[6] = seq; pkt[7] = id;
    pkt.set(payload, SMP_HDR_LEN);
    const rsp = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new SmpTimeout(`timeout (grp ${group} id ${id}, ${timeoutMs} ms)`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer, group, id });
    });
    try {
      for (const line of frame(pkt)) {
        await this.writer.write(line);
        if (this.lineDelayMs) await sleep(this.lineDelayMs);
      }
    } catch (e) {
      const p = this.pending.get(seq);
      if (p) { clearTimeout(p.timer); this.pending.delete(seq); }
      throw e;
    }
    return rsp;
  }

  // Request that throws SmpError on a non-zero rc / err.
  async request(op, group, id, body = {}, timeoutMs = 3000) {
    const rsp = await this.raw(op, group, id, body, timeoutMs);
    if ((rsp.rc ?? 0) !== 0 || (rsp.err && rsp.err.rc !== 0)) {
      throw new SmpError(describeRc(rsp, group), rsp);
    }
    return rsp;
  }

  echo(d) { return this.request(OP_WRITE, GRP_OS, 0, { d }); }
  reset(force = false) { return this.request(OP_WRITE, GRP_OS, 5, force ? { force: true } : {}); }
  imageList() { return this.request(OP_READ, GRP_IMG, 0, {}); }
  imageSet(hash, confirm) { return this.request(OP_WRITE, GRP_IMG, 0, hash ? { hash, confirm } : { confirm }); }
  imageErase(slot = 1) { return this.request(OP_WRITE, GRP_IMG, 5, { slot }, 30000); }

  // Upload an MCUboot image to `image` (slot pair). Packets are sized to `mtu`
  // bytes (SMP header + CBOR); the device's returned `off` drives the next chunk,
  // so a resent chunk after a timeout is harmless.
  async upload(data, { image = 0, mtu = 256, retries = 3, onProgress, signal } = {}) {
    const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    let off = 0;
    onProgress?.(0, data.length);
    while (off < data.length) {
      if (signal?.aborted) throw new DOMException('upload cancelled', 'AbortError');
      const first = off === 0;
      const meta = first ? { image, len: data.length, off, sha } : { off };
      const room = mtu - this.packetLen({ ...meta, data: new Uint8Array(0) }) - BSTR_HDR_MAX + 1;
      if (room <= 0) throw new Error(`MTU ${mtu} too small`);
      const body = { ...meta, data: data.subarray(off, off + room) };
      // First chunk erases the secondary slot before answering.
      const timeout = first ? 60000 : 5000;
      let rsp;
      for (let attempt = 0; ; attempt++) {
        try { rsp = await this.request(OP_WRITE, GRP_IMG, 1, body, timeout); break; }
        catch (e) {
          if (!(e instanceof SmpTimeout) || attempt >= retries) throw e;
          this.log(`chunk @${off} timed out, retry ${attempt + 1}/${retries}`, 'warn');
        }
      }
      if (typeof rsp.off !== 'number') throw new Error('upload response missing off');
      if (first && rsp.off > body.data.length && rsp.off < data.length) this.log(`device resumed upload at ${rsp.off}`, 'warn');
      off = rsp.off;
      onProgress?.(off, data.length);
    }
    return sha;
  }
}
