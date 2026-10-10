// The suite's side of Stockroom's read-only connection (hub package B5): signed GET calls to
// `<hub>/v1/suite/*`, made from the Mac over HTTPS to Fly. READ-ONLY BY CONSTRUCTION: `get()` is the
// only call there is, its method is fixed to GET and it never sends a body — no code path in the
// suite can ask Stockroom to change anything (and Stockroom answers every other method 405 anyway).
//
// Signing (Stockroom's `src/api/suite.ts`, DECISIONS.md "Read-only connection for the Skynet Corp Suite"):
//   X-SL-Reader     the key ("suite.<12 hex>")
//   X-SL-Timestamp  unix seconds
//   X-SL-Signature  hex HMAC-SHA256(secret, `${ts}\nGET\n${path-with-query}\n${sha256hex('')}`)
// and every call carries a fresh `nonce` query parameter (part of the signed path; each signature is
// accepted once). ETags: send the last one as If-None-Match → 304 when nothing changed.
//
// The connection code Stockroom shows once (Settings → Connections → Connect the suite):
//   SLR1.<base64url JSON {u: hub url, k: key, s: secret}>
import crypto from 'node:crypto';

export const CODE_PREFIX = 'SLR1.';
const KEY_RE = /^suite\.[0-9a-f]{12}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;
/** The answer version this suite reads (Stockroom bumps it only to rename or remove a field). */
export const SUITE_VERSION = 1;

