// Recurring costs and renewals (D6), shared by the server and devices: the value lists a
// `recurring_cost` uses, the period arithmetic (rolling an auto-renewing cost forward), the
// monthly-equivalent and yearly totals, where a cost stands on a day, and how far ahead the
// suite's renewal reminders come. The record type itself is registered by the server's costs
// module (server/src/modules/costs/entities.js). See CLAUDE.md, "Renewals and recurring costs (D6)".
import { addMonths } from './crm.js';
import { addDays } from './planner.js';

/** How often a cost comes round. `once` = paid one time (never rolled forward, left out of totals). */
export const COST_PERIODS = Object.freeze(['monthly', 'quarterly', 'yearly', 'once']);
/** null reads as active (a cost made without a status). Cancelling is the normal way to stop one. */
export const COST_STATUSES = Object.freeze(['active', 'cancelled']);
/** The currencies the form offers; any three capital letters are stored (ISO 4217 shape). */
export const CURRENCIES = Object.freeze(['CAD', 'USD', 'EUR', 'GBP']);
export const DEFAULT_CURRENCY = 'CAD';
export const COST_NAME_MAX = 200;

/** The suite's reminder for a client service comes this many days before its renewal date… */
export const SERVICE_REMINDER_DAYS = 30;
/** …and for one of our recurring costs this many days before its next renewal. */
export const COST_REMINDER_DAYS = 14;

