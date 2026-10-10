// The overview (D11), signed in (/api/overview), GET only, never cached:
//   GET /?today=YYYY-MM-DD   sales per business (today / this week / this month, the combined total) and the list of
//                            what needs dealing with; `today` is the device's own day (the server may be in another
//                            zone), else the server's
import { Router } from 'express';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createOverviewRouter(_ctx, service) {
  const router = Router();
  router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const today = typeof req.query.today === 'string' && DAY_RE.test(req.query.today) && !Number.isNaN(Date.parse(`${req.query.today}T00:00:00Z`))
      ? req.query.today : null;
    res.json(service.overview({ today, actor: req.auth.user.actor }));
  });
  return router;
}
