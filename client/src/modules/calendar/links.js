// The task calendar link's addresses (C6a), no React (client/test/calendar.test.js).

/**
 * The https (or http) link and its webcal:// twin, from the suite's address (SUITE_URL when the
 * server has one, else the address this page is open at) and the feed's path.
 */
export function feedLinks(origin, path) {
  const base = String(origin ?? '').replace(/\/+$/, '');
  const url = `${base}${path}`;
  return { url, webcal: url.replace(/^https?:\/\//, 'webcal://') };
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
