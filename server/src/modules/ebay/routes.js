// The eBay connection's settings (D13), signed in (/api/ebay; writes follow the JSON/Origin rules every /api write
// follows). Nothing here can change anything on eBay (client.js).
//   GET    /connection                          the connection (never the Cert ID or a token), the pull, what waits
//   PUT    /connection { appId, certId, ruName } save the keyset (a new one ends the sign-in)
//   DELETE /connection                          forget it here (totals and tasks stay)
//   PUT    /settings { timeZone }               the zone the shop's days are counted in
//   POST   /sign-in                             → { url } of eBay's consent page (with a fresh state)
//   POST   /sign-in/finish { code, state } | { url }   what eBay sent back: checked, exchanged, sealed
//   POST   /pull                                read eBay now (409 when paused, not set up or not signed in)
import { Router } from 'express';

export function createEbayRouter(_ctx, service) {
  const router = Router();
  const who = (req) => ({ actor: req.auth.user.actor, deviceId: req.auth.device?.id ?? null });
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/connection', (_req, res) => res.json(service.info()));
  router.put('/connection', (req, res) => {
    const { appId, certId, ruName } = req.body ?? {};
    res.json(service.setKeyset({ appId, certId, ruName }, who(req)));
  });
  router.delete('/connection', (req, res) => res.json(service.forget(who(req))));
  router.put('/settings', (req, res) => res.json(service.updateSettings({ timeZone: req.body?.timeZone }, who(req))));
  router.post('/sign-in', (req, res) => res.json(service.startSignIn(who(req))));
  router.post('/sign-in/finish', async (req, res) => {
    const { code = null, state = null, url = null } = req.body ?? {};
    res.json(await service.finishSignIn({ code, state, url }, who(req)));
  });
  router.post('/pull', async (_req, res) => res.json(await service.pullNow()));
  return router;
}
