// Automations (C8): the framework — a registry of automations (trigger, on/off, silent/alert,
// runs), the minute scheduler (started by src/index.js) and in-app alerts (the synced 'alert'
// record type). The automations themselves live with the module whose data they use (the planner
// registers the Friday review and "no next step"). See CLAUDE.md, "Automations (C8)".
import { fileURLToPath } from 'node:url';
import { createAutomationsService } from './service.js';
import { createAutomationsRouter } from './routes.js';

export default {
  name: 'automations',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createAutomationsService,
  createRouter: createAutomationsRouter,
  // A restore keeps the current switches (backup/restore.js), like the connections' switches.
  keepOnRestore: ['automations_settings', 'automations_changes'],
};
