// The WooCommerce cards' words (D12), no React (client/test/sales.test.js).

/** A store's Connections row id ("woo-<32 hex>") → the store's id (its UUID), or null. */
export function storeIdOf(connectionId) {
  const m = /^woo-([0-9a-f]{32})$/.exec(String(connectionId ?? ''));
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Our businesses a store can belong to: not archived (unless it is the store's own). */
export function businessChoices(businesses, current = null) {
  return (businesses ?? []).filter((b) => !b.archived || b.id === current).map((b) => ({ value: b.id, label: b.name }));
}

/** Where to make the key, step by step (shown on the Add a store form). */
export const KEY_STEPS = Object.freeze([
  'In the store’s WordPress admin: WooCommerce → Settings → Advanced → REST API → Add key.',
  'Description “Skynet suite (read only)”, User: a shop manager or administrator, Permissions: Read.',
  'Generate API key, then copy the consumer key (ck_…) and the consumer secret (cs_…) here. WooCommerce shows the secret once.',
]);

/** The one line about permissions the form must say (the suite can't check it). */
export const READ_ONLY_NOTE = 'WooCommerce doesn’t tell the suite which permission a key has, so it can’t check this for you. The suite only ever reads, but a Read key means nothing else could happen even if it tried.';
