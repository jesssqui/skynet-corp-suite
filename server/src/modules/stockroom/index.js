// Stock tasks from Stockroom (D16): the read-only connection to Stockroom (the Inventory Hub on Fly),
// pulled on a schedule, and the four automations that turn what it reads into tasks — reorders by
// supplier, the weekly spot check, deliveries to receive, differences to investigate. The suite only
// reads: no call to Stockroom can change anything. See CLAUDE.md, "Stock tasks from Stockroom (D16)".
import { fileURLToPath } from 'node:url';
import { createStockroomService } from './service.js';
import { createStockroomRouter } from './routes.js';

export default {
  name: 'stockroom',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createStockroomService,
  createRouter: createStockroomRouter,
  // The connection (address, key, encrypted secret) and its change log are server settings about
  // access, like D1's secret and the switches: a restore must never bring back a replaced or
  // forgotten key, nor lose the current one. The pulled answers and the reorder episodes are NOT kept:
  // the answers are refreshed by the next pull, and the episodes describe tasks that roll back with them.
  keepOnRestore: ['stockroom_connection', 'stockroom_connection_changes'],
};
