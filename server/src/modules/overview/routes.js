// The overview (D11), signed in (/api/overview), GET only, never cached:
//   GET /?today=YYYY-MM-DD   sales per business (today / this week / this month, the combined total), the list of what
//                            needs dealing with, (D15) the business cards and the goals scorecard of this calendar
//                            month; `today` is the device's own day (the server may be in another zone), else the server's
//   GET /targets?month=YYYY-MM&today=YYYY-MM-DD
//                            (D15) one month's targets against what it brought so far, with that month's priorities —
//                            the monthly plan's "so far" figures (the targets themselves are synced: set offline)
import { Router } from 'express';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (v) => (typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);

export function createOverviewRouter(_ctx, service) {
  const router = Router();
  router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(service.overview({ today: dayOf(req.query.today), actor: req.auth.user.actor }));
  });
  router.get('/targets', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    const out = service.targets({ month, today: dayOf(req.query.today) });
    if (out.state === 'bad_month') return res.status(400).json({ error: 'month: YYYY-MM', code: 'bad_month' });
    return res.json(out);
  });
  return router;
}
