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
  start(ctx, service) {
    try {
      service.reconcile();
    } catch (err) {
      ctx.log.error('reconcile at start failed (tried again within a minute):', err);
    }
  },
  // A restore keeps the current shared secret (and who made it): restoring an old backup must not
  // bring back a secret that was replaced, or break the connection the Order Manager has now.
  keepOnRestore: ['wholesale_connection', 'wholesale_connection_changes'],
};
