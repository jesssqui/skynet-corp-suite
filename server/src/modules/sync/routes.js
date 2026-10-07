import { Router } from 'express';
import { identify } from './identity.js';

export function createSyncRouter(_ctx, service) {
  const router = Router();

  // GET /api/sync/info — generation, current cursor, server clock, registered entities and limits.
  router.get('/info', (_req, res) => {
    res.json(service.info());
  });

  // POST /api/sync/push {deviceId, actor, steps:[...], deviceTime?} -> per-step results, in order.
  router.post('/push', (req, res) => {
    const who = identify(req);
    res.json(service.push({ ...who, steps: req.body?.steps, deviceTime: req.body?.deviceTime }));
  });

  // GET /api/sync/pull?since=<cursor>&limit=<n> -> changed records since the cursor, paged.
  router.get('/pull', (req, res) => {
    const who = identify(req);
    res.json(service.pull({ ...who, since: req.query.since, limit: req.query.limit }));
  });

  // GET /api/sync/clashes?status=open|all&entity=&recordId= — the review list.
  router.get('/clashes', (req, res) => {
    const { status, entity, recordId, limit } = req.query;
    res.json({ clashes: service.listClashes({ status, entity, recordId, limit }) });
  });

  // POST /api/sync/clashes/:id/resolve {resolution: keep_winner|keep_loser}
  router.post('/clashes/:id/resolve', (req, res) => {
    const { actor } = identify(req);
    res.json(service.resolveClash({ id: req.params.id, resolution: req.body?.resolution, actor }));
  });

  return router;
}
