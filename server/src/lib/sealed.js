// A secret kept at rest in the database, unusable without a key file (D1's Order Manager secret;
// D16's Stockroom read key): AES-256-GCM with a 32-byte key in a file in the data folder (made on
// first use, mode 0600) — never in the database, so backups (and their off-machine copies) carry
// only the encrypted form. A database restored onto a machine without the key file can't read it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
