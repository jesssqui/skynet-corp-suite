// The WooCommerce stores (D12), signed in (/api/woocommerce; writes follow the JSON/Origin rules every /api write
// follows). Nothing here can change a store: every call to one is a read (client.js).
//   GET    /stores                         the stores (never a secret)
//   POST   /stores { url, key, secret, businessId?, name?, readOnlyConfirmed }   checked with real reads, then saved
//   GET    /stores/:id                     one store
//   PUT    /stores/:id { name?, businessId? }
//   PUT    /stores/:id/key { key, secret, readOnlyConfirmed }                    a new key (checked first)
//   DELETE /stores/:id                     forget it here (revoke the key in WooCommerce too); its totals stay
//   POST   /stores/:id/pull                read its totals now (409 when paused)
//   POST   /stores/:id/orders/lookup { number } | { email }   look orders up, live — the answer is never stored
//          (no-store). A POST (review fix) so the number or email is never in an address — not in the app's error
//          log, a proxy's or the browser's history — and the route answers every error itself, never through the
//          app's error handler, and logs nothing about the query.
import { Router } from 'express';

export function createWooRouter(ctx, service) {
  const log = ctx?.log;
  const router = Router();
  const who = (req) => ({ actor: req.auth.user.actor, deviceId: req.auth.device?.id ?? null });
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/stores', (_req, res) => res.json({ stores: service.listStores() }));
  router.post('/stores', async (req, res) => {
    const { url, key, secret, businessId, name = null, readOnlyConfirmed = false } = req.body ?? {};
    const store = await service.addStore({ url, key, secret, businessId: businessId || undefined, name, readOnlyConfirmed }, who(req));
    res.status(201).json({ store });
  });
  router.get('/stores/:id', (req, res) => res.json({ store: service.store(req.params.id) }));
  router.put('/stores/:id', (req, res) => {
    const { name, businessId } = req.body ?? {};
    res.json({ store: service.updateStore(req.params.id, { name, businessId }, who(req)) });
  });
  router.put('/stores/:id/key', async (req, res) => {
    const { key, secret, readOnlyConfirmed = false } = req.body ?? {};
    res.json({ store: await service.replaceKey(req.params.id, { key, secret, readOnlyConfirmed }, who(req)) });
  });
  router.delete('/stores/:id', (req, res) => res.json(service.removeStore(req.params.id, who(req))));
  router.post('/stores/:id/pull', async (req, res) => res.json(await service.pullNow(req.params.id)));
  router.post('/stores/:id/orders/lookup', async (req, res) => {
    const number = typeof req.body?.number === 'string' ? req.body.number : null;
    const email = typeof req.body?.email === 'string' ? req.body.email : null;
    try {
      res.json(await service.lookup(req.params.id, { number, email }));
    } catch (err) {
      const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status === 500) log?.error?.(`WooCommerce order lookup failed for store ${req.params.id} (${err?.name ?? 'Error'}; the query is never logged)`);
      res.status(status).json({ error: status === 500 ? 'The lookup failed: try again' : err.message, code: err?.code ?? 'lookup_failed' });
    }
  });
  return router;
}
