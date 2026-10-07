import { Router } from 'express';

// GET /api/health is public so Docker's healthcheck (and a quick curl) can use it, but
// only signed-in callers get the details (database, backup folder, errors).
export function createHealthPublicRouter(_ctx, service) {
  const router = Router();

  // 200 when the database answers, 503 when it doesn't.
  // Backup trouble shows in the body (backup.ok) but does not make it 503:
  // the app is still usable, and Docker's healthcheck should not restart it.
  router.get('/', (req, res) => {
    const status = service.getStatus();
    const body = req.auth
      ? status
      : { ok: status.ok, name: status.name, version: status.version, time: status.time };
    res.status(status.ok ? 200 : 503).json(body);
  });

  return router;
}
