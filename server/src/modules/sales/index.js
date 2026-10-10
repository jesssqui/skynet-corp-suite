// Sales totals (D12): the shared daily-totals table that the store connections write (D12 WooCommerce; D13 eBay)
// and later packages read (D11, D15) — totals only, never customers or orders. See CLAUDE.md, "Sales totals (D12)".
import { fileURLToPath } from 'node:url';
import { createSalesService } from './service.js';
import { createSalesRouter } from './routes.js';

export default {
  name: 'sales',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createSalesService,
  createRouter: createSalesRouter,
};
