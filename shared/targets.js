// Monthly targets per business (D15): what each of our businesses aims for in a calendar month — total sales, sales
// before tax and shipping, orders, new clients, leads won — set at the monthly plan (/plan/month, offline: the synced
// `target` record of the overview module) and measured automatically on the overview's scorecard against what the
// month brings (sales from the sales module's months, clients and leads from the CRM).
//
// How they relate to C4b's month priorities: a priority is a piece of work ("launch the new menu"), ticked and moved
// on by hand (its own `target` / `progress` are typed); a target here is a number the suite measures itself. Both are
// set on the same monthly plan, per business, and the scorecard shows them side by side — the numbers the month is
// judged by, then the priorities meant to get there. Neither copies the other.
//
// Pure: runs in Node (the server's scorecard) and the browser (the plan's sheet, the overview's words).

/** What a target can measure. Money measures are cents in the target's currency (null = CAD); the rest are counts. */
export const TARGET_MEASURES = Object.freeze(['sales', 'net_sales', 'orders', 'new_clients', 'won_leads']);
export const MONEY_MEASURES = Object.freeze(['sales', 'net_sales']);
export const isMoneyMeasure = (measure) => MONEY_MEASURES.includes(measure);
/** Measures that need sales: never offered for Personal (the home doesn't sell). */
export const SALES_MEASURES = Object.freeze(['sales', 'net_sales', 'orders']);
/** The measures a business's target may use (Personal: no sales measures). */
export const measuresFor = (businessId, personalId) => TARGET_MEASURES.filter((m) => businessId !== personalId || !SALES_MEASURES.includes(m));

export const MEASURE_LABELS = Object.freeze({
  sales: 'Total sales',
  net_sales: 'Sales before tax and shipping',
  orders: 'Orders',
  new_clients: 'New clients (first relationship started)',
  won_leads: 'Leads won',
});
/** One line on what each measure counts (the sheet and the scorecard say it). */
export const MEASURE_HELP = Object.freeze({
  sales: 'Items, shipping and tax after discounts and refunds — every store, the Order Manager, eBay and sales entered by hand of this business, this month.',
  net_sales: 'Item sales after discounts and refunds, before tax and shipping (the Order Manager’s net revenue). Sales entered by hand only have a total, so they can’t be counted here.',
  orders: 'Orders in the month as each sales source counts them (a store’s orders; sales entered by hand: as typed).',
  new_clients: 'Clients whose first relationship with this business has its start date in this month (each client once; relationships with no start date — an import, say — don’t count).',
  won_leads: 'Leads of this business marked won this month.',
});

/** At most this many characters of notes on a target. */
export const TARGET_NOTES_MAX = 2000;

