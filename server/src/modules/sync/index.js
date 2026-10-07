// Offline sync: change steps, clashes, device bookmarks. Other modules register
// their synced record types with ctx.services.sync.registerEntity() and write
// those tables only through push/applyLocal. See CLAUDE.md, "Offline sync".
import { fileURLToPath } from 'node:url';
import { createSyncService } from './service.js';
import { createSyncRouter } from './routes.js';

export default {
  name: 'sync',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createSyncService,
  createRouter: createSyncRouter,
};
