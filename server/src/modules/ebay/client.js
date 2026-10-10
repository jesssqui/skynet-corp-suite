// The suite's side of eBay (D13): Save Point Shop's orders, read with the seller's own sign-in (OAuth, scope
// sell.fulfillment.readonly). READ-ONLY BY CONSTRUCTION: `call()` below is the module's one network call, and it
// makes exactly two kinds of request —
//   GET  <api>/sell/fulfillment/v1/order            getOrders (the only data read; Bearer = the seller's access token)
//   POST <api>/identity/v1/oauth2/token             the token endpoint (a code → tokens; a refresh token → an access
//                                                   token): OAuth needs a POST there, and nothing else is ever POSTed
// Any other method or path is refused before a request is made. No redirect is followed. The consent page
// (<auth>/oauth2/authorize) is opened by the person's browser, never fetched by the server.
//
// Hosts: api.ebay.com and auth.ebay.com (production), replaceable for tests (config.ebay.apiUrl / authUrl: https
// only, http just for this machine).
export const ORDERS_PATH = '/sell/fulfillment/v1/order';
export const TOKEN_PATH = '/identity/v1/oauth2/token';
export const AUTHORIZE_PATH = '/oauth2/authorize';
/**
 * The scopes the suite asks for — the minimum: getOrders (orders, their totals, refunds, cancellations and ship-by
 * dates) needs sell.fulfillment or sell.fulfillment.readonly, and the read-only one is enough. Not asked for:
 * sell.finances (payouts, a different figure; it is "view and manage … initiate refunds" — eBay has no read-only
 * finances scope), sell.analytics.readonly (traffic reports: no sales amounts), commerce.identity.readonly (the
 * account name comes from the orders' sellerId instead).
 */
export const SCOPES = Object.freeze(['https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly']);

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{9,99}$/; // e.g. SavePoin-suite-PRD-1a2b3c4d5-6e7f8a9b
const CERT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{9,99}$/; // e.g. PRD-1a2b3c4d5e6f-7a8b-9c0d-1e2f-3a4b
const RUNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{4,99}$/; // e.g. Save_Point_Shop-SavePoin-suite-abcdefgh

