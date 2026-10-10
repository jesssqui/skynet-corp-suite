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
import calendar from './calendar/index.js';
import costs from './costs/index.js';
import stockroom from './stockroom/index.js';
import sales from './sales/index.js';
import woocommerce from './woocommerce/index.js';
import ebay from './ebay/index.js';

// auth comes first: app.js puts its guard in front of every route.
// sync comes before every module that registers synced entities with it (crm, planner, …);
// connections and automations come right after sync (automations registers the synced 'alert'),
// so every later module can register its connection or automations in createService;
// planner comes after crm (its tasks point at CRM records);
// wholesale (D1) comes last: its records belong to CRM accounts, it registers the 'wom' connection
// and emits the Order Manager's events to automations;
// calendar (C6a) after the planner, whose tasks its feed reads (through the planner's service);
// costs (D6) after the crm and the planner: its costs belong to our businesses, its reminders are tasks;
// stockroom (D16) after the planner and automations: it registers the 'stockroom' connection and its
// automations make tasks.
// sales (D12) holds the daily sales totals every source writes (woocommerce now, ebay with D13); it comes
// before them. woocommerce (D12) after connections (each store is a row) and sales (it writes totals there);
// ebay (D13) after sales and the planner (its totals go to sales, its automations make tasks).
export const modules = [auth, health, sync, connections, automations, crm, planner, wholesale, calendar, costs, stockroom, sales, woocommerce, ebay];
