// What the client screens show of the Order Manager (D1), without React: its synced records
// (wholesale_order, wholesale_entry, wholesale_customer — written by the server only) turned into
// timeline items and account / client figures. Tested in client/test/wholesale.test.js.
//
// The figures themselves (spend net of refunds and credit notes, before tax; paid; store credit;
// last order) are worked out on the server from everything the Order Manager sent, one card per
// linked Order Manager customer. Here they are only added up: an account linked to two Order
// Manager customers, or a client with several accounts, sums its cards; last order = the newest.
import { BUSINESS_IDS } from '@suite/shared/crm';
import { formatMoney } from '../crm/logic.js';

export const WHOLESALE_BUSINESS_ID = BUSINESS_IDS.wholesale;

export const ENTRY_LABELS = Object.freeze({
  payment: 'Payment',
  refund: 'Refund',
  store_credit: 'Store credit given',
  credit_applied: 'Store credit used',
  return: 'Return',
  credit_note: 'Credit note',
});
export const ORDER_STATUS_LABELS = Object.freeze({ active: null, cancelled: 'Cancelled', deleted: 'Deleted in the Order Manager' });
export const PACKING_LABELS = Object.freeze({
  to_pack: 'To pack', check_again: 'Check again', packed: 'Packed', shipped: 'Gone out', cancelled_packed: 'Cancelled after packing',
  cancelled: null, history: 'Past order',
});
const METHOD_LABELS = { etransfer: 'e-Transfer', cash: 'cash', cheque: 'cheque', card: 'card', credit: 'card', other: 'other' };
const REMOVED_LABELS = {
  deleted: 'Deleted in the Order Manager', order_cancelled: 'Removed when its order was cancelled', order_deleted: 'Removed when its order was deleted',
  customer_deleted: 'Removed with its customer', gone: 'No longer in the Order Manager', gone_after_restore: 'No longer in the Order Manager (after a backup was restored there)',
};

const money = (c) => formatMoney(c) || '$0';

/** One order as a timeline item: { id, kind: 'wholesale', type: 'order', at, title, body, status, … }. */
export function orderItem(o) {
  const label = o.history_only ? 'Past order' : 'Order';
  const status = ORDER_STATUS_LABELS[o.status] ?? null;
  const packing = o.status === 'active' ? PACKING_LABELS[o.packing] ?? null : null;
  const facts = [money(o.total_cents)];
  if (o.paid_cents) facts.push(o.paid_cents >= o.total_cents ? 'paid' : `${money(o.paid_cents)} paid`);
  if (o.returned_cents) facts.push(`${money(o.returned_cents)} given back`);
  return {
    id: o.id,
    source: 'wholesale_order',
    type: 'order',
    business_id: WHOLESALE_BUSINESS_ID,
    account_id: o.account_id,
    at: o.at,
    title: `${label} #${o.number ?? '?'}${o.reference ? ` · ${o.reference}` : ''}`,
    facts: facts.join(' · '),
    body: o.items ? `${o.items}${o.item_count ? ` (${o.item_count} unit${o.item_count === 1 ? '' : 's'})` : ''}` : null,
    status,
    packing,
    struck: o.status !== 'active',
    date: o.order_date,
    record: o,
  };
}

/** One payment, refund, store credit, return or credit note as a timeline item. */
export function entryItem(e) {
  const method = e.method ? METHOD_LABELS[e.method] ?? e.method : null;
  const facts = [];
  if (e.kind === 'return') {
    if (e.amount_cents) facts.push(`${money(e.amount_cents)} back`);
  } else if (e.kind === 'credit_applied') {
    facts.push(money(Math.abs(e.amount_cents ?? 0)));
  } else {
    facts.push(money(e.amount_cents ?? 0));
  }
  if (method) facts.push(method);
  if (e.order_number) facts.push(`order #${e.order_number}`);
  let status = null;
  if (e.status === 'removed') {
    status = e.moved_to === 'store_credit' ? 'Kept as store credit when its order was deleted' : (REMOVED_LABELS[e.removed_reason] ?? 'Removed in the Order Manager');
  }
  const number = e.kind === 'credit_note' && e.number ? ` ${e.number}` : '';
  return {
    id: e.id,
    source: 'wholesale_entry',
    type: 'order',
    business_id: WHOLESALE_BUSINESS_ID,
    account_id: e.account_id,
    at: e.at,
    title: `${ENTRY_LABELS[e.kind] ?? e.kind}${number}`,
    facts: facts.join(' · '),
    body: e.detail || null,
    status,
    struck: e.status === 'removed',
    record: e,
  };
}

