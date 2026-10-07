import { Router } from 'express';

export function createHealthRouter(_ctx, service) {
  const router = Router();

  // GET /api/health — 200 when the database answers, 503 when it doesn't.
  // Backup trouble shows in the body (backup.ok) but does not make it 503:
  // the app is still usable, and Docker's healthcheck should not restart it.
  router.get('/', (_req, res) => {
    const status = service.getStatus();
    res.status(status.ok ? 200 : 503).json(status);
  });

  return router;
}