/** A plain-English problem with eBay or a call; `code` for the code. Never carries a secret or a token. */
export class EbayError extends Error {
  constructor(code, message, { status = null, reason = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

/** https only (http just for this machine: tests). → the origin, no trailing slash. */
export function cleanBase(value, what = 'eBay') {
  let u;
  try {
    u = new URL(String(value ?? ''));
  } catch {
    throw new Error(`${what}: not an address: ${value}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error(`${what} must be https: ${value}`);
  return u.origin;
}

/** The keyset as eBay shows it (Application Keys, Production). → { appId, certId, ruName } or throws EbayError. */
export function parseKeyset({ appId, certId, ruName }) {
  const a = String(appId ?? '').trim();
  const c = String(certId ?? '').trim();
  const r = String(ruName ?? '').trim();
  if (!APP_ID_RE.test(a)) throw new EbayError('bad_app_id', 'The App ID (Client ID) is the long name under Production → App ID on eBay’s Application Keys page');
  if (/-SBX-/.test(a)) throw new EbayError('bad_app_id', 'That is a Sandbox App ID: use the Production keyset');
  if (!CERT_ID_RE.test(c)) throw new EbayError('bad_cert_id', 'The Cert ID (Client Secret) is under Production → Cert ID on eBay’s Application Keys page');
  if (!RUNAME_RE.test(r) || /^https?:/i.test(r)) throw new EbayError('bad_runame', 'The RuName is the eBay Redirect URL name (User Tokens → Get a Token from eBay via Your Application), not the accept URL itself');
  return { appId: a, certId: c, ruName: r };
}

/** The page the person's browser opens to agree (eBay's consent page). Nothing is fetched. */
export function consentUrl({ authUrl, appId, ruName, state, scopes = SCOPES }) {
  const u = new URL(`${cleanBase(authUrl, 'eBay sign-in')}${AUTHORIZE_PATH}`);
  u.searchParams.set('client_id', appId);
  u.searchParams.set('redirect_uri', ruName);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('state', state);
  return u.toString();
}

/** The address eBay sent the browser to after "I agree" (pasted, or the accept page's own) → { code, state } or null. */
export function codeFromUrl(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  let u;
  try {
    u = new URL(t.startsWith('http') ? t : `https://x.invalid/?${t.replace(/^[?#]/, '')}`);
  } catch {
    return null;
  }
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  return code && state ? { code, state } : null;
}

/** eBay's error answers in plain English (no tokens, no secrets). */
function problem(status, body) {
  const err = body?.error ?? body?.errors?.[0]?.errorId ?? null;
  if (status === 401 && (err === 'invalid_client' || body?.error === 'invalid_client')) return new EbayError('bad_keyset', 'eBay refused the App ID and Cert ID (check them on eBay’s Application Keys page, Production)', { status, reason: 'invalid_client' });
  if (err === 'invalid_grant') return new EbayError('invalid_grant', 'eBay refused the sign-in (it expired, was used already, or access was taken back): sign in to eBay again', { status, reason: 'invalid_grant' });
  if (status === 401) return new EbayError('unauthorized', 'eBay refused the access token', { status, reason: String(err ?? '') || null });
  if (status === 403) return new EbayError('forbidden', 'eBay says the sign-in can’t read orders (the scope wasn’t granted)', { status });
  if (status === 429) return new EbayError('rate_limited', 'eBay asks the suite to slow down (too many calls today)', { status });
  const msg = body?.error_description ?? body?.errors?.[0]?.message ?? null;
  return new EbayError('http', `eBay answered ${status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}`, { status, reason: String(err ?? '') || null });
}

/**
 * The client for one keyset. get(accessToken, query) → getOrders' JSON; token(form) → the token endpoint's JSON.
 * `fetchImpl` is replaceable (tests).
 */
export function createEbayClient({ apiUrl, appId, certId, timeoutMs = 20_000, fetchImpl = globalThis.fetch }) {
  const api = cleanBase(apiUrl, 'eBay API');
  const basic = `Basic ${Buffer.from(`${appId}:${certId}`).toString('base64')}`;

  /** The one network call: a GET of getOrders, or the POST to the token endpoint — nothing else. */
  async function call(method, path, { query = null, form = null, bearer = null } = {}) {
    const allowed = (method === 'GET' && path === ORDERS_PATH) || (method === 'POST' && path === TOKEN_PATH);
    if (!allowed) throw new EbayError('bad_call', `Not a call the suite makes: ${method} ${path}`);
    const u = new URL(`${api}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    const headers = { accept: 'application/json' };
    if (method === 'POST') {
      headers.authorization = basic;
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else {
      if (!bearer) throw new EbayError('no_token', 'Not signed in to eBay');
      headers.authorization = `Bearer ${bearer}`;
    }
    let res;
    try {
      res = await fetchImpl(u.toString(), {
        method, headers, body: method === 'POST' ? new URLSearchParams(form).toString() : undefined, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new EbayError(timeout ? 'timeout' : 'network', timeout ? `eBay didn’t answer within ${Math.round(timeoutMs / 1000)} s` : `Can’t reach eBay (${err?.cause?.code ?? err?.message ?? 'network error'})`);
    }
    if (res.status >= 300 && res.status < 400) throw new EbayError('redirect', 'eBay answered with a redirect (not followed)', { status: res.status });
    const text = await res.text().catch(() => '');
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.status !== 200) throw problem(res.status, body);
    if (!body || typeof body !== 'object') throw new EbayError('bad_answer', 'eBay’s answer wasn’t readable', { status: 200 });
    return body;
  }

  return {
    /** getOrders (filter, limit, offset, fieldGroups). */
    orders: (accessToken, query) => call('GET', ORDERS_PATH, { query, bearer: accessToken }),
    /** The token endpoint: { grant_type: 'authorization_code', code, redirect_uri } or { grant_type: 'refresh_token', refresh_token, scope }. */
    token(form) {
      if (!['authorization_code', 'refresh_token'].includes(form?.grant_type)) throw new EbayError('bad_call', 'Not a token request the suite makes');
      return call('POST', TOKEN_PATH, { form });
    },
  };
}
