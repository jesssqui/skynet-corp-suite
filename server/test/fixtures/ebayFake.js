// A fake eBay for D13's tests: the token endpoint and getOrders, on a local port, from a list of orders the test
// controls —
//   POST /identity/v1/oauth2/token   Basic base64(appId:certId) (else 401 invalid_client); grant_type=authorization_code
//                                    (a code from authorize(), once, with redirect_uri = the RuName; else 400
//                                    invalid_grant) → access (2 h) + refresh (~18 months) tokens; grant_type=refresh_token
//                                    → a new access token (400 invalid_grant once the refresh token is revoked)
//   GET  /sell/fulfillment/v1/order  Bearer access token (else 401, errorId 1001); filter creationdate:[a..b] /
//                                    lastmodifieddate:[a..b] (creationdate wins when both) / orderfulfillmentstatus:{A|B};
//                                    limit ≤ 200 (more: 400), offset; orders oldest first; total, next; fieldGroups noted
// Anything else → 404 / 405. Orders carry a buyer (username, name, address, email) the suite must never keep. Every
// request is recorded (method, path, query, headers, body).
import http from 'node:http';

export const APP_ID = 'SavePoin-suite-PRD-1a2b3c4d5-6e7f8a9b';
export const CERT_ID = 'PRD-1a2b3c4d5e6f-7a8b-9c0d-1e2f-3a4b';
export const RU_NAME = 'Save_Point_Shop-SavePoin-suite-abcdefgh';
export const SELLER = 'thesavepointshop';

const money = (cents, currency) => ({ value: (cents / 100).toFixed(2), currency });
const c = (n) => Math.round(n * 100);

/**
 * An order (dollars; times ISO UTC): { id, created, modified?, status (NOT_STARTED|IN_PROGRESS|FULFILLED), payment
 * (PAID…), cancelled?, items: [{ title, sku, qty, price }], discount, shipping, shipDiscount, tax, currency,
 * refunds: [{ at, amount, status? }], shipBy, seller }.
 */
export function ebayOrder(o) {
  const cur = o.currency ?? 'CAD';
  const items = o.items ?? [{ title: 'Super Mario 64 (N64, cart only)', sku: 'N64-SM64', qty: 1, price: 45 }];
  const sub = items.reduce((a, i) => a + c(i.price) * i.qty, 0);
  const total = sub - c(o.discount ?? 0) + c(o.shipping ?? 0) - c(o.shipDiscount ?? 0) + c(o.tax ?? 0);
  return {
    orderId: o.id,
    legacyOrderId: `legacy-${o.id}`,
    creationDate: o.created,
    lastModifiedDate: o.modified ?? o.refunds?.at?.(-1)?.at ?? o.created,
    orderFulfillmentStatus: o.status ?? 'FULFILLED',
    orderPaymentStatus: o.payment ?? (o.refunds?.length ? 'PARTIALLY_REFUNDED' : 'PAID'),
    sellerId: o.seller ?? SELLER,
    buyer: { username: `buyer_${o.id}`, taxAddress: { city: 'Brantford', stateOrProvince: 'ON', postalCode: 'N3T 1A1', countryCode: 'CA' } },
    buyerCheckoutNotes: 'please leave it at the side door',
    pricingSummary: {
      priceSubtotal: money(sub, cur),
      ...(o.discount ? { priceDiscount: money(-c(o.discount), cur) } : {}),
      deliveryCost: money(c(o.shipping ?? 0), cur),
      ...(o.shipDiscount ? { deliveryDiscount: money(-c(o.shipDiscount), cur) } : {}),
      ...(o.tax ? { tax: money(c(o.tax), cur) } : {}),
      total: money(total, cur),
    },
    cancelStatus: { cancelState: o.cancelled ? 'CANCELED' : 'NONE_REQUESTED', cancelRequests: [], ...(o.cancelled ? { cancelledDate: o.modified ?? o.created } : {}) },
    paymentSummary: {
      payments: [{ paymentMethod: 'EBAY', paymentStatus: 'PAID', amount: money(total, cur), paymentDate: o.created }],
      refunds: (o.refunds ?? []).map((r, i) => ({ refundId: `r${o.id}-${i}`, refundStatus: r.status ?? 'REFUNDED', refundDate: r.at, amount: money(c(r.amount), cur) })),
      totalDueSeller: money(total, cur),
    },
    fulfillmentStartInstructions: [{
      fulfillmentInstructionsType: 'SHIP_TO',
      shippingStep: { shipTo: { fullName: `Buyer Fullname ${o.id}`, contactAddress: { addressLine1: '12 Secret Lane', city: 'Brantford', postalCode: 'N3T 1A1' }, primaryPhone: { phoneNumber: '5195550100' }, email: `buyer${o.id}@example.com` } },
    }],
    lineItems: items.map((i, n) => ({
      lineItemId: `${o.id}-${n}`, legacyItemId: `11000${n}`, title: i.title, sku: i.sku, quantity: i.qty,
      lineItemCost: money(c(i.price) * i.qty, cur), total: money(c(i.price) * i.qty, cur), refunds: [],
      lineItemFulfillmentStatus: o.status ?? 'FULFILLED',
      lineItemFulfillmentInstructions: { shipByDate: o.shipBy ?? null, guaranteedDelivery: false },
    })),
  };
}

