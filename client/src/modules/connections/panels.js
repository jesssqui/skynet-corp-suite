// Extra settings a connection shows on its Connections card (D1: the Order Manager's address and
// shared secret). A module registers its panel when its client module loads:
//   registerConnectionPanel('wom', WomConnectionPanel)   // ({ connection, offline, onChanged }) => JSX
// D12: an id ending in "*" is a prefix — registerConnectionPanel('woo-*', StorePanel) is the panel of every
// WooCommerce store's row ("woo-<store id>"). An exact id wins over a prefix.
const panels = new Map();

export function registerConnectionPanel(id, Component) {
  panels.set(id, Component);
}

export function connectionPanel(id) {
  if (panels.has(id)) return panels.get(id);
  for (const [key, Component] of panels) {
    if (key.endsWith('*') && id.startsWith(key.slice(0, -1))) return Component;
  }
  return null;
}
