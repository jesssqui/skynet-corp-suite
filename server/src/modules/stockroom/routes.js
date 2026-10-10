// The Stockroom connection's settings (D16), signed in (/api/stockroom; writes follow the JSON/Origin
// rules every /api write follows). Nothing here reaches Stockroom except reads (client.js).
//   GET    /connection          the connection (never the secret), each read's last answer and error
//   PUT    /connection { code } (or { url, key, secret })   check it with Stockroom, then save it
//   DELETE /connection          forget it here (Stockroom keeps its credential: disconnect it there too)
//   POST   /pull                pull every read now (409 when paused, not set up or disconnected)
import { Router } from 'express';

export function createStockroomRouter(_ctx, service) {
  const router = Router();
  const who = (req) => ({ actor: req.auth.user.actor, deviceId: req.auth.device?.id ?? null });
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  router.get('/connection', (_req, res) => {
    noStore(res);
    res.json(service.connectionInfo());
  });
  router.put('/connection', async (req, res) => {
    const { code = null, url = null, key = null, secret = null } = req.body ?? {};
    const connection = await service.connect({ code, url, key, secret }, who(req));
    noStore(res);
    res.json(connection);
  });
  router.delete('/connection', (req, res) => {
    noStore(res);
    res.json(service.forget(who(req)));
  });
  router.post('/pull', async (_req, res) => {
    const out = await service.pullNow();
    noStore(res);
    res.json(out);
  });
  return router;
}
