// Paths that carry a secret in the URL itself (C6a: the task calendar feed's token) must never reach
// the log or an error message: the token is the only key to that person's feed.

const FEED_RE = /(\/api\/calendar\/feed\/)[^/?#\s]+/gi; // routing is case-insensitive

/** "/api/calendar/feed/<token>.ics?x" → "/api/calendar/feed/[link]?x". Anything else unchanged. */
export function redactPath(url) {
  return String(url ?? '').replace(FEED_RE, '$1[link]');
}
