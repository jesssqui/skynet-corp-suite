// The CRM's core records (C3a): our businesses, clients, accounts, contacts, consent,
// relationships, services, activities and links — all synced record types (offline on devices,
// written only through sync steps). See CLAUDE.md, "CRM (crm module, C3a)".
import { fileURLToPath } from 'node:url';
import { createCrmService } from './service.js';
import { createCrmRouter } from './routes.js';

export default {
  name: 'crm',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createCrmService,
  createRouter: createCrmRouter,
  // After every service exists (sync has checked the refs): our businesses, once.
  start(_ctx, service) {
    service.seedBusinesses();
    service.imports.markInterrupted(); // an import cut off by a restart
  },
  // The CSV import sends the file's text as JSON (up to 5 MB of text): a larger body limit there.
  bodyLimits: { '/import': '8mb' },
};