const parseRange = (text) => {
  const m = /^\[([^\].]*)\.\.([^\]]*)\]$/.exec(text);
  return m ? { from: m[1] || null, to: m[2] || null } : null;
};
function parseFilter(filter) {
  const out = {};
  for (const part of String(filter ?? '').split(/,(?=[a-z]+:)/)) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i);
    const v = part.slice(i + 1);
    if (k === 'creationdate' || k === 'lastmodifieddate') out[k] = parseRange(v);
    if (k === 'orderfulfillmentstatus') out.status = v.replace(/[{}]/g, '').split('|');
  }
  return out;
}

export async function startFakeEbay(t, { now = Date.now } = {}) {
  const ebay = { orders: [], requests: [], codes: new Map(), access: new Map(), refresh: null, revoked: false, fail: {}, delayMs: 0, accessSeconds: 7200 };
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      ebay.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw });
      if (ebay.delayMs) await new Promise((r) => setTimeout(r, ebay.delayMs));
      const f = ebay.fail[url.pathname];
      if (f && f.times > 0) {
        f.times -= 1;
        return send(res, f.status, { errors: [{ errorId: 10001, message: 'Failing on purpose' }] });
      }
      if (url.pathname === '/identity/v1/oauth2/token') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method' });
        if (req.headers.authorization !== `Basic ${Buffer.from(`${APP_ID}:${CERT_ID}`).toString('base64')}`) return send(res, 401, { error: 'invalid_client', error_description: 'client authentication failed' });
        const form = new URLSearchParams(raw);
        if (form.get('grant_type') === 'authorization_code') {
          const code = form.get('code');
          const entry = ebay.codes.get(code);
          if (!entry || entry.used || form.get('redirect_uri') !== RU_NAME) return send(res, 400, { error: 'invalid_grant', error_description: 'the provided authorization grant code is invalid or was issued to another client' });
          entry.used = true;
          ebay.refresh = `v^1.1#i^1#refresh-${Math.random().toString(36).slice(2)}`;
          ebay.revoked = false;
          const token = `v^1.1#i^1#access-${Math.random().toString(36).slice(2)}`;
          ebay.access.set(token, now() + ebay.accessSeconds * 1000);
          return send(res, 200, { access_token: token, expires_in: ebay.accessSeconds, refresh_token: ebay.refresh, refresh_token_expires_in: 47_304_000, token_type: 'User Access Token' });
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (ebay.revoked || form.get('refresh_token') !== ebay.refresh) return send(res, 400, { error: 'invalid_grant', error_description: 'the provided authorization refresh token is invalid or was issued to another client' });
          const token = `v^1.1#i^1#access-${Math.random().toString(36).slice(2)}`;
          ebay.access.set(token, now() + ebay.accessSeconds * 1000);
          return send(res, 200, { access_token: token, expires_in: ebay.accessSeconds, token_type: 'User Access Token' });
        }
        return send(res, 400, { error: 'unsupported_grant_type' });
      }
      if (url.pathname === '/sell/fulfillment/v1/order') {
        if (req.method !== 'GET') return send(res, 405, { errors: [{ errorId: 2003, message: 'method not allowed' }] });
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        const until = ebay.access.get(bearer);
        if (!until || until < now()) return send(res, 401, { errors: [{ errorId: 1001, message: 'Invalid access token' }] });
        const limit = Number(url.searchParams.get('limit') ?? 50);
        if (limit > 200) return send(res, 400, { errors: [{ errorId: 30700, message: 'limit over 200' }] });
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const fl = parseFilter(url.searchParams.get('filter'));
        let list = [...ebay.orders];
        const range = fl.creationdate ? ['creationDate', fl.creationdate] : fl.lastmodifieddate ? ['lastModifiedDate', fl.lastmodifieddate] : null;
        if (range) list = list.filter((o) => (!range[1].from || o[range[0]] >= range[1].from) && (!range[1].to || o[range[0]] <= range[1].to));
        if (fl.status) list = list.filter((o) => fl.status.includes(o.orderFulfillmentStatus));
        list.sort((a, b) => (a.creationDate < b.creationDate ? -1 : 1));
        const page = list.slice(offset, offset + limit);
        const href = `${url.pathname}?${url.searchParams}`;
        return send(res, 200, { href, total: list.length, limit, offset, orders: page, ...(offset + limit < list.length ? { next: `${url.pathname}?limit=${limit}&offset=${offset + limit}` } : {}) });
      }
      return send(res, 404, { errors: [{ errorId: 2002, message: 'Resource not found' }] });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ebay.url = `http://127.0.0.1:${server.address().port}`;
  ebay.close = () => new Promise((resolve) => server.close(resolve));
  t.after(() => ebay.close());
  /** The person agrees on eBay's consent page: a code for this state (and the address eBay would send the browser to). */
  ebay.authorize = (state, { accept = 'https://suite.example.ts.net/ebay/accepted' } = {}) => {
    const code = `v^1.1#i^1#p^3#r^1#I^3#f^0#t^Ul4x${Math.random().toString(36).slice(2)}`;
    ebay.codes.set(code, { state, used: false });
    return { code, url: `${accept}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}&expires_in=299` };
  };
  return ebay;
}
