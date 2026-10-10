// The eBay card's words (D13), no React (client/test/ebay.test.js).
import { KEY_RE, RUNAME_RE, ruNameMixUp } from '@suite/shared/ebay';

/** The accept URL to give the RuName in eBay's developer site: the suite's own page on this address. */
export const acceptUrlFor = (origin) => `${String(origin ?? '').replace(/\/+$/, '')}/ebay/accepted`;

/** Can eBay send the browser back to this address? (https only; the ts.net address once Tailscale Serve is on.) */
export function acceptProblem(origin) {
  const o = String(origin ?? '');
  if (!o.startsWith('https://')) return 'eBay only sends the browser back to an https address. Until the suite has its ts.net address (Tailscale Serve), set any https accept URL there and paste the address eBay shows after “I agree” below.';
  return null;
}

/** The pasted address eBay showed after "I agree": has it a code and a state? '' = nothing typed. */
export function pastedProblem(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (/isAuthSuccessful=false|error=access_denied/i.test(t)) return 'That address says the sign-in wasn’t agreed to.';
  let u;
  try {
    u = new URL(t.startsWith('http') ? t : `https://x.invalid/?${t.replace(/^[?#]/, '')}`);
  } catch {
    return 'That isn’t an address';
  }
  if (!u.searchParams.get('code')) return 'No code in that address: copy the whole address from the browser after “I agree”';
  if (!u.searchParams.get('state')) return 'No state in that address: copy the whole address, or start again';
  return null;
}

/** What the card says about the connection. */
export function stateLine(info, formatDate) {
  // D13b: a keyset saved with the App ID in the RuName box can't sign in (eBay says only invalid_request).
  if (info?.ruNameProblem && ['not_signed_in', 'signed_out'].includes(info.state)) return 'Keyset saved, but its RuName isn’t right: save the keyset again (New keyset…) before signing in.';
  switch (info?.state) {
    case 'not_set_up': return 'Not set up: enter the keyset from eBay’s developer site.';
    case 'not_signed_in': return 'Keyset saved. Next: sign in to eBay (as Save Point Shop).';
    case 'signed_out': return `eBay stopped accepting the sign-in${info.signedOutReason ? ` (${info.signedOutReason})` : ''}: sign in again.`;
    case 'unreadable': return 'The Cert ID or sign-in can’t be read on this server (its key file is missing): enter the keyset and sign in again.';
    case 'paused': return 'Switched off: nothing is read from eBay.';
    case 'failing': return `Can’t read eBay right now: ${info.lastError ?? ''}`;
    case 'not_read': return 'Signed in: reading eBay…';
    default: return info?.refreshExpiresAt ? `Signed in${info.account ? ` as ${info.account}` : ''}; the sign-in is good until ${formatDate(info.refreshExpiresAt.slice(0, 10))}.` : 'Signed in.';
  }
}

/** The keyset form's own checks (the server checks again): null or a problem. */
export function keysetProblem({ appId, certId, ruName }) {
  if (!KEY_RE.test(String(appId ?? '').trim())) return 'The App ID (Client ID) from Application Keys → Production';
  if (/-SBX-/.test(appId)) return 'That is a Sandbox App ID: use the Production keyset';
  if (!KEY_RE.test(String(certId ?? '').trim())) return 'The Cert ID (Client Secret) from Application Keys → Production';
  if (!RUNAME_RE.test(String(ruName ?? '').trim())) return 'The RuName (User Tokens → your eBay Redirect URL name, not the address)';
  // D13b: the App ID (or Cert ID) pasted into the RuName box — the server refuses it too.
  return ruNameMixUp({ ruName, appId, certId });
}
