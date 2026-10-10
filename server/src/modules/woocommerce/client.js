// The suite's side of a WooCommerce store (D12): the store's REST API, read with the store's own READ key.
// READ-ONLY BY CONSTRUCTION: `get()` is the only call there is — its method is fixed to GET, it never sends a body,
// it follows no redirect, and it refuses any path that isn't on PATHS (below) before a request is made. No code
// path in the suite can create, change or delete anything in a store. (The key itself is also made with
// permission "Read" in WooCommerce — see the store's card — but the suite doesn't rely on that.)
//
// Auth: HTTP Basic with the consumer key and secret, over HTTPS only (WooCommerce's own way for HTTPS; never in the
// URL, so they can't reach a log). http only for this machine (tests, a store run locally).
//
// What it reads (each a GET):
//   /wp-json/                                         the site's name and time zone (public; no key sent)
//   /wp-json/wc/v3/data/currencies/current            the store's currency
//   /wp-json/wc-analytics/reports/revenue/stats       Analytics → Revenue, per day (the totals the owner sees)
//   /wp-json/wc/v3/orders  and  /wc/v3/orders/<id>    order lookups (live, never stored)
//   /wp-json/wc-shipment-tracking/v3/orders/<id>/shipments   tracking, when a tracking plugin offers it
export const PATHS = Object.freeze([
  /^\/wp-json\/$/,
  /^\/wp-json\/wc\/v3\/data\/currencies\/current$/,
  /^\/wp-json\/wc-analytics\/reports\/revenue\/stats$/,
  /^\/wp-json\/wc\/v3\/orders$/,
  /^\/wp-json\/wc\/v3\/orders\/\d{1,12}$/,
  /^\/wp-json\/wc-shipment-tracking\/v3\/orders\/\d{1,12}\/shipments$/,
]);
const PUBLIC_PATHS = new Set(['/wp-json/']);

const KEY_RE = /^ck_[0-9a-f]{40}$/;
const SECRET_RE = /^cs_[0-9a-f]{40}$/;

/** A plain-English problem with a store or a call; `code` for the code. Never carries the secret. */
export class WooError extends Error {
  constructor(code, message, { status = null, reason = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

/**
 * The store's address: https (http only for this machine), no query, fragment or login; a WordPress in a folder
 * keeps its path. → "https://tinsxpress.com" or throws WooError.
 */
export function cleanStoreUrl(value) {
  let text = String(value ?? '').trim();
  if (text && !/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new WooError('bad_url', 'The store’s address isn’t a web address (like https://tinsxpress.com)');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new WooError('bad_url', 'The store’s address must start with https://');
  if (u.search || u.hash || u.username || u.password) throw new WooError('bad_url', 'The store’s address has extra parts: use just https://<the shop’s domain>');
  const path = u.pathname.replace(/\/wp-json\/?.*$/, '').replace(/\/+$/, '');
  return `${u.origin}${path}`;
}

/** The store's key in the sales table: its address without the scheme ("tinsxpress.com", "shop.example.com/store"). */
export const storeKey = (url) => cleanStoreUrl(url).replace(/^https?:\/\//, '').toLowerCase();

/** The consumer key and secret as WooCommerce shows them (ck_… / cs_…, 40 hex each). → { key, secret } or throws. */
export function parseKeys({ key, secret }) {
  const k = String(key ?? '').trim();
  const s = String(secret ?? '').trim();
  if (!KEY_RE.test(k)) throw new WooError('bad_key', 'The consumer key starts with ck_ and has 40 letters and digits after it');
  if (!SECRET_RE.test(s)) throw new WooError('bad_secret', 'The consumer secret starts with cs_ and has 40 letters and digits after it');
  return { key: k, secret: s };
}

/** What WooCommerce's refusal codes mean, in plain English. */
function refusal(status, code) {
  if (status === 401) {
    return code === 'woocommerce_rest_authentication_error' || code === 'woocommerce_rest_cannot_view'
      ? 'The store refused the key: check the consumer key and secret (WooCommerce → Settings → Advanced → REST API)'
      : 'The store refused the key';
  }
  if (status === 403) return 'The key isn’t allowed to read this: the user it was made for needs to be a shop manager or an administrator';
  if (status === 404 && code === 'rest_no_route') return 'The store doesn’t offer this (is WooCommerce Analytics switched on, and the address right?)';
  return null;
}

/**
 * Make the read client for one store. `fetchImpl` is replaceable (tests). get(path, query) → { status: 200, body,
 * headers } — throws WooError for everything else.
 */
export function createWooClient({ url, key = null, secret = null, timeoutMs = 20_000, fetchImpl = globalThis.fetch }) {
  const base = cleanStoreUrl(url);
  const auth = key && secret ? `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` : null;

  return {
    url: base,
    /** The one call there is: a GET of an allowed path, no body, no redirects followed. */
    async get(path, query = {}) {
      if (!PATHS.some((re) => re.test(path))) throw new WooError('bad_path', `Not a read the suite makes: ${path}`);
      const u = new URL(`${base}${path}`);
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
      const headers = { accept: 'application/json' };
      if (!PUBLIC_PATHS.has(path)) {
        if (!auth) throw new WooError('no_key', 'No key for this store');
        headers.authorization = auth;
      }
      let res;
      try {
        res = await fetchImpl(u.toString(), { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        throw new WooError(timeout ? 'timeout' : 'network',
          timeout ? `The store didn’t answer within ${Math.round(timeoutMs / 1000)} s` : `Can’t reach the store (${err?.cause?.code ?? err?.message ?? 'network error'})`);
      }
      if (res.status >= 300 && res.status < 400) {
        const to = res.headers.get('location');
        throw new WooError('redirect', `The store sends this address elsewhere${to ? ` (${to.replace(/\?.*$/, '')})` : ''}: use the shop’s exact address`, { status: res.status });
      }
      const text = await res.text().catch(() => '');
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.status !== 200) {
        const code = body?.code ?? null;
        throw new WooError(res.status === 401 || res.status === 403 ? 'unauthorized' : 'http',
          refusal(res.status, code) ?? `The store answered ${res.status}${code ? ` (${code})` : ''}`, { status: res.status, reason: code });
      }
      if (body === null) throw new WooError('bad_answer', 'The store’s answer wasn’t readable (is this a WordPress site with WooCommerce?)', { status: 200 });
      return { status: 200, body, headers: { total: res.headers.get('x-wp-total'), totalPages: res.headers.get('x-wp-totalpages') } };
    },
  };
}
