// Record IDs: UUIDv7 strings (RFC 9562), made wherever the record is created —
// the server today, the phone or Mac later when working offline (C2).
//
// Why UUIDv7: it is a standard UUID (any tool can store/validate it), it is
// time-ordered (IDs made later sort later, which keeps SQLite indexes tidy and
// lets a device's changes be replayed in order), and its 74 random bits make a
// clash between two devices practically impossible without coordination.
//
// Layout: 48-bit Unix ms timestamp | version 7 | 12-bit sequence | variant | 62 random bits.
// Within one millisecond on one device the 12-bit field counts up from a random
// start, so IDs from the same device are strictly increasing.

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let lastMs = -1;
let seq = 0;

function randomBytes(n) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Make a new UUIDv7 string, e.g. "019a1b2c-3d4e-7f01-8a2b-3c4d5e6f7a8b".
 * @param {number} [nowMs] override the clock (tests only)
 */
export function newId(nowMs = Date.now()) {
  let ms = Math.floor(nowMs);
  if (ms <= lastMs) {
    // Same (or earlier — clock moved back) millisecond: keep counting from the last one.
    ms = lastMs;
    seq += 1;
    if (seq > 0xfff) {
      ms += 1;
      seq = randomBytes(2)[0] & 0x7f; // leave headroom
    }
  } else {
    const r = randomBytes(2);
    seq = ((r[0] << 8) | r[1]) & 0x7ff; // random start, top bit clear for headroom
  }
  lastMs = ms;

  const b = randomBytes(16);
  // 48-bit timestamp, big-endian
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = (ms >>> 24) & 0xff;
  b[3] = (ms >>> 16) & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  // version 7 + 12-bit sequence
  b[6] = 0x70 | ((seq >>> 8) & 0x0f);
  b[7] = seq & 0xff;
  // RFC 4122 variant (10xx)
  b[8] = (b[8] & 0x3f) | 0x80;

  let s = '';
  for (let i = 0; i < 16; i++) {
    s += HEX[b[i]];
    if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
  }
  return s;
}

/** True if `value` is a lowercase UUIDv7 string as made by newId(). */
export function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

/** The creation time embedded in an ID, as a Date. */
export function idTime(id) {
  if (!isId(id)) throw new TypeError(`Not a suite ID: ${id}`);
  const hex = id.slice(0, 8) + id.slice(9, 13);
  return new Date(parseInt(hex, 16));
}
