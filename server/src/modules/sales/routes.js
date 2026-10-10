// The Sales page's reads (D12), signed in (/api/sales). Totals only.
//   GET /summary                         every store (connected or not) with today / this week / this month in its
//                                        own calendar, per business and overall per currency, last updated
//   GET /totals?from=&to=&business=&store=&source=   sums over a range of days (D11/D15 use the service directly)
// D13, months entered by hand (for a store whose connection is off or not set up — eBay):
//   GET    /manual/:store                the last 13 months: the connection's figures, the hand-entered month, which counts
//   PUT    /manual/:store/:month { total, currency?, orders?, note? }   enter or correct a month (cents)
//   DELETE /manual/:store/:month
//   GET    /monthly?from=YYYY-MM&to=YYYY-MM   per store and month, with hand-entered months where there are no days (D15)
import { Router } from 'express';
import { HttpError } from '../../lib/httpError.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function createSalesRouter(_ctx, service) {
  const router = Router();
  const who = (req) => ({ actor: req.auth.user.actor, deviceId: req.auth.device?.id ?? null });
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/summary', (_req, res) => res.json(service.summary()));
  router.get('/totals', (req, res) => {
    const { from, to, business = null, store = null, source = null } = req.query;
    if (!DAY_RE.test(String(from ?? '')) || !DAY_RE.test(String(to ?? '')) || from > to) throw new HttpError(400, 'from and to are days (YYYY-MM-DD), from ≤ to');
    res.json(service.totals({ from, to, business: business || null, store: store || null, source: source || null }));
  });
  router.get('/monthly', (req, res) => {
    const { from, to } = req.query;
    if (!MONTH_RE.test(String(from ?? '')) || !MONTH_RE.test(String(to ?? '')) || from > to || to.slice(0, 4) - from.slice(0, 4) > 5) {
      throw new HttpError(400, 'from and to are months (YYYY-MM), from ≤ to, at most 5 years apart');
    }
    res.json(service.monthly({ fromMonth: from, toMonth: to }));
  });
  router.get('/manual/:store', (req, res) => res.json(service.months(req.params.store)));
  router.put('/manual/:store/:month', (req, res) => {
    const { total, currency, orders = null, note = null } = req.body ?? {};
    res.json(service.putManualMonth(req.params.store, req.params.month, { total, currency: currency ?? undefined, orders, note }, who(req)));
  });
  router.delete('/manual/:store/:month', (req, res) => res.json(service.deleteManualMonth(req.params.store, req.params.month)));
  return router;
}