/** "YYYY-MM-01" for a day or a "YYYY-MM" month. */
export const monthFirst = (value) => `${String(value).slice(0, 7)}-01`;
export const isMonthFirst = (value) => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(value);
/** Days in the month of "YYYY-MM-DD" / "YYYY-MM". */
export function daysInMonth(value) {
  const [y, m] = String(value).slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** One target per business, month, measure and (money measures) currency. */
export const targetKey = (t) => `${t.business_id}|${monthFirst(t.month)}|${t.measure}|${isMoneyMeasure(t.measure) ? (t.currency ?? 'CAD') : ''}`;
// When was it last changed: the newer one counts. Without a time on both (a device's own record not pulled back yet),
// the ids decide (UUIDv7: the one made later).
const when = (t) => t.updated_at ?? t.created_at ?? null;
const newer = (a, b) => ((when(a) && when(b) ? String(when(a)).localeCompare(String(when(b))) : 0) || String(a.id).localeCompare(String(b.id)));

/**
 * Two devices setting the same target offline make two records (nothing is refused: both must survive). Readers use
 * the one changed last and offer to remove the others. → { current: [targets], extras: Map<id of current, [others]> }
 */
export function pickTargets(targets) {
  const groups = new Map();
  for (const t of targets ?? []) {
    if (!t || !TARGET_MEASURES.includes(t.measure)) continue;
    const k = targetKey(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const current = [];
  const extras = new Map();
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => newer(b, a));
    current.push(sorted[0]);
    if (sorted.length > 1) extras.set(sorted[0].id, sorted.slice(1));
  }
  const order = (t) => TARGET_MEASURES.indexOf(t.measure);
  current.sort((a, b) => String(a.business_id).localeCompare(String(b.business_id)) || order(a) - order(b)
    || String(a.currency ?? 'CAD').localeCompare(String(b.currency ?? 'CAD')));
  return { current, extras };
}

/** Within this share either side of the expected figure is "on pace". */
export const PACE_BAND = 0.05;

/** The first days of a month say too little about its pace: before this many completed days it is "too early to tell". */
export const PACE_MIN_DAYS = 3;

/**
 * Where a target stands on `today` (the device's day): { status, pct, expected, projected, elapsed, days }.
 *  status  reached (actual ≥ target) · ahead · on_pace · behind (this month, against the straight line from 0 at the
 *          start of the 1st to the target at the end of the last day, by the days **completed** — today isn't over)
 *          · too_early (fewer than PACE_MIN_DAYS days completed) · missed (a month gone by) · not_started (a month to
 *          come) · unknown (no actual: can't be measured)
 *  pct       actual ÷ target, 0–100+ (rounded)
 *  expected  where the straight line was at the end of yesterday (this month only)
 *  projected the actual carried on at the same rate to the month's end (this month, once a day is complete)
 *  elapsed   days completed
 */
export function targetPace({ amount, actual, month, today }) {
  const first = monthFirst(month);
  const days = daysInMonth(first);
  const thisMonth = String(today).slice(0, 7) === first.slice(0, 7);
  const past = !thisMonth && String(today) > first;
  const elapsed = thisMonth ? Math.max(0, Number(String(today).slice(8, 10)) - 1) : past ? days : 0;
  const out = { status: 'unknown', pct: null, expected: null, projected: null, elapsed, days };
  if (!(amount > 0)) return out;
  if (!thisMonth && !past) return { ...out, status: 'not_started', pct: actual === null || actual === undefined ? null : Math.round((actual / amount) * 100) };
  if (actual === null || actual === undefined || !Number.isFinite(actual)) return out;
  out.pct = Math.round((actual / amount) * 100);
  if (thisMonth) {
    out.expected = Math.round((amount * elapsed) / days);
    out.projected = elapsed > 0 ? Math.round((actual * days) / elapsed) : null;
  }
  if (actual >= amount) return { ...out, status: 'reached' };
  if (past) return { ...out, status: 'missed' };
  if (elapsed < PACE_MIN_DAYS) return { ...out, status: 'too_early' };
  const ratio = out.expected > 0 ? actual / out.expected : 1;
  return { ...out, status: ratio >= 1 + PACE_BAND ? 'ahead' : ratio >= 1 - PACE_BAND ? 'on_pace' : 'behind' };
}

export const PACE_LABELS = Object.freeze({
  reached: 'Reached', too_early: 'Too early to tell', ahead: 'Ahead of pace', on_pace: 'On pace', behind: 'Behind pace', missed: 'Missed', not_started: 'Not started', unknown: 'Can’t tell',
});

/**
 * The rules for a `target` step that hold in any arrival order (the sync `check`; only the step's own values): the
 * month is a 1st, the amount above 0, the currency three capital letters; a target's business, month, measure and
 * currency never change once made (screens delete it and set a new one), so an update naming one is refused.
 */
export function checkTargetStep({ op, fields }) {
  if (op === 'delete' || !fields) return null;
  const has = (k) => Object.hasOwn(fields, k) && fields[k] !== null;
  if (op === 'update') {
    for (const k of ['business_id', 'month', 'measure', 'currency']) {
      if (Object.hasOwn(fields, k)) return { code: 'invalid_value', reason: `${k}: a target’s business, month, measure and currency don’t change — remove it and set a new one` };
    }
  }
  if (has('month') && !isMonthFirst(fields.month)) return { code: 'invalid_value', reason: 'month: the 1st of a month (YYYY-MM-01)' };
  if (has('amount') && !(Number.isSafeInteger(fields.amount) && fields.amount > 0)) return { code: 'invalid_value', reason: 'amount: a whole number above 0' };
  if (Object.hasOwn(fields, 'amount') && fields.amount === null) return { code: 'invalid_value', reason: 'amount: a whole number above 0' };
  if (has('currency') && !/^[A-Z]{3}$/.test(fields.currency)) return { code: 'invalid_value', reason: 'currency: three capital letters, like CAD or USD' };
  return null;
}
