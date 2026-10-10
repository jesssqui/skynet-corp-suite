// Paths that reach the log or an error message are redacted first:
//   - the task calendar feed's token (C6a) — the only key to that person's feed;
//   - D13: every query string. Queries can carry personal or secret values (a search for a client's name, an email,
//     eBay's sign-in code on /ebay/accepted?code=…&state=…), and a 5xx is logged with its path, so the log only ever
//     says that there was a query ("?…"), never what it held.

const FEED_RE = /(\/api\/calendar\/feed\/)[^/?#\s]+/gi; // routing is case-insensitive

/** "/api/calendar/feed/<token>.ics?x" → "/api/calendar/feed/[link]?…"; "/api/crm/clients?q=Pat" → "/api/crm/clients?…". */
export function redactPath(url) {
  return String(url ?? '').replace(FEED_RE, '$1[link]').replace(/[?#].*$/s, (q) => (q.length > 1 ? '?…' : ''));
}
