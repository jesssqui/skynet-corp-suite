// Connections (C8): the registry of every connection to another app or service, each with its
// last success, queue size, last error and an off switch (CLAUDE.md, "Connections (C8)"). Comes
// right after sync in modules/index.js so every later module can register its connection in
// createService.
import { fileURLToPath } from 'node:url';
import { createConnectionsService } from './service.js';
import { createConnectionsRouter } from './routes.js';

export default {
  name: 'connections',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createConnectionsService,
  createRouter: createConnectionsRouter,
  // A restore keeps the current switches (backup/restore.js): it must never switch a paused
  // connection back on.
  keepOnRestore: ['connections_switches', 'connections_changes'],
};
