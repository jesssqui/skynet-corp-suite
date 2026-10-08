// Extra settings a connection shows on its Connections card (D1: the Order Manager's address and
// shared secret). A module registers its panel when its client module loads:
//   registerConnectionPanel('wom', WomConnectionPanel)   // ({ connection, offline, onChanged }) => JSX
const panels = new Map();

export function registerConnectionPanel(id, Component) {
  panels.set(id, Component);
}

export const connectionPanel = (id) => panels.get(id) ?? null;
