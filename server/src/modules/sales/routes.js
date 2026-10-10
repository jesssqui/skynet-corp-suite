// The Sales page's reads (D12), signed in (/api/sales). Totals only; GET only.
//   GET /summary                         every store (connected or not) with today / this week / this month in its
//                                        own calendar, per business and overall per currency, last updated
//   GET /totals?from=&to=&business=&store=&source=   sums over a range of days (D11/D15 use the service directly)
import { Router } from 'express';
import { HttpError } from '../../lib/httpError.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createSalesRouter(_ctx, service) {
  const router = Router();
  router.get('/summary', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(service.summary());
  });
  router.get('/totals', (req, res) => {
    const { from, to, business = null, store = null, source = null } = req.query;
    if (!DAY_RE.test(String(from ?? '')) || !DAY_RE.test(String(to ?? '')) || from > to) throw new HttpError(400, 'from and to are days (YYYY-MM-DD), from ≤ to');
    res.set('Cache-Control', 'no-store');
    res.json(service.totals({ from, to, business: business || null, store: store || null, source: source || null }));
  });
  return router;
}
