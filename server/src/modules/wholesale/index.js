// The wholesale connection (D1): the receiver for the Order Manager's outbox (POST /api/wom/events,
// HMAC-signed), the holding area for everything it sends, linking its customers to CRM accounts,
// and the synced records devices see (orders, payments, returns, refunds, each customer's figures).
// See CLAUDE.md, "Wholesale (D1)". Registered after crm, planner, connections and automations.
import { fileURLToPath } from 'node:url';
import { createWholesaleService } from './service.js';
import { createWholesaleRouter, signedRoutes } from './routes.js';

export default {
  name: 'wholesale',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createWholesaleService,
  createRouter: createWholesaleRouter,
  // The Order Manager signs each request; app.js mounts this one exact route before the guard.
  signedRoutes,
  // Catch up at start: links made while the server was down, rows a crash left dirty.
  // After a restore, put the synced records back as the holding area says (checkRestore), then catch up
  // in the background, in small transactions (reconcileAll).
  start(ctx, service) {
    try {
      service.checkRestore();
    } catch (err) {
      ctx.log.error('checking for a restore failed:', err);
    }
    try {
      service.checkCardVersion(); // D3: new card fields → every card brought up to date (below)
    } catch (err) {
      ctx.log.error('checking the card fields failed:', err);
    }
    service.reconcileAll().catch((err) => ctx.log.error('reconcile at start failed (tried again within a minute):', err));
  },
  // Kept across a restore — the one exception to "keepOnRestore is for switches, never data":
  //  - the shared secret (and who made it): an old backup must not bring back a replaced secret;
  //  - the holding area, the event keys and the receiver's status: they mirror ANOTHER app (the Order
  //    Manager), which won't send again what it already delivered. Rolled back with the suite, the
  //    suite would forget orders, payments and deletes made since the backup — and the Order Manager's
  //    "Forget everything + Send existing" can't repair deletes (it only sends what still exists).
  //    The synced records are rebuilt from them at start (checkRestore).
  keepOnRestore: [
    'wholesale_connection', 'wholesale_connection_changes',
    'wholesale_held_customers', 'wholesale_held_orders', 'wholesale_held_money', 'wholesale_events', 'wholesale_status',
  ],
};
