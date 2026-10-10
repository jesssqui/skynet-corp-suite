// A fake Stockroom for D16's tests: Stockroom's read-only suite API (its package B5, `src/api/suite.ts`)
// on a local port, with the same contract —
//   - only GET: every other method is answered 405 (Allow: GET) before anything else;
//   - signed: X-SL-Reader + X-SL-Timestamp (unix s) + X-SL-Signature = hex HMAC-SHA256(secret,
//     `${ts}\nGET\n${path-with-query}\n${sha256hex('')}`), 300 s window, a fresh `nonce` (16–64 of
//     A–Z a–z 0–9 _ -) on every call, each signature accepted once (401 `replayed`), timestamps from
//     before it "started" refused (`stale_timestamp`), 401 `revoked` only to a correctly signed call;
//   - unknown query parameters → 400 unknown_param;
//   - { version: 1, as_of, …body } with a weak ETag over the body; If-None-Match → 304.
// It records every request (method, path, headers, body length) so tests can prove the suite only reads.
import http from 'node:http';
import crypto from 'node:crypto';

export const READER_KEY = 'suite.0123456789ab';
export const READER_SECRET = 'ab'.repeat(32);
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The connection code Stockroom would show for this reader. */
export function connectionCode({ url, key = READER_KEY, secret = READER_SECRET }) {
  return `SLR1.${Buffer.from(JSON.stringify({ u: url, k: key, s: secret })).toString('base64url')}`;
}

/** Empty answers for every read (tests replace them). */
export function emptyState() {
  return {
    'order-soon': { today: null, list: 'order_soon', items: [] },
    counts: { last_spot_check: null, spot_check_suggestions: [] },
    differences: { threshold_tins: 3, open: 0, truncated: false, items: [] },
    deliveries: { purchase_orders: 'here', today: null, counts: { orders: 0, tins: 0, overdue: 0 }, items: [] },
  };
}

/**
 * Start it. `now` = the clock it checks timestamps against (the suite's test clock, so moving it
 * days ahead keeps the two in step). → { url, state, requests, revoked, fail, delayMs, restart(), close() }
 */
export async function startFakeHub(t, { now = Date.now, key = READER_KEY, secret = READER_SECRET } = {}) {
  const hub = {
    state: emptyState(),
    requests: [],
    revoked: false,
    /** Answer the next correctly signed call 401 stale_timestamp (as after a Stockroom restart). */
    staleOnce: false,
    /** endpoint → { status, times } : answer that status instead (times: how many calls; Infinity = until cleared). */
    fail: {},
    /** endpoint → ms to wait before answering (time-out tests). */
    delayMs: {},
    startedS: Math.floor(now() / 1000) - 1,
    seen: new Set(),
    asOf: () => new Date(now()).toISOString(),
  };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === null ? undefined : JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      hub.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, bodyLength: Buffer.byteLength(raw) });
      if (req.method !== 'GET') return send(res, 405, { code: 'method_not_allowed', message: 'The suite connection is read-only: only GET.' }, { allow: 'GET' });
      if (!url.pathname.startsWith('/v1/suite')) return send(res, 404, { code: 'not_found' });
      const h = (k) => req.headers[k];
      const ts = h('x-sl-timestamp');
      const sig = h('x-sl-signature');
      if (h('x-sl-reader') !== key || !ts || !sig) return send(res, 401, { code: 'unauthorized', reason: !ts || !sig ? 'missing_headers' : 'bad_signature' });
      if (!/^\d+$/.test(ts)) return send(res, 401, { code: 'unauthorized', reason: 'bad_timestamp' });
      if (Math.abs(Math.floor(now() / 1000) - Number(ts)) > 300) return send(res, 401, { code: 'unauthorized', reason: 'stale_timestamp' });
      const expect = crypto.createHmac('sha256', secret).update(`${ts}\nGET\n${req.url}\n${sha256hex(raw)}`).digest('hex');
      if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return send(res, 401, { code: 'unauthorized', reason: 'bad_signature' });
      if (hub.revoked) return send(res, 401, { code: 'unauthorized', reason: 'revoked' });
      if (hub.staleOnce) {
        hub.staleOnce = false; // "signed just before a restart"
        return send(res, 401, { code: 'unauthorized', reason: 'stale_timestamp' });
      }
      if (Number(ts) < hub.startedS) return send(res, 401, { code: 'unauthorized', reason: 'stale_timestamp' });
      const nonce = url.searchParams.get('nonce');
      if (nonce === null) return send(res, 401, { code: 'unauthorized', reason: 'missing_nonce' });
      if (!NONCE_RE.test(nonce)) return send(res, 401, { code: 'unauthorized', reason: 'bad_nonce' });
      if (hub.seen.has(sig)) return send(res, 401, { code: 'unauthorized', reason: 'replayed' });
      hub.seen.add(sig);
      for (const k of url.searchParams.keys()) if (k !== 'nonce') return send(res, 400, { code: 'unknown_param', param: k });
      const endpoint = url.pathname === '/v1/suite' ? '' : url.pathname.slice('/v1/suite/'.length);
      if (hub.delayMs[endpoint]) await new Promise((r) => setTimeout(r, hub.delayMs[endpoint]));
      const f = hub.fail[endpoint];
      if (f && f.times > 0) {
        f.times -= 1;
        return send(res, f.status, { code: f.status >= 500 ? 'internal' : 'bad_request' });
      }
      let body;
      if (endpoint === '') body = { hub: 'Stockroom', reader: { key, name: 'Skynet Corp Suite', scope: 'suite' }, read_only: true };
      else if (Object.hasOwn(hub.state, endpoint)) body = hub.state[endpoint];
      else return send(res, 404, { code: 'not_found' });
      const etag = `W/"${crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 32)}"`;
      const inm = String(h('if-none-match') ?? '');
      if (inm && inm.split(',').map((x) => x.trim().replace(/^W\//, '')).includes(etag.slice(2))) {
        res.writeHead(304, { etag, 'cache-control': 'no-store' });
        return res.end();
      }
      send(res, 200, { version: 1, as_of: hub.asOf(), ...body }, { etag, 'cache-control': 'no-store' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  hub.url = `http://127.0.0.1:${server.address().port}`;
  hub.code = connectionCode({ url: hub.url, key, secret });
  /** Calls to one read (path /v1/suite/<endpoint>), not counting 405s. */
  hub.calls = (endpoint) => hub.requests.filter((r) => r.path === `/v1/suite${endpoint ? `/${endpoint}` : ''}`).length;
  /** "Restart": signatures forgotten, earlier timestamps refused. */
  hub.restart = () => { hub.seen.clear(); hub.startedS = Math.floor(now() / 1000); };
  let closed = false;
  hub.close = () => new Promise((r) => {
    if (closed) return r();
    closed = true;
    server.closeAllConnections?.();
    server.close(() => r());
  });
  t.after(hub.close);
  return hub;
}
