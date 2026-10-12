// Tickets from messages (D14), pure: which ticket a message belongs to, where a ticket stands, the 24-hour flag, and
// the order numbers an email mentions. The service applies these to its tables.

/** A ticket waiting on us this long or more is flagged (the overview's support line). */
export const FLAG_AFTER_MS = 24 * 60 * 60 * 1000;
/** A message with no thread headers joins an earlier ticket with the same subject and customer only this recently. */
export const SUBJECT_MATCH_DAYS = 30;
export const TICKET_STATES = Object.freeze(['waiting', 'answered', 'closed']);

const PREFIX = /^\s*((re|fw|fwd|aw|wg|sv|vs|antw|tr|rif|r|réf|ref)\s*(\[\d+\]|\(\d+\))?\s*[:：]\s*)+/i;
/** "RE: Fwd:  Where is my order?" → "where is my order?" (for matching only). */
export function subjectKey(subject) {
  let s = String(subject ?? '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 5; i += 1) {
    const next = s.replace(PREFIX, '').replace(/^\[[^\]]{1,40}\]\s*/, (m) => (/(ticket|support|case)/i.test(m) ? '' : m)).trim();
    if (next === s) break;
    s = next;
  }
  return s.toLowerCase().slice(0, 300);
}

/**
 * Where a ticket stands, from its messages' times (ISO, the server's receive time) and a person's close:
 *   handledAt   the later of our last reply and the close
 *   waiting     a customer message arrived after handledAt (or nothing handled it yet)
 *   state       waiting | closed (closed at or after our last reply) | answered
 *   waitingSince the first customer message after handledAt (null unless waiting)
 * → { state, waitingSince, lastCustomerAt, lastReplyAt, handledAt }
 */
export function ticketStatus({ inTimes = [], outTimes = [], closedAt = null }) {
  const max = (xs) => xs.reduce((a, b) => (a === null || b > a ? b : a), null);
  const lastCustomerAt = max(inTimes);
  const lastReplyAt = max(outTimes);
  const handledAt = max([lastReplyAt, closedAt].filter(Boolean));
  const after = inTimes.filter((t) => handledAt === null || t > handledAt).sort();
  if (after.length) return { state: 'waiting', waitingSince: after[0], lastCustomerAt, lastReplyAt, handledAt };
  const state = closedAt && (!lastReplyAt || closedAt >= lastReplyAt) ? 'closed' : lastReplyAt ? 'answered' : closedAt ? 'closed' : 'waiting';
  return { state, waitingSince: null, lastCustomerAt, lastReplyAt, handledAt };
}

/** Is a waiting ticket flagged now (24 hours or more)? */
export const isFlagged = (ticket, nowMs) => ticket?.state === 'waiting' && Boolean(ticket.waiting_since) && nowMs - Date.parse(ticket.waiting_since) >= FLAG_AFTER_MS;
/** Whole hours a ticket has waited (0 when not waiting). */
export const hoursWaiting = (ticket, nowMs) => (ticket?.state === 'waiting' && ticket.waiting_since ? Math.max(0, Math.floor((nowMs - Date.parse(ticket.waiting_since)) / 3_600_000)) : 0);

/**
 * Order numbers an email mentions: "#1234", "order 1234", "Order #TX-500", "order number: 1234", "commande 1234".
 * Each has at least one digit, 3–20 characters. At most `max`, in the order they appear.
 */
export function orderNumbers(text, max = 3) {
  const out = [];
  const add = (v) => {
    const n = String(v).replace(/^#/, '').toUpperCase();
    if (/\d/.test(n) && /^[A-Z0-9-]{3,20}$/.test(n) && !/^\d{4}-\d{2}(-\d{2})?$/.test(n) && !out.includes(n)) out.push(n);
  };
  const s = String(text ?? '');
  const re = /(?:\b(?:order|commande|ordre|pedido|bestellung)\s*(?:number|num(?:ber|éro|ero)?\.?|no\.?|n°|nr\.?|id)?\s*[:#]?\s*#?\s*([A-Za-z0-9-]{3,20}))|(?:#\s?(\d{3,12})\b)/gi;
  for (const m of s.matchAll(re)) {
    add(m[1] ?? m[2]);
    if (out.length >= max) break;
  }
  return out;
}

/** The first word of a customer's name, for a saved answer's {name} ("there" when there is none). */
export const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'-]/gu, '') || null;
