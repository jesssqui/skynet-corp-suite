// Renewals and recurring costs (D6): the `recurring_cost` record type (what our businesses and
// the home pay for — synced, offline on devices, written only through sync steps), the reminder
// automations for client service renewals (30 days ahead) and our costs' renewals (14 days ahead,
// rolling auto-renewing ones forward), and the monthly totals other modules read. No HTTP routes:
// devices use their offline copy (the Costs page), server code the service. See CLAUDE.md,
// "Renewals and recurring costs (D6)".
import { fileURLToPath } from 'node:url';
import { createCostsService } from './service.js';

export default {
  name: 'costs',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createCostsService,
};