// ---- D5: notes from the Order Manager -------------------------------------------------------------
// Its CRM notes (a call, an email, a meeting, a note, a follow-up marked done) for linked customers:
// timeline rows like the suite's own activities, filtered under the matching activity type — a
// follow-up marked done under Notes — and always business wholesale, with who wrote it there.

export const NOTE_LABELS = Object.freeze({ note: 'Note', call: 'Call', email: 'Email', meeting: 'Meeting', follow_up: 'Follow-up done' });
/** The timeline's Type filter a note shows under: its own type; a follow-up marked done as a note. */
export const NOTE_FILTER_TYPES = Object.freeze({ note: 'note', call: 'call', email: 'email', meeting: 'meeting', follow_up: 'note' });

/** One Order Manager note as a timeline item. */
export function noteItem(n) {
  return {
    id: n.id,
    source: 'wholesale_note',
    type: NOTE_FILTER_TYPES[n.type] ?? 'note',
    business_id: WHOLESALE_BUSINESS_ID,
    account_id: n.account_id,
    at: n.at,
    title: NOTE_LABELS[n.type] ?? 'Note',
    facts: null,
    body: n.body || null,
    by: n.written_by ?? null,
    status: null,
    struck: false,
    record: n,
  };
}

/** A client's Order Manager records (D5: and notes) as timeline items (merged with its activities by the page). */
export function wholesaleItems(orders = [], entries = [], notes = []) {
  return [...orders.map(orderItem), ...entries.map(entryItem), ...notes.map(noteItem)];
}

/** D5: "Next follow-up in the Order Manager: Oct 12" — the earliest follow-up date on these cards (deleted customers left out), or null. */
export function nextFollowUp(cards = []) {
  let next = null;
  for (const c of cards) if (!c.gone && c.follow_up_date && (!next || c.follow_up_date < next)) next = c.follow_up_date;
  return next;
}

/** Activities as timeline items in the same shape (the page renders both). */
export function activityItem(a) {
  return { ...a, source: 'activity', record: a };
}

/**
 * Figures added up over Order Manager customer cards (an account's, or a whole client's):
 * { customers, orders, spendCents, paidCents, creditCents, lastOrderDate, firstOrderDate, gone } or null when none.
 */
export function sumCards(cards = []) {
  if (!cards.length) return null;
  const out = { customers: cards.length, orders: 0, spendCents: 0, paidCents: 0, creditCents: 0, lastOrderDate: null, firstOrderDate: null, gone: cards.every((c) => c.gone) };
  for (const c of cards) {
    out.orders += c.order_count ?? 0;
    out.spendCents += c.spend_cents ?? 0;
    out.paidCents += c.paid_cents ?? 0;
    out.creditCents += c.credit_cents ?? 0;
    if (c.last_order_date && (!out.lastOrderDate || c.last_order_date > out.lastOrderDate)) out.lastOrderDate = c.last_order_date;
    if (c.first_order_date && (!out.firstOrderDate || c.first_order_date < out.firstOrderDate)) out.firstOrderDate = c.first_order_date;
  }
  return out;
}

/** Latest Order Manager order time per client: Map<client_id, at> (for the client list's "last activity"). */
export function lastOrderByClient(orders = []) {
  const m = new Map();
  for (const o of orders) {
    if (!o.at) continue;
    const cur = m.get(o.client_id);
    if (!cur || o.at > cur) m.set(o.client_id, o.at);
  }
  return m;
}

/** Last activity per client: the later of its activities' and its Order Manager orders'. */
export function mergeLastActivity(activityMap, orderMap) {
  if (!orderMap?.size) return activityMap;
  const m = new Map(activityMap);
  for (const [id, at] of orderMap) {
    const cur = m.get(id);
    if (!cur || at > cur) m.set(id, at);
  }
  return m;
}

