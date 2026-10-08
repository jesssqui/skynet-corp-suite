// Connections API (signed in; changes need the JSON/Origin rules every /api write follows).
//   GET /api/connections        every connection: state, last success, queue, last error
//   PUT /api/connections/:id    { paused: true|false } — switch one off or on (either person)
import { Router } from 'express';
import { HttpError } from '../../lib/httpError.js';

export function createConnectionsRouter(_ctx, service) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ connections: service.list(), checkedAt: new Date().toISOString() });
  });

  router.put('/:id', (req, res) => {
    const body = req.body ?? {};
    if (typeof body.paused !== 'boolean') throw new HttpError(400, 'Send { paused: true } to switch it off or { paused: false } to switch it on');
    const connection = service.setPaused(req.params.id, body.paused, { actor: req.auth.user.actor, deviceId: req.auth.device?.id ?? null });
    res.json({ connection });
  });

  return router;
}
