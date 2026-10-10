// WooCommerce stores (D12): each retail store's REST API, read with its own read-only key — daily sales totals
// (Analytics → Revenue, written to the sales module) and live order lookups that are never stored. Nothing is ever
// changed in a store. See CLAUDE.md, "WooCommerce stores (D12)".
import { fileURLToPath } from 'node:url';
import { createWooService } from './service.js';
import { createWooRouter } from './routes.js';

export default {
  name: 'woocommerce',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createWooService,
  createRouter: createWooRouter,
  // The stores (address, key, encrypted secret) and their change log are server settings about access, like D16's
  // connection: a restore must never bring back a removed store or a replaced key, nor lose a store added since.
  // The pull bookkeeping is NOT kept: after a restore the next pull re-reads the window and the backfill, which
  // puts back the totals the restored copy is missing (they are upserts).
  keepOnRestore: ['woocommerce_stores', 'woocommerce_changes'],
};
