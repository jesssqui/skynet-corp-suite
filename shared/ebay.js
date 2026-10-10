// eBay (D13): facts the server and the eBay card share — what an App ID, a Cert ID and a RuName look like, so the
// card and the server refuse the same mistakes. D13b: the RuName box holding the App ID (or the Cert ID) is refused
// with a plain message: eBay answers such a sign-in with `invalid_request` and no hint why.

/** The App ID and the Cert ID as eBay writes them (letters, digits, `.`, `_`, `-`). Matches any RuName too. */
export const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{9,99}$/;
export const RUNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{4,99}$/; // e.g. Save_Point_Shop-SavePoin-suite-abcdefgh

/**
 * An App ID's own shape: `<name>-<app>-PRD-<hex>-<hex>` (or SBX), e.g. SavePoin-suite-PRD-1a2b3c4d5-6e7f8a9b. A RuName is
 * `<user>-<app>-<app name>-<letters>` (e.g. Jessy_Rho-JessyRho-GWNLIS-abcdefgh): never PRD/SBX followed by two hex parts at
 * its end, so this only matches an App ID.
 */
export const APP_ID_SHAPE_RE = /-(PRD|SBX)-[0-9a-f]{6,}-[0-9a-f]{6,}$/i;
/** A Cert ID's own shape: `PRD-<hex>-<hex>…` (or SBX), e.g. PRD-1a2b3c4d5e6f-7a8b-9c0d-1e2f-3a4b. */
export const CERT_ID_SHAPE_RE = /^(PRD|SBX)-[0-9a-f]{6,}(-[0-9a-f]{2,})+$/i;

export const RUNAME_IS_APP_ID = 'That’s the App ID, not the RuName: on developer.ebay.com → Application Keysets → Production → User Tokens, copy the value in the “RuName (eBay Redirect URL name)” column.';
export const RUNAME_IS_CERT_ID = 'That’s the Cert ID, not the RuName: on developer.ebay.com → Application Keysets → Production → User Tokens, copy the value in the “RuName (eBay Redirect URL name)” column.';

/**
 * Is this RuName really the App ID or the Cert ID pasted in the wrong box? → the message, or null. `appId` / `certId`
 * (optional) are compared too, so an exact copy of either is caught whatever its shape.
 */
export function ruNameMixUp({ ruName, appId = null, certId = null }) {
  const r = String(ruName ?? '').trim();
  if (!r) return null;
  const same = (x) => x && String(x).trim().toLowerCase() === r.toLowerCase();
  if (same(appId) || APP_ID_SHAPE_RE.test(r)) return RUNAME_IS_APP_ID;
  if (same(certId) || CERT_ID_SHAPE_RE.test(r)) return RUNAME_IS_CERT_ID;
  return null;
}
