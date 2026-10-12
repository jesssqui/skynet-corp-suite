// The overview (D11): one read for the home screen of the business — sales per business for today, this week and
// this month with the combined total, the list of what needs dealing with and (D15) a card per business with the goals
// scorecard. It reads the other modules through their services; its one table (D15) holds the monthly targets per
// business, a synced record type set offline on the monthly plan. Registered last (it reads all of them).
// See CLAUDE.md, "The overview (D11)" and "Overview cards and goals (D15)".
import { fileURLToPath } from 'node:url';
import { createOverviewService } from './service.js';
import { createOverviewRouter } from './routes.js';

export default {
  name: 'overview',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createOverviewService,
  createRouter: createOverviewRouter,
};
