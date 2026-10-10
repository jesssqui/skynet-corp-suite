// The overview's words (D11), no React (client/test/overview.test.js). The server sends each section's items as data
// (ids, names, days, cents — server/src/modules/overview/service.js); this turns them into lines with a link to where
// each is dealt with, and pages them ("Show N more").
import { salesMoney } from '@suite/shared/sales';
import { BUSINESS_IDS } from '@suite/shared/crm';

/** Items shown at first, and how many more each "Show more" adds. */
export const FIRST_ITEMS = 5;
export const MORE_ITEMS = 20;

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;
const money = (cents, currency = 'CAD') => `${salesMoney(cents, currency)}${currency === 'CAD' ? '' : ` ${currency}`}`;
const PERIOD_WORDS = { once: '', monthly: '/mo', quarterly: '/qtr', yearly: '/yr' };
const WHOSE = { mine: 'Yours', partner: 'Your partner’s', shared: 'Shared list' };

/**
 * Each section's heading, where it is dealt with, and what to say when it can't be read:
 * { title, link, linkText, empty, unavailable? }.
 */
export const SECTIONS = Object.freeze({
  overdue: { title: 'Overdue tasks', link: '/tasks?due=overdue', linkText: 'All overdue tasks', empty: 'Nothing overdue.' },
  balances: { title: 'Wholesale balances over 30 days', link: '/wholesale?tab=linked', linkText: 'Order Manager customers', empty: 'Nothing owed over 30 days.' },
  renewals: { title: 'Renewals and retainers in the next 30 days', link: '/costs', linkText: 'Costs', empty: 'Nothing renews in the next 30 days.' },
  lowStock: { title: 'Low stock', link: `/tasks?business=${BUSINESS_IDS.wholesale}`, linkText: 'Wholesale tasks (reorders)', empty: 'Nothing to reorder, as Stockroom last said.' },
  support: { title: 'Support emails unanswered after 24 hours', link: null, linkText: null, empty: '' },
  payments: { title: 'Payments with no order to go against', link: '/wholesale?tab=linked', linkText: 'Order Manager customers', empty: 'None: every payment has an order to go against.' },
  noNextStep: { title: 'No next step', link: '/crm/pipeline', linkText: 'Pipeline', empty: 'Every active relationship and open lead has a dated next step.' },
  quiet: { title: 'Clients gone quiet', link: '/crm', linkText: 'Clients', empty: 'No active client has gone quiet.' },
});

/** What to say about a section that can't be read now (null when it can). */
export function stateNote(section) {
  switch (section.state) {
    case 'ok': return null;
    case 'paused': return section.id === 'lowStock' ? 'Stockroom is paused on Connections: this is its last answer.' : 'The Order Manager is paused on Connections: these are the last figures it sent.';
    case 'not_connected':
      if (section.id === 'support') return `Not connected yet · comes with ${section.comesWith ?? 'the helpdesk (D14)'}.`;
      if (section.id === 'lowStock') return 'Not connected: Stockroom is set up on System → Connections.';
      return 'Not connected: the Order Manager is set up on System → Connections.';
    case 'not_read': return 'Stockroom hasn’t been read yet.';
    case 'revoked': return 'Disconnected in Stockroom: paste a new code on System → Connections.';
    case 'not_available': return 'Not available here.';
    case 'error': return 'Couldn’t be read just now — try again in a moment.';
    default: return null;
  }
}

/** The extra line under the payments section: what the suite can't see. */
export const PAYMENTS_NOTE = 'E-transfers that matched no customer wait in the Order Manager (Customers → E-transfers): it doesn’t send them to the suite.';

/**
 * One item of a section → { key, text, detail, link, tone? }. `fmt` = { date(ymd) } (the page passes formatDate).
 */
