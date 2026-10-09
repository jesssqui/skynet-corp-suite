// The task calendar link's address (C6a), no React (client/test/calendar.test.js).
//
// Only the https link, pasted into Add Subscribed Calendar / New Calendar Subscription. No webcal://
// link (review decision): calendar apps may fetch webcal:// over plain http, which Tailscale Serve's
// HTTPS-only address (often on :8443) doesn't answer, so a tap would fail in a confusing way.

/** The link, from the suite's address (SUITE_URL when the server has one, else this page's) and the feed's path. */
export function feedLinks(origin, path) {
  const base = String(origin ?? '').replace(/\/+$/, '');
  return { url: `${base}${path}` };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Why a link made at this address won't work on the iPhone, or null: the Mac's own localhost
 * address (only that Mac can open it) or plain http (Tailscale Serve gives the suite https).
 */
export function linkReachProblem(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (LOCAL_HOSTS.has(url.hostname)) return 'local';
  if (url.protocol === 'http:') return 'http';
  return null;
}
