// The overview's business cards and goals scorecard in words (D15), no React (client/test/overview-cards.test.js). The
// server sends each card's figures as data (server/src/modules/overview/cards.js and scorecard.js); this turns them
// into rows — { key, label, value, detail, tone, link } — and says plainly when a card's source isn't connected.
import { salesMoney } from '@suite/shared/sales';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { MEASURE_LABELS, PACE_LABELS, PACE_MIN_DAYS, isMoneyMeasure, targetPace } from '@suite/shared/targets';
import { periodText, ordersText } from '../sales/logic.js';

const B = BUSINESS_IDS;
const n = (v) => Number(v ?? 0).toLocaleString('en-CA');
const plural = (v, one, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const money = (cents, currency = 'CAD') => `${salesMoney(cents ?? 0, currency)}${currency === 'CAD' ? '' : ` ${currency}`}`;
const join = (parts) => parts.filter(Boolean).join(' · ');
/** A list per currency → "$1,200 + $50 USD" ('' for none). */
const perCurrency = (list, key, suffix = '') => (list ?? []).filter((x) => x[key]).map((x) => `${money(x[key], x.currency)}${suffix}`).join(' + ');
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "Oct" / "October 2026" for "2026-10". */
export const shortMonth = (m) => MONTH_NAMES[Number(String(m).slice(5, 7)) - 1] ?? m;
export const longMonth = (m) => `${LONG_MONTHS[Number(String(m).slice(5, 7)) - 1] ?? ''} ${String(m).slice(0, 4)}`.trim();

/** Each card's heading and where it leads. */
export const CARD_META = Object.freeze({
  wholesale: { title: 'Wholesale', link: '/wholesale', linkText: 'Order Manager customers' },
  stock: { title: 'Stock', link: `/tasks?business=${B.wholesale}`, linkText: 'Wholesale tasks' },
  web: { title: 'Web and social', link: `/crm?business=${B.agency}`, linkText: 'Clients' },
  consulting: { title: 'Business consulting', link: `/crm?business=${B.consulting}`, linkText: 'Clients' },
  savePoint: { title: 'Save Point Shop', link: '/costs/sales/ebay', linkText: 'eBay sales' },
  clients: { title: 'Clients', link: '/crm', linkText: 'All clients' },
  allBusinesses: { title: 'All businesses: sales and recurring costs', link: '/costs', linkText: 'Costs' },
  retail: { title: 'Retail stores', link: '/costs/sales', linkText: 'Sales per store' },
});

/** What to say about a card whose source can't give figures now: { text, tone, link? } or null when it can. */
export function cardStateNote(card) {
  const conn = { link: '/system/connections', linkText: 'System → Connections' };
  switch (card.state) {
    case 'ok': return null;
    case 'error': return { text: 'Couldn’t be read just now — try again in a moment.', tone: 'danger' };
    case 'not_available': return { text: 'Not available here.', tone: null };
    case 'paused':
      if (card.id === 'stock') return { text: 'Stockroom is paused on Connections: these are its last answers.', tone: 'warn', ...conn };
      if (card.id === 'savePoint') return { text: 'eBay is paused on Connections: figures up to its last read.', tone: 'warn', ...conn };
      return { text: 'The Order Manager is paused on Connections: these are the last figures it sent.', tone: 'warn', ...conn };
    case 'not_connected':
      if (card.id === 'stock') return { text: 'Not connected: Stockroom is set up on System → Connections (read-only).', tone: null, ...conn };
      if (card.id === 'retail') return { text: 'No WooCommerce store connected: add one on System → Connections.', tone: null, ...conn };
      return { text: 'Not connected: the Order Manager is set up on System → Connections.', tone: null, ...conn };
    case 'revoked': return { text: 'Disconnected in Stockroom: paste a new code on System → Connections.', tone: 'danger', ...conn };
    case 'not_read': return card.id === 'stock' ? { text: 'Stockroom hasn’t been read yet.', tone: null } : { text: 'eBay hasn’t been read yet.', tone: null };
    case 'not_set_up': return { text: 'eBay isn’t connected: set it up on System → Connections, or enter a month by hand (eBay sales).', tone: null, ...conn };
    case 'not_signed_in': return { text: 'Not signed in to eBay yet (System → Connections).', tone: null, ...conn };
    case 'signed_out': return { text: 'eBay stopped accepting the sign-in: sign in again on System → Connections.', tone: 'danger', ...conn };
    case 'failing': return { text: 'eBay can’t be read right now: figures up to its last read.', tone: 'warn', ...conn };
    case 'unreadable': return { text: 'eBay’s keys can’t be read on this server: enter the keyset again on Connections.', tone: 'danger', ...conn };
    default: return { text: 'Not available here.', tone: null };
  }
}

const costsRow = (costs) => (costs?.length
  ? { key: 'costs', label: 'Recurring costs', value: perCurrency(costs, 'monthlyCents', ' a month') || '$0 a month', detail: plural(costs.reduce((a, c) => a + (c.count ?? 0), 0), 'cost'), link: '/costs' }
  : { key: 'costs', label: 'Recurring costs', value: 'None set', detail: 'Add them on Money → Costs', link: '/costs' });
const handNote = (list) => ((list ?? []).some((f) => f.totalOnly) ? 'includes sales entered by hand' : null);

/**
 * One card → { id, title, link, linkText, note (cardStateNote), rows: [{ key, label, value, detail, tone, link }],
 * extra } — rows only when the card has figures. `fmt` = { date(ymd), dateTime(iso) } (the page passes ui/format).
 */
export function cardView(card, fmt = { date: (d) => d, dateTime: (d) => d }) {
  const meta = CARD_META[card.id] ?? { title: card.id };
  const view = { id: card.id, ...meta, note: cardStateNote(card), rows: [], extra: null };
  // Figures are shown whenever there are some: the last ones while paused or failing; none while not connected.
  const figuresShown = card.id === 'stock' ? Boolean(card.counts || card.differences || card.reorder || card.deliveries)
    : card.id === 'savePoint' ? !['error', 'not_available'].includes(card.state) && (card.state !== 'not_set_up' || Boolean(card.month?.length))
      : card.id === 'wholesale' ? ['ok', 'paused'].includes(card.state)
        : card.state === 'ok';
  if (card.id === 'retail') {
    view.support = card.support?.state === 'error' ? 'Open support tickets per store couldn’t be read just now.' : card.support?.state === 'ok'
      ? `${plural(card.support.total, 'open support ticket')}${card.support.unmatched ? ` (${n(card.support.unmatched)} not matched to a store)` : ''}`
      : `Open support tickets per store: not connected yet · comes with ${card.support?.comesWith ?? 'the helpdesk (D14)'}.`;
  }
  if (!figuresShown) return view;
  const day = (iso) => (iso ? fmt.date(String(iso).slice(0, 10)) : null);
  switch (card.id) {
    case 'wholesale':
      view.rows = [
        { key: 'month', label: 'Sales this month', value: periodText(card.month), detail: join([ordersText(card.month), `last month ${periodText(card.lastMonth)}`]) },
        { key: 'owing', label: 'Owed', value: money(card.owing?.cents), detail: plural(card.owing?.customers ?? 0, 'customer') },
        { key: 'overdue', label: 'Owed over 30 days', value: money(card.overdue?.cents), detail: plural(card.overdue?.customers ?? 0, 'customer'), tone: card.overdue?.cents ? 'danger' : null, link: '/wholesale' },
        { key: 'paid', label: 'Payments this month', value: money(card.paidThisMonth?.cents), detail: `${plural(card.paidThisMonth?.payments ?? 0, 'payment')}, recorded in the Order Manager` },
        { key: 'quiet', label: 'Quiet regulars', value: n(card.quietRegulars), detail: 'linked customers past their usual gap between orders', tone: card.quietRegulars ? 'warn' : null, link: '/crm' },
        card.toShip ? { key: 'ship', label: 'Packed, to ship', value: n(card.toShip.orders), detail: card.toShip.orders ? join([money(card.toShip.totalCents), card.toShip.oldestPackedAt ? `packed since ${day(card.toShip.oldestPackedAt)}` : null]) : 'nothing waiting' } : null,
        costsRow(card.costs),
      ].filter(Boolean);
      break;
    case 'stock': {
      const c = card.counts;
      const d = card.differences;
      const r = card.reorder;
      const del = card.deliveries;
      view.rows = [
        { key: 'full', label: 'Last full count', value: c?.lastFullCountAt ? day(c.lastFullCountAt) : c ? 'None yet' : '—', detail: c ? join([c.overdue ? 'a count is overdue' : c.due ? 'a count is due' : null, c.pctMatched30Days !== null && c.pctMatched30Days !== undefined ? `${c.pctMatched30Days} % matched in 30 days` : null]) : 'not read yet', tone: c?.overdue ? 'danger' : c?.due ? 'warn' : null },
        { key: 'spot', label: 'Last spot check', value: c?.lastSpotCheckAt ? day(c.lastSpotCheckAt) : c ? 'None yet' : '—' },
        { key: 'diff', label: 'Open count differences', value: d ? n(d.open) : '—', detail: d?.open ? `worth ${money(d.valueCents)}${d.truncated ? ' (the first 500)' : ''}` : null, tone: d?.open ? 'warn' : null },
        { key: 'reorder', label: 'To reorder', value: r ? plural(r.products, 'product') : '—', detail: r?.products ? join([`from ${plural(r.suppliers, 'supplier')}`, r.out ? `${n(r.out)} out of stock` : null]) : r ? 'nothing to reorder' : null, tone: r?.out ? 'danger' : null },
        { key: 'deliveries', label: 'Deliveries expected', value: del ? n(del.expected) : '—', detail: del?.expected ? join([plural(del.tins, 'tin'), del.nextOn ? `next ${day(del.nextOn)}` : null, del.overdue ? `${n(del.overdue)} late` : null]) : null, tone: del?.overdue ? 'warn' : null },
      ];
      view.extra = card.fetchedAt ? `As Stockroom last said · read ${fmt.dateTime(card.fetchedAt)}. Read-only: counts and orders are done in Stockroom.` : null;
      break;
    }
    case 'web':
    case 'consulting': {
      const rel = card.relationships ?? { total: 0, byKind: {} };
      const kinds = Object.entries(rel.byKind ?? {}).filter(() => card.id === 'web').map(([k, v]) => `${n(v)} ${k === 'website' ? (v === 1 ? 'website' : 'websites') : 'social'}`);
      const p = card.pipeline ?? { open: [], openCount: 0, value: [] };
      const stages = (p.open ?? []).filter((s) => s.count).map((s) => `${n(s.count)} ${s.stage === 'lead' ? (s.count === 1 ? 'lead' : 'leads') : s.stage}`);
      view.rows = [
        { key: 'rels', label: 'Active relationships', value: n(rel.total), detail: join(kinds) || null },
        { key: 'services', label: 'Active services', value: n(card.services?.active), detail: join([card.services?.monthlyCents ? `${money(card.services.monthlyCents)} a month in plans and retainers` : null, card.services?.hourly ? `${n(card.services.hourly)} hourly` : null]) || null },
        { key: 'renewals', label: `Renewals in ${card.renewals?.days ?? 30} days`, value: n(card.renewals?.count), detail: card.renewals?.next ? `next: ${card.renewals.next.name}${card.renewals.next.accountName ? ` for ${card.renewals.next.accountName}` : ''}, ${day(card.renewals.next.date)}` : null, tone: card.renewals?.count ? 'warn' : null },
        { key: 'pipeline', label: 'Open pipeline', value: plural(p.openCount ?? 0, 'lead'), detail: join([join(stages) || null, p.value?.length ? `${perCurrency(p.value, 'cents')} first-year value` : null, p.wonThisMonth ? `${n(p.wonThisMonth)} won this month` : null]) || null, link: `/crm/pipeline?business=${card.businessId}` },
        { key: 'month', label: 'Sales this month', value: periodText(card.month), detail: handNote(card.month) },
        costsRow(card.costs),
      ];
      // Until invoices are a sales source (D18), consulting's sales are only those entered by hand.
      if (card.id === 'consulting' && !card.invoicesConnected) view.extra = 'Invoices aren’t connected yet: sales here are the ones entered by hand.';
      break;
    }
    case 'savePoint': {
      view.rows = [
        { key: 'today', label: 'Today', value: periodText(card.today), detail: ordersText(card.today) },
        { key: 'week', label: 'This week', value: periodText(card.week), detail: ordersText(card.week) },
        { key: 'month', label: 'This month', value: periodText(card.month), detail: join([ordersText(card.month), card.monthFromManual ? 'entered by hand' : null]) },
        card.toShip ? { key: 'ship', label: 'Orders to ship', value: n(card.toShip.orders), detail: card.toShip.orders ? join([card.toShip.nextShipBy ? `next ships by ${day(card.toShip.nextShipBy)}` : null, card.toShip.late ? `${n(card.toShip.late)} past the ship-by day` : null]) : 'nothing waiting', tone: card.toShip.late ? 'danger' : null, link: `/tasks?business=${B.save_point}` } : null,
        costsRow(card.costs),
      ].filter(Boolean);
      break;
    }
    case 'clients':
      view.rows = [
        { key: 'active', label: 'Active clients', value: n(card.active) },
        { key: 'new', label: 'Clients added this month', value: n(card.newThisMonth), detail: 'made in the suite this month, imports included' },
        { key: 'quiet', label: `Gone quiet (${card.quietDays ?? 60} days)`, value: card.quiet === null || card.quiet === undefined ? '—' : n(card.quiet), detail: 'nothing logged, no order', tone: card.quiet ? 'warn' : null, link: '/crm' },
        { key: 'leads', label: 'Open leads', value: n(card.openLeads), link: '/crm/pipeline' },
      ];
      break;
    case 'retail':
      view.rows = (card.stores ?? []).map((s) => ({
        key: `${s.source}:${s.store}`, label: s.name, value: periodText(s.month),
        detail: join([`this month · today ${periodText(s.today)}`, STORE_STATES[s.state] ?? null, s.tickets === null || s.tickets === undefined ? null : `${plural(s.tickets, 'open ticket')}`]),
        tone: ['failing', 'unreadable'].includes(s.state) ? 'danger' : s.tickets ? 'warn' : null, link: s.link,
      }));
      if (card.costs) view.rows.push(costsRow(card.costs));
      break;
    default:
      break;
  }
  return view;
}
const STORE_STATES = { paused: 'paused', failing: 'can’t be read right now', unreadable: 'its key can’t be read', removed: 'not connected (removed)', not_read: 'not read yet', by_hand: 'entered by hand' };

/**
 * The all-businesses card as a small table: { months: [{ month, label, lessLabel }], rows: [{ businessId, name,
 * personal, cells: [{ month, sales, less, negative }], costs }], together } — sales per month, recurring costs a month,
 * and each month's sales less those costs (per currency; only where both are in that currency). Costs are today's (no
 * history is kept): a past month says "less today's costs"; the month in progress takes only the share of its days
 * completed (elapsed ÷ days), so a month just begun isn't shown deep in the red.
 */
export function allBusinessesView(card, today) {
  const thisMonth = String(today).slice(0, 7);
  const [y, mo] = thisMonth.split('-').map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const elapsed = Math.max(0, Number(String(today).slice(8, 10)) - 1);
  const months = (card.months ?? []).map((m) => ({
    month: m,
    label: m === thisMonth ? `${shortMonth(m)} (so far)` : shortMonth(m),
    lessLabel: m === thisMonth ? `less costs for ${elapsed} of ${days} days` : 'less today’s costs',
  }));
  const share = (m, cents) => (m === thisMonth ? Math.round((cents * elapsed) / days) : cents);
  const less = (m, sales, costs) => {
    const cur = new Set([...(sales ?? []).map((f) => f.currency), ...(costs ?? []).filter((c) => c.monthlyCents).map((c) => c.currency)]);
    return [...cur].map((c) => {
      const s = (sales ?? []).find((f) => f.currency === c)?.total ?? 0;
      const k = share(m, (costs ?? []).find((x) => x.currency === c)?.monthlyCents ?? 0);
      return { currency: c, cents: s - k };
    }).filter((x) => x.cents !== 0);
  };
  const lessText = (list) => (list.length ? list.map((x) => `${x.cents < 0 ? '−' : ''}${money(Math.abs(x.cents), x.currency)}`).join(' + ') : '$0');
  const row = (name, monthsOf, costs, extra = {}) => ({
    name, ...extra,
    cells: months.map((m) => {
      const sales = monthsOf(m.month);
      const l = less(m.month, sales, costs);
      return { month: m.month, sales: periodText(sales), handEntered: (sales ?? []).some((f) => f.totalOnly), less: lessText(l), negative: l.some((x) => x.cents < 0) };
    }),
    costs: perCurrency(costs, 'monthlyCents') || '$0',
  });
  const rows = (card.businesses ?? []).map((b) => row(b.name, (m) => b.months.find((x) => x.month === m)?.sales ?? [], b.costs, { businessId: b.businessId, personal: b.personal, color: b.color }));
  const together = row('All businesses', (m) => card.together?.months.find((x) => x.month === m)?.sales ?? [], card.together?.costs ?? []);
  return { months, rows: rows.filter((r) => !r.personal), personal: rows.filter((r) => r.personal), together };
}

// ---- the goals scorecard ---------------------------------------------------------------------------

/** A target's amount or actual in words: "$1,500" / "12". */
export function measureValue(measure, value, currency = 'CAD') {
  if (value === null || value === undefined) return '—';
  return isMoneyMeasure(measure) ? money(value, currency ?? 'CAD') : n(value);
}
const TONES = { reached: 'good', ahead: 'good', on_pace: 'good', behind: 'warn', missed: 'danger', too_early: null, not_started: null, unknown: null };

/**
 * One target on the scorecard → { key, label, value ("$1,500 of $3,000"), pct (0–100 for the bar), expectedPct (where
 * today's straight line is), status, statusText, tone, detail }. Its pace comes from the server; `today` recomputes it
 * when the target came without (a device's own copy).
 */
export function targetLine(t, { month, today } = {}) {
  const pace = t.pace ?? targetPace({ amount: t.amount, actual: t.actual ?? null, month: `${month}-01`, today });
  const label = `${MEASURE_LABELS[t.measure] ?? t.measure}${isMoneyMeasure(t.measure) && t.currency && t.currency !== 'CAD' ? ` (${t.currency})` : ''}`;
  const value = `${measureValue(t.measure, t.actual, t.currency)} of ${measureValue(t.measure, t.amount, t.currency)}`;
  let detail;
  if (t.reason === 'total_only') detail = 'Can’t tell: sales entered by hand this month only have a total (use Total sales for this business).';
  else if (t.reason === 'not_available') detail = 'Not available here.';
  else if (pace.status === 'not_started') detail = 'This month hasn’t started.';
  else if (pace.status === 'too_early') detail = `${plural(pace.elapsed ?? 0, 'day')} of the month complete: the pace shows from the ${PACE_MIN_DAYS + 1}th.`;
  else if (pace.expected !== null && pace.expected !== undefined && pace.status !== 'reached') {
    detail = join([`${measureValue(t.measure, pace.expected, t.currency)} expected by yesterday’s end`, pace.projected !== null ? `on course for ${measureValue(t.measure, pace.projected, t.currency)}` : null]);
  } else detail = null;
  if (t.partial) detail = join([detail, 'orders entered by hand may be left out']);
  const pct = pace.pct === null || pace.pct === undefined ? 0 : Math.max(0, Math.min(100, pace.pct));
  const expectedPct = pace.expected !== null && pace.expected !== undefined && t.amount > 0 ? Math.min(100, Math.round((pace.expected / t.amount) * 100)) : null;
  return {
    key: t.id, label, value, pct, expectedPct, status: pace.status, statusText: `${PACE_LABELS[pace.status] ?? ''}${pace.pct !== null && pace.pct !== undefined ? ` · ${pace.pct} %` : ''}`,
    tone: TONES[pace.status] ?? null, detail, extras: t.extras?.length ?? 0,
  };
}

/** A business's priorities in one line: "1 of 2 priorities done". */
export function prioritiesText(priorities) {
  const list = priorities ?? [];
  if (!list.length) return 'No priorities this month';
  return `${n(list.filter((p) => p.done_at).length)} of ${plural(list.length, 'priority', 'priorities')} done`;
}
/** A priority's progress in words ("1 of 2", "3 so far", ''), as the monthly plan shows it. */
export function priorityProgress(p) {
  const progress = Number.isFinite(p.progress) ? p.progress : 0;
  const k = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));
  if (Number.isFinite(p.target) && p.target > 0) return `${k(progress)} of ${k(p.target)}`;
  return progress ? `${k(progress)} so far` : '';
}
