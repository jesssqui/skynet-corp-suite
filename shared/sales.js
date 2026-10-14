// Sales by channel (a sale_day record = one channel's total for one day), shared by the server's
// checks and the Sales page. Amounts are dollars with at most two decimals. A day's total for a
// channel is the SUM of its records, so two devices adding the same day offline never lose one.
//
// eBay is not here: its totals come in automatically (a connection, later), never typed by hand.

/** The channels entered by hand, in the order the page shows them. */
export const SALES_CHANNELS = Object.freeze([
  { id: 'whatnot', label: 'Whatnot' },
  { id: 'poshmark', label: 'Poshmark' },
  { id: 'facebook_marketplace', label: 'Facebook Marketplace' },
]);
export const SALES_CHANNEL_IDS = Object.freeze(SALES_CHANNELS.map((c) => c.id));

export const SALE_AMOUNT_MAX = 1_000_000;
export const SALE_NOTE_MAX = 500;

export function channelLabel(id) {
  return SALES_CHANNELS.find((c) => c.id === id)?.label ?? id;
}

/** Round to whole cents (sums of dollar amounts drift in floating point). */
export function roundCents(n) {
  return Math.round(n * 100) / 100;
}

/** An amount of 0 … SALE_AMOUNT_MAX with at most two decimals. */
export function isSaleAmount(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= SALE_AMOUNT_MAX && roundCents(n) === n;
}

/**
 * Totals of `rows` (sale_day records) for dates from..to inclusive ("YYYY-MM-DD"; either may be
 * null for open-ended): { byChannel: { [channel]: { total, days } }, total }. `days` counts the
 * distinct days with an entry. Every hand-entered channel is present, 0 when it has no entries.
 */
export function totalsByChannel(rows, { from = null, to = null } = {}) {
  const sums = Object.fromEntries(SALES_CHANNEL_IDS.map((id) => [id, { total: 0, dates: new Set() }]));
  for (const r of rows) {
    if (!sums[r.channel]) continue;
    if ((from && r.sale_date < from) || (to && r.sale_date > to)) continue;
    sums[r.channel].total += r.amount ?? 0;
    sums[r.channel].dates.add(r.sale_date);
  }
  const byChannel = Object.fromEntries(Object.entries(sums).map(([id, s]) => [id, { total: roundCents(s.total), days: s.dates.size }]));
  return { byChannel, total: roundCents(Object.values(byChannel).reduce((a, c) => a + c.total, 0)) };
}
