// eBay (D13): Save Point Shop's eBay account, read with the seller's own sign-in — daily sales totals (into the sales
// module) and the orders waiting to ship (as tasks), with no buyer details kept. Nothing is ever changed on eBay.
// See CLAUDE.md, "eBay (D13)".
import { fileURLToPath } from 'node:url';
import { createEbayService } from './service.js';
import { createEbayRouter } from './routes.js';

export default {
  name: 'ebay',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createEbayService,
  createRouter: createEbayRouter,
  // The keyset (Cert ID sealed), the sign-in (refresh token sealed) and their change log are server settings about
  // access, like D12's stores: a restore must never bring back a forgotten connection or an old sign-in, nor lose the
  // current one. Sign-ins in progress, the pull state and the orders waiting to ship are not kept (the next pull
  // refreshes them; a restore re-reads the backfill where days are missing).
  keepOnRestore: ['ebay_connection', 'ebay_changes'],
};
