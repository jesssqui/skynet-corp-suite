// Automations API (signed in; writes follow the JSON/Origin rules of every /api change).
//   GET  /api/automations          every automation: what it does, when, switches, last/next run
//   PUT  /api/automations/:id      { enabled?, alert? } — either person; logged with who and where
//   POST /api/automations/:id/run  Run now: only creates what is missing (idempotent)
import { Router } from 'express';
import { HttpError } from '../../lib/httpError.js';

export function createAutomationsRouter(ctx, service) {
  const router = Router();
  const who = (req) => ({ actor: req.auth.user.actor, deviceId: req.auth.device?.id ?? null });

  router.get('/', (_req, res) => {
    res.json({
      automations: service.list(),
      // Whether this server's minute scheduler runs (AUTOMATIONS_ENABLED; on in production).
      scheduled: Boolean(ctx.config.automations?.scheduled),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      checkedAt: new Date().toISOString(),
    });
  });

  router.put('/:id', (req, res) => {
    const body = req.body ?? {};
    const keys = Object.keys(body);
    if (!keys.length || keys.some((k) => !['enabled', 'alert'].includes(k))) {
      throw new HttpError(400, 'Send { enabled: true|false } and/or { alert: true|false }');
    }
    res.json({ automation: service.setSettings(req.params.id, body, who(req)) });
  });

  router.post('/:id/run', (req, res) => {
    const run = service.runNow(req.params.id, who(req));
    res.json({ run, automation: service.get(req.params.id) });
  });

  return router;
}