export function itemLine(sectionId, item, fmt = { date: (d) => d }) {
  const day = (d) => (d ? fmt.date(d) : '');
  switch (sectionId) {
    case 'overdue':
      return {
        key: item.id, text: item.title, link: `/tasks?open=${item.id}`, tone: 'danger',
        detail: [`Due ${day(item.dueDate)}${item.dueTime ? ` ${item.dueTime}` : ''}`, WHOSE[item.whose] ?? null, item.business].filter(Boolean).join(' · '),
      };
    case 'balances':
      return {
        key: item.id, text: `${item.name}: ${money(item.overdueCents)}`, link: item.clientId ? `/crm/clients/${item.clientId}` : '/wholesale',
        detail: `${plural(item.orders, 'order')} over 30 days · the oldest from ${day(item.oldestDate)}${item.clientId ? '' : ' · not linked to a client'}`,
      };
    case 'renewals': {
      const amount = item.amountCents ? ` · ${money(item.amountCents, item.currency ?? 'CAD')}${PERIOD_WORDS[item.period] ?? ''}` : '';
      if (item.kind === 'cost') {
        return { key: `cost:${item.id}`, text: `${item.name} (our cost)`, link: `/costs?open=${item.id}`, detail: `Renews ${day(item.date)}${amount}${item.business ? ` · ${item.business}` : ''}${item.autoRenews ? ' · on its own' : ''}` };
      }
      return {
        key: `service:${item.id}`, text: `${item.name}${item.accountName ? ` for ${item.accountName}` : ''}`, link: item.clientId ? `/crm/clients/${item.clientId}` : '/crm',
        detail: `Renews ${day(item.date)}${amount}${item.business ? ` · ${item.business}` : ''}`,
      };
    }
    case 'lowStock': {
      const parts = [`Order ${plural(item.suggestedQty, 'tin')}`];
      if (Number.isFinite(item.daysLeft)) parts.push(`${plural(Math.max(0, Math.round(item.daysLeft)), 'day')} left${item.runsOutOn ? ` (runs out ${day(item.runsOutOn)})` : ''}`);
      else if (item.status === 'out') parts.push('out of stock');
      if (item.supplier) parts.push(item.supplier);
      return { key: item.id, text: `${item.name ?? item.sku}${item.sku && item.sku !== item.name ? ` (${item.sku})` : ''}`, link: null, detail: parts.join(' · '), tone: Number.isFinite(item.daysLeft) && item.daysLeft <= 7 ? 'danger' : null };
    }
    case 'payments':
      return {
        key: item.id, text: `${item.name}: ${money(item.unusedCents)} paid beyond every order`, link: item.clientId ? `/crm/clients/${item.clientId}` : '/wholesale',
        detail: 'Paid on account before ordering, paid twice, or paid on an order since cancelled — refund it or apply it there',
      };
    case 'noNextStep':
      if (item.kind === 'lead') return { key: `lead:${item.id}`, text: `Lead: ${item.name}`, link: `/crm/leads/${item.id}`, detail: [item.business, item.stage ? STAGES[item.stage] ?? item.stage : null].filter(Boolean).join(' · ') };
      return { key: `rel:${item.id}`, text: item.accountName, link: `/crm/clients/${item.clientId}`, detail: [item.business, item.clientName && item.clientName !== item.accountName ? item.clientName : null].filter(Boolean).join(' · ') };
    case 'quiet':
      return { key: item.id, text: item.name, link: `/crm/clients/${item.id}`, detail: item.since ? `Nothing since ${day(item.since)}` : 'Nothing logged yet' };
    default:
      return { key: String(item.id ?? Math.random()), text: String(item.name ?? item.title ?? ''), link: null, detail: '' };
  }
}
const STAGES = { lead: 'Lead', talking: 'Talking', quoted: 'Quoted' };

/** The count shown beside a section's title: "3", "—" when it can't be read. */
export function countText(section) {
  return section.count === null || section.count === undefined ? '—' : section.count.toLocaleString('en-CA');
}

/** A section's summary line under its title (what the count is made of), or ''. */
export function summaryText(section) {
  switch (section.id) {
    case 'overdue': return section.count ? 'Both of you and the shared list' : '';
    case 'balances': return section.count ? `${money(section.totalCents ?? 0)} owed on orders more than 30 days old` : '';
    case 'renewals': return section.count ? `${plural(section.services ?? 0, 'client service')}, ${plural(section.costs ?? 0, 'of our costs', 'of our costs')}` : '';
    case 'noNextStep': return section.count ? `${plural(section.relationships ?? 0, 'relationship')}, ${plural(section.leads ?? 0, 'lead')}` : '';
    case 'quiet': return section.count ? `Active clients with nothing for ${section.days ?? 60} days (a note, a call, an order)` : '';
    default: return '';
  }
}

/** How many items of a list to show after `taps` taps on "Show more": FIRST_ITEMS, then MORE_ITEMS more each. */
export const shownCount = (taps) => FIRST_ITEMS + taps * MORE_ITEMS;

/**
 * "Show 20 more" / "Show 3 more" / null — of what the server sent; and when the server sent fewer than the count
 * (capped), the rest are only on the section's own page: "and N more on …".
 */
export function moreText(section, shown) {
  const sent = section.items?.length ?? 0;
  if (shown < sent) return `Show ${Math.min(MORE_ITEMS, sent - shown)} more`;
  return null;
}
export function restText(section, shown) {
  const sent = section.items?.length ?? 0;
  const count = section.count ?? 0;
  if (shown >= sent && count > sent) return `and ${(count - sent).toLocaleString('en-CA')} more`;
  return null;
}

/** The headline count: sections that can be read and have something, plus this device's changes it couldn't save. */
export function attentionTotal(attention, syncAttention = 0) {
  return (attention ?? []).reduce((a, s) => a + (s.state !== 'not_connected' && s.count ? s.count : 0), 0) + (syncAttention || 0);
}

/** A business's line in the sales strip when a figure is entered by hand only ("incl. entered by hand"). */
export function totalOnlyNote(figures) {
  return ['today', 'week', 'month'].some((p) => figures?.[p]?.some((f) => f.totalOnly)) ? 'Includes sales entered by hand' : '';
}
/** A business's problem stores in words ("Tins Xpress can’t be read right now"), or ''. */
export function storesNote(stores) {
  const bad = (stores ?? []).filter((s) => ['failing', 'paused', 'unreadable', 'signed_out'].includes(s.state));
  if (!bad.length) return '';
  const what = { failing: 'can’t be read right now', paused: 'is paused', unreadable: 'can’t be read on this server', signed_out: 'is signed out' };
  return bad.map((s) => `${s.name} ${what[s.state]}`).join(' · ');
}
