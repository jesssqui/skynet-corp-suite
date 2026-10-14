// Sales by channel: Save Point Shop's sales from Whatnot, Poshmark and Facebook Marketplace, one
// total per channel per day, added on any device (offline too) and for past days. A synced record
// type (sale_day); no HTTP routes — devices read their offline copy, server code writes with
// sync.applyLocal. See CLAUDE.md, "Sales by channel".
import { fileURLToPath } from 'node:url';
import { createSalesService } from './service.js';

export default {
  name: 'sales',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createSalesService,
};
