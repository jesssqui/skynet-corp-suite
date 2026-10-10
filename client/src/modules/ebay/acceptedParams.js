// eBay's sign-in code and state arrive in the address of /ebay/accepted (D13). Review fix: main.jsx calls
// captureAcceptedParams() before the app (and its sign-in screen) renders, so they leave the address bar and history at
// once; they wait here — in memory, and in this tab's sessionStorage in case the page reloads (a sign-in first) — until
// the accepted page takes them (once). No React.
const KEY = 'suite.ebay.accepted';
let held = null;

/** On /ebay/accepted: take code, state (and eBay's "not agreed" flag) out of the address and keep them for the page. */
export function captureAcceptedParams(loc = window.location, hist = window.history, storage = safeSession()) {
  if (!/^\/ebay\/(accepted|declined)\/?$/.test(loc.pathname) || !loc.search) return;
  const p = new URLSearchParams(loc.search);
  held = { code: p.get('code'), state: p.get('state'), declined: p.get('isAuthSuccessful') === 'false' };
  try {
    storage?.setItem(KEY, JSON.stringify(held));
  } catch { /* private mode: memory only */ }
  hist.replaceState(hist.state, '', loc.pathname);
}

/** The accepted page's one read: what was captured (then forgotten), or null. */
export function takeAcceptedParams(storage = safeSession()) {
  let out = held;
  if (!out) {
    try {
      out = JSON.parse(storage?.getItem(KEY) ?? 'null');
    } catch {
      out = null;
    }
  }
  held = null;
  try {
    storage?.removeItem(KEY);
  } catch { /* nothing kept */ }
  return out;
}

function safeSession() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