/** A plain-English problem with the connection or a call; `code` for the code, never a secret in it. */
export class StockroomError extends Error {
  constructor(code, message, { status = null, reason = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

/**
 * The hub address: https (http only for this machine — tests and a hub run locally), no query or
 * fragment, no trailing slash. → "https://stockroom-hub.fly.dev" or throws StockroomError.
 */
export function cleanHubUrl(value) {
  let u;
  try {
    u = new URL(String(value ?? '').trim());
  } catch {
    throw new StockroomError('bad_url', 'The Stockroom address isn’t a web address (like https://stockroom-hub.fly.dev)');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new StockroomError('bad_url', 'The Stockroom address must start with https://');
  }
  if (u.search || u.hash || u.username || u.password) throw new StockroomError('bad_url', 'The Stockroom address has extra parts: use just https://<name>.fly.dev');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * What a person pastes: the connection code (`SLR1.…`), or the three parts. → { url, key, secret }
 * (checked: the key's and secret's shapes), or throws StockroomError.
 */
export function parseConnection({ code = null, url = null, key = null, secret = null } = {}) {
  let parts = { url, key, secret };
  if (code !== null && code !== undefined && String(code).trim()) {
    const c = String(code).trim();
    if (c.startsWith('SL1.')) throw new StockroomError('bad_code', 'That is a store’s code (SL1.…). Use Stockroom → Settings → Connections → Connect the suite (SLR1.…)');
    if (!c.startsWith(CODE_PREFIX)) throw new StockroomError('bad_code', 'Not a Stockroom suite code: it starts with SLR1.');
    try {
      const o = JSON.parse(Buffer.from(c.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
      parts = { url: o.u, key: o.k, secret: o.s };
    } catch {
      throw new StockroomError('bad_code', 'The code is cut short or changed: copy it again from Stockroom');
    }
  }
  const out = {
    url: cleanHubUrl(parts.url),
    key: String(parts.key ?? '').trim(),
    secret: String(parts.secret ?? '').trim().toLowerCase(),
  };
  if (!KEY_RE.test(out.key)) throw new StockroomError('bad_key', 'The key looks like suite.<12 letters and digits>');
  if (!SECRET_RE.test(out.secret)) throw new StockroomError('bad_secret', 'The secret is 64 letters and digits (0–9, a–f)');
  return out;
}

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Stockroom's signature for a GET (the body is always empty). */
export function signGet(secret, ts, pathWithQuery) {
  return crypto.createHmac('sha256', secret).update(`${ts}\nGET\n${pathWithQuery}\n${sha256hex('')}`).digest('hex');
}

/** A fresh nonce (24 base64url characters; Stockroom wants 16–64 of A–Z a–z 0–9 _ -). */
export const newNonce = () => crypto.randomBytes(18).toString('base64url');

/** What a 401 reason means, in plain English. */
const REASONS = {
  revoked: 'Disconnected in Stockroom: make a new connection there (Settings → Connections) and paste its code here',
  bad_signature: 'Stockroom refused the key or secret: paste the connection code again (or make a new secret in Stockroom)',
  stale_timestamp: 'Stockroom says this Mac’s clock is off by more than 5 minutes (or Stockroom just restarted)',
  replayed: 'Stockroom saw the same signed call twice (a bug in the suite)',
  missing_headers: 'Stockroom didn’t get the signature',
  bad_timestamp: 'Stockroom didn’t understand the time sent',
  missing_nonce: 'Stockroom wants a nonce on every call',
  bad_nonce: 'Stockroom refused the nonce',
};

/**
 * Make the read client for one connection. `fetchImpl` is replaceable (tests); `now` = ms clock.
 * get(path, { etag }) → { status: 200, body, etag } | { status: 304, etag } — throws StockroomError.
 */
export function createStockroomClient({ url, key, secret, timeoutMs = 15_000, fetchImpl = globalThis.fetch, now = Date.now }) {
  const base = new URL(cleanHubUrl(url));

  async function once(path, etag) {
    const u = new URL(base.toString());
    u.pathname = `${base.pathname.replace(/\/$/, '')}${path}`;
    u.search = '';
    u.searchParams.set('nonce', newNonce());
    const signed = `${u.pathname}${u.search}`;
    const ts = Math.floor(now() / 1000);
    const headers = {
      accept: 'application/json',
      'x-sl-reader': key,
      'x-sl-timestamp': String(ts),
      'x-sl-signature': signGet(secret, ts, signed),
      ...(etag ? { 'if-none-match': etag } : {}),
    };
    let res;
    try {
      // GET, no body, no cookies, no redirects followed (a redirect would be signed for another path).
      res = await fetchImpl(u.toString(), { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new StockroomError(timeout ? 'timeout' : 'network',
        timeout ? `Stockroom didn’t answer within ${Math.round(timeoutMs / 1000)} s` : `Can’t reach Stockroom (${err?.cause?.code ?? err?.message ?? 'network error'})`);
    }
    if (res.status === 304) return { status: 304, etag: res.headers.get('etag') ?? etag };
    const text = await res.text().catch(() => '');
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.status === 401) {
      const reason = body?.reason ?? null;
      throw new StockroomError(reason === 'revoked' ? 'revoked' : 'unauthorized', REASONS[reason] ?? 'Stockroom refused the call', { status: 401, reason });
    }
    if (res.status !== 200) {
      throw new StockroomError('http', `Stockroom answered ${res.status}${body?.code ? ` (${body.code})` : ''}`, { status: res.status, reason: body?.code ?? null });
    }
    if (!body || typeof body !== 'object') throw new StockroomError('bad_answer', 'Stockroom’s answer wasn’t readable', { status: 200 });
    if (body.version !== SUITE_VERSION) {
      throw new StockroomError('unsupported_version', `Stockroom answered version ${body.version}; this suite reads version ${SUITE_VERSION}: update the suite`, { status: 200 });
    }
    return { status: 200, body, etag: res.headers.get('etag') };
  }

  return {
    hubUrl: base.toString().replace(/\/$/, ''),
    /** The one call there is: a signed GET. `stale_timestamp` (signed just before a Stockroom restart) is re-signed once. */
    async get(path, { etag = null } = {}) {
      if (!/^\/v1\/suite(\/[a-z-]+)?$/.test(path)) throw new StockroomError('bad_path', `Not a suite read: ${path}`);
      try {
        return await once(path, etag);
      } catch (err) {
        if (err instanceof StockroomError && err.reason === 'stale_timestamp') return once(path, etag);
        throw err;
      }
    },
  };
}