const PERIOD_MONTHS = Object.freeze({ monthly: 1, quarterly: 3, yearly: 12 });
/** How many times a year each period comes round (once: not at all, for totals). */
const PER_YEAR = Object.freeze({ monthly: 12, quarterly: 4, yearly: 1, once: 0 });
export const PERIOD_SUFFIX = Object.freeze({ monthly: '/mo', quarterly: '/qtr', yearly: '/yr', once: ' once' });
export const COST_PERIOD_LABELS = Object.freeze({ monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly', once: 'Once' });

export const isCurrency = (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
export const costCurrency = (cost) => (isCurrency(cost?.currency) ? cost.currency : DEFAULT_CURRENCY);
export const costStatus = (cost) => cost?.status ?? 'active';
export const isActiveCost = (cost) => costStatus(cost) === 'active';

/** Whole days from `from` to `to` ("YYYY-MM-DD"; negative when `to` is earlier). */
export function daysFromTo(from, to) {
  const ms = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** Days in a month (1–12). */
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The day of the month of a "YYYY-MM-DD" date. */
export const dayOfMonth = (date) => Number(String(date).slice(8, 10));

/**
 * `date` plus `n` of the cost's periods, on the calendar; `once` stays put. The day is the cost's
 * billing day (`anchor`, 1–31; default: `date`'s own day), clamped to the month's last day — so a
 * cost billed on the 31st renews Jan 31 → Feb 28 → Mar 31, never sticking on the 28th.
 */
export function addPeriods(date, period, n = 1, anchor = null) {
  const months = PERIOD_MONTHS[period];
  if (!months) return date;
  if (!anchor) return addMonths(date, months * n);
  const [y, m] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months * n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(anchor, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** A valid billing day (1–31) or null. */
export const isAnchorDay = (v) => Number.isInteger(v) && v >= 1 && v <= 31;

/**
 * The next renewal of an auto-renewing cost whose date has passed: the first `next + k periods`
 * that is today or later (k counted from `next` in one go, so a run after weeks of downtime lands
 * on the right date). Unchanged when the date hasn't passed, or for `once`. Each date falls on the
 * billing day `anchor` (the cost's `anchor_day`; default `next`'s own day), clamped to short
 * months — rolled daily or in one jump, the dates are the same (Jan 31 → Feb 28 → Mar 31).
 */
export function rollForward(next, period, today, anchor = null) {
  if (!next || !PERIOD_MONTHS[period] || next >= today) return next;
  const day = isAnchorDay(anchor) ? anchor : dayOfMonth(next);
  let k = 1;
  let date = addPeriods(next, period, k, day);
  while (date < today) {
    k += 1;
    date = addPeriods(next, period, k, day);
  }
  return date;
}

/** What a cost comes to in a year, in cents (monthly × 12, quarterly × 4, yearly; once and no amount: 0). */
export function yearlyCents(cost, field = 'amount_cents') {
  const amount = cost?.[field];
  if (!Number.isFinite(amount)) return 0;
  return amount * (PER_YEAR[cost.period] ?? 0);
}

/** A yearly figure as a month's share (yearly ÷ 12, to the cent). */
export const monthlyFromYearly = (cents) => Math.round(cents / 12);

/**
 * Monthly-equivalent and yearly totals of ACTIVE costs (cancelled ones and `once` left out), per
 * business and overall, per currency — amounts in different currencies are never added together.
 * → { byBusiness: Map<business_id, Map<currency, Sum>>, overall: Map<currency, Sum> } where
 * Sum = { count, yearly_cents, monthly_cents, resold_yearly_cents, resold_monthly_cents }.
 * `count` counts the recurring ones that went in. `resoldLive(cost)` says whether a resold cost's
 * relationship (and its account and client) is still there: the resold side of one whose client is
 * gone (deleted, or hidden under a deleted parent) is left out, as the page leaves out its line.
 */
export function costTotals(costs, { resoldLive = () => true } = {}) {
  const byBusiness = new Map();
  const overall = new Map();
  const add = (map, currency, cost) => {
    const s = map.get(currency) ?? { count: 0, yearly_cents: 0, monthly_cents: 0, resold_yearly_cents: 0, resold_monthly_cents: 0 };
    s.count += 1;
    s.yearly_cents += yearlyCents(cost);
    s.resold_yearly_cents += cost.relationship_id && resoldLive(cost) ? yearlyCents(cost, 'resold_amount_cents') : 0;
    s.monthly_cents = monthlyFromYearly(s.yearly_cents);
    s.resold_monthly_cents = monthlyFromYearly(s.resold_yearly_cents);
    map.set(currency, s);
  };
  for (const c of costs) {
    if (!isActiveCost(c) || c.period === 'once' || !PER_YEAR[c.period]) continue;
    const currency = costCurrency(c);
    if (!byBusiness.has(c.business_id)) byBusiness.set(c.business_id, new Map());
    add(byBusiness.get(c.business_id), currency, c);
    add(overall, currency, c);
  }
  return { byBusiness, overall };
}

/**
 * Where a cost stands on `today`:
 *  cancelled · past (a one-time cost whose date has gone by) · rolling (auto-renews and its date has
 *  passed: the suite moves it forward at its next daily run) · overdue (doesn't renew on its own and
 *  its date has passed: "Overdue — renewed?") · today · soon (within the reminder's 14 days) · upcoming.
 */
export function costState(cost, today, soonDays = COST_REMINDER_DAYS) {
  if (!isActiveCost(cost)) return 'cancelled';
  const next = cost.next_renewal;
  if (!next) return 'upcoming';
  if (next < today) {
    if (cost.period === 'once') return 'past';
    return cost.auto_renews ? 'rolling' : 'overdue';
  }
  if (next === today) return 'today';
  return next <= addDays(today, soonDays) ? 'soon' : 'upcoming';
}

/**
 * Does the suite make a reminder task for this cost? Active ones, except those that renew MONTHLY on
 * their own (a phone plan, a software seat): a task every month would be noise — they are rolled
 * forward and listed on the Costs page instead.
 */
export function wantsCostReminder(cost) {
  return isActiveCost(cost) && !(cost.period === 'monthly' && cost.auto_renews);
}

/** Active costs whose next renewal is from..to (inclusive), soonest first. */
export function costsRenewingBetween(costs, from, to) {
  return costs.filter((c) => isActiveCost(c) && c.next_renewal && c.next_renewal >= from && c.next_renewal <= to)
    .sort((a, b) => (a.next_renewal < b.next_renewal ? -1 : a.next_renewal > b.next_renewal ? 1 : (a.id < b.id ? -1 : 1)));
}

const formatters = new Map();
/** 12000 → "$120", 12050 → "$120.50", in USD "US$120" (en-CA); '' for no amount. */
export function moneyText(cents, currency = DEFAULT_CURRENCY) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  const cur = isCurrency(currency) ? currency : DEFAULT_CURRENCY;
  const whole = cents % 100 === 0;
  const key = `${cur}:${whole}`;
  if (!formatters.has(key)) {
    try {
      formatters.set(key, new Intl.NumberFormat('en-CA', {
        style: 'currency', currency: cur, currencyDisplay: cur === 'CAD' ? 'narrowSymbol' : 'symbol',
        minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2,
      }));
    } catch {
      formatters.set(key, { format: (n) => `${n.toFixed(whole ? 0 : 2)} ${cur}` }); // a code Intl doesn't know
    }
  }
  return formatters.get(key).format(cents / 100);
}

/** "$120/yr", "$20/mo", "US$60/qtr", "$500 once"; '' when there is no amount. */
export function costAmountText(cost, field = 'amount_cents') {
  const m = moneyText(cost?.[field], costCurrency(cost));
  return m ? `${m}${PERIOD_SUFFIX[cost.period] ?? ''}` : '';
}
