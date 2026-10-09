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

export const REPLAY_WINDOW_S = 5 * 60;

export const newSecret = () => crypto.randomBytes(32).toString('base64url');

// The at-rest encryption lives in ../../lib/sealed.js (D16's Stockroom key uses it too).
export { loadKey, encryptSecret, decryptSecret } from '../../lib/sealed.js';

export function sign(secret, ts, method, pathAndQuery, rawBody) {
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  return crypto.createHmac('sha256', secret).update(`${ts}\n${method.toUpperCase()}\n${pathAndQuery}\n${bodyHash}`).digest('hex');
}

/**
 * Check one request's signature: null when good, else why not (plain English, no secrets).
 * @param {{ secret: string, timestamp: string|undefined, signature: string|undefined, method: string,
 *   path: string, rawBody: Buffer, nowMs: number }} r
 */
/** The headers' shape (checked before the body is read): null when both look right. */
export function headerProblem({ timestamp, signature }) {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return { code: 'no_timestamp', message: 'No x-wom-timestamp header' };
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return { code: 'no_signature', message: 'No valid x-wom-signature header' };
  return null;
}

export function signatureProblem({ secret, timestamp, signature, method, path: p, rawBody, nowMs }) {
  const bad = headerProblem({ timestamp, signature });
  if (bad) return bad;
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