// ---- D3: the "Quiet regular" flag ----------------------------------------------------------------
// The server works out each linked customer's ordering rhythm (server figures.js orderRhythm — the
// same rule the check-in automation uses) and puts it on the card: usual_gap_days, and quiet_from,
// the first day they count as quiet (their last order + more than 1.5 × the usual gap and more than
// the usual gap + 7 days). A date, so the device decides with its own "today": the flag appears on
// the right day offline, and goes away when a new order moves quiet_from (the card is re-sent).

/** Is this Order Manager customer card a regular who is past their usual gap on `today` (YYYY-MM-DD)? */
export function isQuietRegular(card, today) {
  return Boolean(card && !card.gone && card.quiet_from && today >= card.quiet_from);
}

/** "Usually orders every 14 days; none for 32" for a quiet regular's card (else null). */
export function quietRegularText(card, today) {
  if (!isQuietRegular(card, today)) return null;
  const since = card.last_order_date ? daysBetween(card.last_order_date, today) : null;
  return `Usually orders every ${card.usual_gap_days} day${card.usual_gap_days === 1 ? '' : 's'}${since === null ? '' : `; none for ${since}`}`;
}

/** Per client, the earliest day one of its regulars counts as quiet: Map<client_id, quiet_from> (cards of deleted customers left out). */
export function quietFromByClient(cards = []) {
  const m = new Map();
  for (const c of cards) {
    if (c.gone || !c.quiet_from) continue;
    const cur = m.get(c.client_id);
    if (!cur || c.quiet_from < cur) m.set(c.client_id, c.quiet_from);
  }
  return m;
}

/** Days from `a` to `b` ("YYYY-MM-DD"), on the calendar. */
export function daysBetween(a, b) {
  const t = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86_400_000);
}

// ---- D2: how a customer was linked, suggestions, the review's count --------------------------------

/** A suggestion's reasons, by kind, as the few words a link made from it carries ("similar name"). */
export const REASON_WORDS = Object.freeze({ email: 'same email', phone: 'same phone', address: 'same address', name: 'similar name' });

/**
 * How a link was made, for the Linked tab and the account card: "Linked automatically (same email)",
 * "Linked by you (similar name)", "Linked by your partner". `link` is a synced CRM link record
 * (matched_by, match_reason, _sync.createdBy) or the server's view of one (matchedBy, reason, by);
 * `me` = the signed-in person's actor.
 */
export function linkHowText(link, me) {
  if (!link) return null;
  const matchedBy = link.matched_by ?? link.matchedBy ?? null;
  const reason = link.match_reason ?? link.reason ?? null;
  const by = link.by ?? link.created_by ?? link._sync?.createdBy ?? null;
  const tail = reason ? ` (${reason})` : '';
  if (matchedBy === 'auto') return `Linked automatically${tail}`;
  const who = by && by !== 'system' && me ? (by === me ? 'you' : 'your partner') : null;
  return `Linked${who ? ` by ${who}` : ''}${tail}`;
}

/** The reason a person's link from a suggestion records: its strongest one ("same email" before "similar name"). */
export function suggestionReason(suggestion) {
  const kinds = new Set((suggestion?.reasons ?? []).map((r) => r.kind));
  const kind = ['email', 'phone', 'address', 'name'].find((k) => kinds.has(k));
  return kind ? REASON_WORDS[kind] : null;
}

/** An Order Manager customer's address on one line: "12 Main St, Unit 4, Simcoe ON N3Y 4K3". */
export function customerAddressText(address) {
  if (!address) return null;
  const place = [address.city, address.province].filter(Boolean).join(' ');
  const text = [address.line1, address.line2, [place, address.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return text || null;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The Friday review's "Duplicate matches" line from GET /api/wholesale/matches/counts. */
export function matchesSummary(counts) {
  if (!counts) return null;
  const parts = [];
  if (counts.customers) parts.push(`${plural(counts.customers, 'Order Manager customer', 'Order Manager customers')} may already be ${counts.customers === 1 ? 'a client' : 'clients'}`);
  if (counts.duplicates) parts.push(plural(counts.duplicates, 'possible duplicate among clients', 'possible duplicates among clients'));
  return parts.length ? parts.join(' · ') : 'Nothing to review: no possible matches.';
}
