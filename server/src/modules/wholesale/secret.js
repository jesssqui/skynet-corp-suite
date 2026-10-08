// The Order Manager connection's shared secret (D1): made here, shown once, stored encrypted, and
// the request signature it checks.
//
//  • The secret: 32 random bytes as base64url (43 characters; the Order Manager wants 16+).
//  • At rest: AES-256-GCM with a key kept in a file in the data folder (config.wholesale.keyFile,
//    made on first use, mode 0600) — never in the database. The secret can't be hashed: checking an
//    HMAC needs the secret itself. Backups (and their off-machine copies) carry only the encrypted
//    form; a database restored onto a machine without the key file can't read it, and the page says
//    to make a new one.
//  • The signature (the Order Manager's A10 / the hub's scheme): hex HMAC-SHA256(secret,
//    `${timestamp}\nPOST\n${path}\n${sha256hex(raw body)}`), path = pathname + query as sent;
//    compared in constant time; a timestamp more than 5 minutes from this clock is refused.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REPLAY_WINDOW_S = 5 * 60;

export const newSecret = () => crypto.randomBytes(32).toString('base64url');

/** The key file's 32 bytes, made when missing (create: false → null when missing). */
export function loadKey(file, { create = true } = {}) {
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
    throw new Error(`${file} is not a key file (64 hex characters)`);
  } catch (err) {
    if (err.code !== 'ENOENT' || !create) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = crypto.randomBytes(32);
  // 'wx': never overwrite a key another process just wrote.
  try {
    fs.writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (err) {
    if (err.code === 'EEXIST') return loadKey(file, { create: false });
    throw err;
  }
}

export function encryptSecret(key, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

/** The secret, or null when it can't be read with this key (another machine's key, a damaged value). */
export function decryptSecret(key, stored) {
  if (!key || typeof stored !== 'string') return null;
  const [v, iv, tag, ct] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function sign(secret, ts, method, pathAndQuery, rawBody) {
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  return crypto.createHmac('sha256', secret).update(`${ts}\n${method.toUpperCase()}\n${pathAndQuery}\n${bodyHash}`).digest('hex');
}

/**
 * Check one request's signature: null when good, else why not (plain English, no secrets).
 * @param {{ secret: string, timestamp: string|undefined, signature: string|undefined, method: string,
 *   path: string, rawBody: Buffer, nowMs: number }} r
 */
export function signatureProblem({ secret, timestamp, signature, method, path: p, rawBody, nowMs }) {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return { code: 'no_timestamp', message: 'No x-wom-timestamp header' };
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return { code: 'no_signature', message: 'No valid x-wom-signature header' };
  const expected = Buffer.from(sign(secret, timestamp, method, p, rawBody), 'hex');
  const given = Buffer.from(signature.toLowerCase(), 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { code: 'bad_signature', message: 'Wrong signature: the shared secret doesn’t match the suite’s' };
  }
  // Checked after the signature, so only a correctly signed request learns the clock is off.
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > REPLAY_WINDOW_S) {
    return { code: 'stale', message: 'Timestamp more than 5 minutes from the suite’s clock (a replay, or a clock that is off)' };
  }
  return null;
}
