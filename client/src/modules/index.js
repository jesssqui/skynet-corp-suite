// The client module registration list. Each module's index.jsx describes its
// nav entry and routes; the app shell builds the nav and router from this list.
//
// Module shape:
//   id      matches the server module name where there is one
//   nav     { label, icon, order, path?, id?, Badge?, phone? } — or a list of them (one module, several entries);
//           omit to stay out of the nav (path defaults to the first route). Badge: a component shown
//           beside the label (the inbox's count). phone: false = the sidebar only, not the phone's tab bar
//           (D11's overview: reached from Today and Money → Sales on a phone).
//   routes  [{ path, element }] — paths are absolute ('/', '/clients/:id')
// A module with no nav entry (connections, automations, wholesale, calendar) is reached from another's page;
// stockroom (D16) has no page at all: only its card's settings on Connections. sales (D12) has the Sales tab under
// Money (costs' nav entry); woocommerce (D12) only its cards' settings on Connections; ebay (D13) its card's settings
// and the page eBay sends the browser back to after a sign-in (/ebay/accepted).
import health from './health/index.jsx';
import auth from './auth/index.jsx';
import sync from './sync/index.jsx';
import crm from './crm/index.jsx';
import planner from './planner/index.jsx';
import connections from './connections/index.jsx';
import automations from './automations/index.jsx';
import wholesale from './wholesale/index.jsx';
import calendar from './calendar/index.jsx';
import costs from './costs/index.jsx';
import stockroom from './stockroom/index.jsx';
import sales from './sales/index.jsx';
import woocommerce from './woocommerce/index.jsx';
import ebay from './ebay/index.jsx';
import overview from './overview/index.jsx';

export const modules = [overview, planner, crm, costs, health, connections, automations, wholesale, auth, calendar, sync, stockroom, sales, woocommerce, ebay];

export const navItems = modules
  .flatMap((m) => (Array.isArray(m.nav) ? m.nav : m.nav ? [m.nav] : [])
    .map((nav) => ({ path: m.routes[0].path, ...nav, id: nav.id ? `${m.id}:${nav.id}` : m.id })))
  .sort((a, b) => a.order - b.order);

export const routes = modules.flatMap((m) => m.routes.map((r) => ({ ...r, key: `${m.id}:${r.path}` })));
