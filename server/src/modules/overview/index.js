// The overview (D11): one read for the home screen of the business — sales per business for today, this week and
// this month with the combined total, and the list of what needs dealing with. No tables of its own: it reads the
// other modules through their services. Registered last (it reads all of them). See CLAUDE.md, "The overview (D11)".
import { createOverviewService } from './service.js';
import { createOverviewRouter } from './routes.js';

export default {
  name: 'overview',
  createService: createOverviewService,
  createRouter: createOverviewRouter,
};
