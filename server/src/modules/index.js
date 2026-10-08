// The module registration list. Order matters: migrations run in this order, so
// a module that others build on comes first. To add a module, create
// modules/<name>/index.js (see health/ for the shape) and add it here.
import auth from './auth/index.js';
import health from './health/index.js';
import sync from './sync/index.js';
import connections from './connections/index.js';
import automations from './automations/index.js';
import crm from './crm/index.js';
import planner from './planner/index.js';
import wholesale from './wholesale/index.js';

// auth comes first: app.js puts its guard in front of every route.
// sync comes before every module that registers synced entities with it (crm, planner, …);
// connections and automations come right after sync (automations registers the synced 'alert'),
// so every later module can register its connection or automations in createService;
// planner comes after crm (its tasks point at CRM records);
// wholesale (D1) comes last: its records belong to CRM accounts, it registers the 'wom' connection
// and emits the Order Manager's events to automations.
export const modules = [auth, health, sync, connections, automations, crm, planner, wholesale];
