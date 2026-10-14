// Sales by channel: registers the sale_day record type with sync and answers totals for the
// overview (C8) and the Sales page. It never writes its table itself: every change is a sync step
// (devices) or sync.applyLocal (server code). It reads only its own table.
import { isSaleAmount, SALE_AMOUNT_MAX, roundCents } from '@suite/shared/sales';
import { SALES_ENTITIES } from './entities.js';

/**
 * Rule for a sale_day step, right in any arrival order (it looks only at the step's own values):
 * the amount is 0 … SALE_AMOUNT_MAX with at most two decimals. Past dates are always allowed —
 * missed sales are added later — and so are future ones (a phone's clock may be off).
 */
export function checkSaleDay({ op, fields }) {
  if (op === 'delete' || !fields) return null;
  if (Object.hasOwn(fields, 'amount') && fields.amount !== null && !isSaleAmount(fields.amount)) {
    return { code: 'invalid_value', reason: `amount: 0 to ${SALE_AMOUNT_MAX}, in dollars and cents` };
  }
  return null;
}

export function createSalesService({ db, services }) {
  const sync = services.sync;
  if (!sync) throw new Error('sales needs the sync module registered before it (modules/index.js)');
  if (!services.crm) throw new Error('sales needs the crm module registered before it (its records belong to a business)');

  for (const def of SALES_ENTITIES) sync.registerEntity({ module: 'sales', ...def, check: checkSaleDay });

  const q = {
    totals: db.prepare(`SELECT channel, SUM(amount) AS total, COUNT(DISTINCT sale_date) AS days FROM sales_days
      WHERE deleted_at IS NULL AND business_id = ? AND sale_date >= ? AND sale_date <= ? GROUP BY channel`),
  };

  return {
    /**
     * Hand-entered sales of one business for dates from..to inclusive ("YYYY-MM-DD", Toronto days as
     * typed): { byChannel: { [channel]: { total, days } }, total } — only channels with entries.
     * The overview (C8) adds eBay's automatic totals to this.
     */
    totals(businessId, from, to) {
      const byChannel = {};
      let total = 0;
      for (const r of q.totals.all(businessId, from, to)) {
        byChannel[r.channel] = { total: roundCents(r.total), days: r.days };
        total += r.total;
      }
      return { byChannel, total: roundCents(total) };
    },
  };
}
