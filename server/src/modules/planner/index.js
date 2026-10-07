// The planner (C4a): tasks (owner, business, client/account/relationship, due date and time,
// estimate, done, today's top 3) and the capture inbox — synced record types, offline on devices,
// written only through sync steps. No HTTP routes: devices read their offline copy, and server
// code writes with sync.applyLocal. C4b adds week goals and month priorities here.
// See CLAUDE.md, "Planner (C4a)".
import { fileURLToPath } from 'node:url';
import { createPlannerService } from './service.js';

export default {
  name: 'planner',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createPlannerService,
};
