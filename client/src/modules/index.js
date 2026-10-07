// The client module registration list. Each module's index.jsx describes its
// nav entry and routes; the app shell builds the nav and router from this list.
//
// Module shape:
//   id      matches the server module name where there is one
//   nav     { label, icon, order } — omit to stay out of the nav
//   routes  [{ path, element }] — paths are absolute ('/', '/clients/:id')
import home from './home/index.jsx';
import health from './health/index.jsx';

export const modules = [home, health];

export const navItems = modules
  .filter((m) => m.nav)
  .map((m) => ({ id: m.id, path: m.nav.path ?? m.routes[0].path, ...m.nav }))
  .sort((a, b) => a.order - b.order);

export const routes = modules.flatMap((m) => m.routes.map((r) => ({ ...r, key: `${m.id}:${r.path}` })));
