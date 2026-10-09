// The wholesale connection's HTTP side (D1).
//
// Signed (no session; mounted before the Origin/JSON guard by app.js — this exact path only):
//   POST /api/wom/events                    the Order Manager's outbox (A10): signature = the authentication
//
// Signed in (/api/wholesale; writes follow the JSON/Origin rules every /api write follows):
//   GET  /connection                         the address to give the Order Manager, the secret's state
//   POST /connection/secret                  make a new shared secret → { secret, connection } — the only time it is shown
//   GET  /waiting?q=&limit=&offset=          customers waiting for a client
//   GET  /linked?q=&limit=&offset=           customers linked to an account
//   POST /customers/:uid/link { clientId, accountId?, reason? }   link to a client's account (or a new account under it)
//   POST /customers/:uid/create-client       make a client (account, contact, link) from the customer
//   GET  /customers/:uid/undo                D2: what undoing its link would put back / leave (nothing changes)
//   POST /customers/:uid/unlink              undo its link (D2: and what linking changed): records detached (kept here)
// D2 (matching):
//   GET  /matches/suggestions?limit=&offset= customers waiting for a client beside the clients they may be
//   GET  /matches/duplicates?limit=&offset=  possible duplicate clients in the CRM
//   GET  /matches/counts                     how many (Friday review, the tab)
//   GET  /matches/dismissed                  "Not the same" decisions (Show dismissed)
//   POST /matches/not-same { kind, a, b }    kind customer (a = customer uid, b = client id) | clients (two ids)
//   POST /matches/suggest-again { kind, a, b }
import express, { Router } from 'express';
import { HttpError } from '../../lib/httpError.js';
import { RECEIVER_PATH } from './service.js';

/**
 * The body limit for the receiver: a batch of 50 events is typically 50–150 KB (an order snapshot with
 * 20 lines is ~4 KB). A bigger one is answered 413 and the Order Manager retries the same batch, so
 * raise this if an outsized order ever gets stuck there.
 */
export const RECEIVER_BODY_LIMIT = '2mb';

export function receiverHandlers(_ctx, service) {
  return [
    // Headers first: paused, malformed signature headers and "no secret" are answered before a byte
    // of the body is read (the route has no session). The connection is closed after such an answer.
    (req, res, next) => {
      const early = service.precheck({ timestamp: req.get('x-wom-timestamp'), signature: req.get('x-wom-signature') });
      if (!early) return next();
      res.set({ 'Cache-Control': 'no-store', Connection: 'close' });
      res.status(early.status).json(early.body);
    },
    // The raw bytes: the signature covers them exactly as sent, so nothing may parse them first.
    express.raw({ type: () => true, limit: RECEIVER_BODY_LIMIT }),
    (req, res) => {
      const { status, body } = service.receive({
        rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        timestamp: req.get('x-wom-timestamp'),
        signature: req.get('x-wom-signature'),
        // pathname + query as the Order Manager sent it (what it signed)
        path: req.originalUrl,
        method: req.method,
      });
      res.set('Cache-Control', 'no-store');
      res.status(status).json(body);
    },
  ];
}

export const signedRoutes = [{ method: 'POST', path: RECEIVER_PATH, handlers: receiverHandlers }];

function page(query) {
  const n = (v, d, max) => {
    if (v === undefined || v === '') return d;
    const x = Number(v);
    if (!Number.isInteger(x) || x < 0 || x > max) throw new HttpError(400, `limit/offset must be whole numbers (limit up to ${max})`);
    return x;
  };
  if (Array.isArray(query.q)) throw new HttpError(400, 'q must be given once');
  return { q: typeof query.q === 'string' ? query.q.slice(0, 200) : '', limit: n(query.limit, 50, 200) || 50, offset: n(query.offset, 0, 1e9) };
}

export function createWholesaleRouter(_ctx, service) {
  const router = Router();
  const who = (req) => ({ actor: req.auth.user.actor, deviceId: req.auth.device?.id ?? null });

  router.get('/connection', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(service.connectionInfo());
  });

  router.post('/connection/secret', (req, res) => {
    const secret = service.makeSecret(who(req));
    res.set('Cache-Control', 'no-store');
    res.json({ secret, connection: service.connectionInfo() });
  });

  router.get('/waiting', (req, res) => res.json({ ...service.list('waiting', page(req.query)), counts: service.waitingCounts() }));
  router.get('/linked', (req, res) => res.json(service.list('linked', page(req.query))));

  router.post('/customers/:uid/link', (req, res) => {
    const { clientId, accountId = null, reason = null } = req.body ?? {};
    res.json({ customer: service.linkToClient(req.params.uid, { clientId, accountId, reason }, who(req)) });
  });
  router.post('/customers/:uid/create-client', (req, res) => {
    res.json({ customer: service.createClient(req.params.uid, who(req)) });
  });
  router.get('/customers/:uid/undo', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(service.undoPreview(req.params.uid));
  });
  router.post('/customers/:uid/unlink', (req, res) => {
    const { undone, ...customer } = service.unlink(req.params.uid, who(req));
    res.json({ customer, undone });
  });

  // ---- D2: matching ----
  const m = service.matching;
  const pair = (body) => ({ kind: body?.kind, a: body?.a, b: body?.b });
  router.get('/matches/suggestions', (req, res) => res.json(m.suggestions(page(req.query))));
  router.get('/matches/duplicates', (req, res) => res.json(m.duplicates(page(req.query))));
  router.get('/matches/counts', (_req, res) => res.json(m.counts()));
  router.get('/matches/dismissed', (_req, res) => res.json(m.dismissed()));
  router.post('/matches/not-same', (req, res) => res.json({ pair: m.notSame(pair(req.body), who(req)), counts: m.counts() }));
  router.post('/matches/suggest-again', (req, res) => res.json({ pair: m.clearNotSame(pair(req.body)), counts: m.counts() }));

  return router;
}
