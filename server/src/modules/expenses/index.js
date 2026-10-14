// Expenses (C9): what was spent, and which of our businesses it is for. Synced record types, offline on
// devices, written only through sync steps; no HTTP routes. See CLAUDE.md, "Expenses (C9)".
import { fileURLToPath } from 'node:url';
import { createExpensesService } from './service.js';

export default {
  name: 'expenses',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createExpensesService,
};
