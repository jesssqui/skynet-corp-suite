// Secrets for sign-in, all with node:crypto (no dependencies):
//   passwords        scrypt, parameters stored with each hash so they can be raised later
//   TOTP             RFC 6238 (HMAC-SHA1, 6 digits, 30 s) with RFC 4648 base32 secrets
//   recovery codes   12 random Crockford base32 characters (60 bits), stored as SHA-256
//   tokens           32 random bytes, base64url; only their SHA-256 is stored
// Every comparison of a secret with a guess is constant-time (timingSafeEqual).
import crypto from 'node:crypto';

// ---- passwords --------------------------------------------------------------

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 1024;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

// scrypt needs 128 * N * r bytes of memory per hash (64 MB at N = 2^16). At most two
// run at once, so a burst of sign-in attempts can't run the server out of memory.
const MAX_PARALLEL = 2;
let running = 0;
const waiting = [];
async function limited(fn) {
  if (running >= MAX_PARALLEL) await new Promise((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function scrypt(password, salt, n) {
  return limited(() => new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, KEY_LEN,
      { N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * n * SCRYPT_R }, (err, key) => (err ? reject(err) : resolve(key)));
  }));
}

/** "scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>" */
export async function hashPassword(password, n) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, n);
  return ['scrypt', n, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time check of a password against a stored hash (false for a malformed hash). */
export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  if (!Number.isInteger(n) || n < 2 || Number(parts[2]) !== SCRYPT_R || Number(parts[3]) !== SCRYPT_P) return false;
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(password, Buffer.from(parts[4], 'base64'), n);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** Problems with a new password, or null. Length is what matters; no composition rules. */
export function passwordProblem(password) {
  if (typeof password !== 'string') return 'Password is required';
  if ([...password].length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters`;
  return null;
}

// ---- base32 (RFC 4648, for TOTP secrets) ---------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---- TOTP (RFC 6238) ----------------------------------------------------------

export const TOTP = { period: 30, digits: 6, window: 1 };

export function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160 bits, the RFC 4226 recommendation
}

export const totpStep = (ms) => Math.floor(ms / 1000 / TOTP.period);

/** The code for one time step (RFC 4226 HOTP with the step as counter). */
export function hotp(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** TOTP.digits).padStart(TOTP.digits, '0');
}

export const totpCode = (secret, ms) => hotp(secret, totpStep(ms));

/**
 * Which time step a code belongs to (now, one before or one after, for clock drift),
 * or null. Checks every step in the window with a constant-time compare.
 * Steps at or before `afterStep` don't count: a code works once (no replays).
 */
export function matchTotp(secret, code, ms, afterStep = -1) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const now = totpStep(ms);
  let found = null;
  for (let s = now - TOTP.window; s <= now + TOTP.window; s++) {
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(secret, s)), given);
    if (ok && s > afterStep && found === null) found = s;
  }
  return found;
}

export function otpauthUrl({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const qs = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP.digits), period: String(TOTP.period) });
  // %20, not '+', for spaces: some authenticator apps show a '+' literally.
  return `otpauth://totp/${label}?${qs.toString().replace(/\+/g, '%20')}`;
}

// ---- recovery codes -------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_COUNT = 10;

/** "7KQ2-M9XD-4TPA": 12 characters, 60 random bits. */
export function newRecoveryCode() {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (const b of bytes) s += CROCKFORD[b & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Upper-case, drop spaces/dashes, read O as 0 and I/L as 1 (Crockford). Null if it can't be a code. */
export function normalizeRecoveryCode(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(s) ? s : null;
}

export const hashRecoveryCode = (normalized) => sha256(normalized);

// ---- tokens ---------------------------------------------------------------------

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Constant-time equality of two hex digests (or any two strings). */
export function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
