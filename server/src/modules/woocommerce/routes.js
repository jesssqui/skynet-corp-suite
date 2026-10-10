// The WooCommerce stores (D12), signed in (/api/woocommerce; writes follow the JSON/Origin rules every /api write
// follows). Nothing here can change a store: every call to one is a read (client.js).
//   GET    /stores                         the stores (never a secret)
//   POST   /stores { url, key, secret, businessId?, name?, readOnlyConfirmed }   checked with real reads, then saved
//   GET    /stores/:id                     one store
//   PUT    /stores/:id { name?, businessId? }
//   PUT    /stores/:id/key { key, secret, readOnlyConfirmed }                    a new key (checked first)
//   DELETE /stores/:id                     forget it here (revoke the key in WooCommerce too); its totals stay
//   POST   /stores/:id/pull                read its totals now (409 when paused)
//   GET    /stores/:id/orders?number=|email=   look orders up, live — the answer is never stored (no-store)
import { Router } from 'express';

export function createWooRouter(_ctx, service) {
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
  router.get('/stores/:id/orders', async (req, res) => {
    const number = typeof req.query.number === 'string' ? req.query.number : null;
    const email = typeof req.query.email === 'string' ? req.query.email : null;
    res.json(await service.lookup(req.params.id, { number, email }));
  });
  return router;
}
