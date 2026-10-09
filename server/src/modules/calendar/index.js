// The task calendar feed (C6a): each person's dated tasks (their own and the shared list's) as an
// iCalendar feed Apple Calendar subscribes to, by a secret link per person (Account → Calendar).
// The feed route is public (a calendar can't sign in) — GET /api/calendar/feed/<token>.ics only;
// managing the link needs a session. Tasks are read through the planner's service. See CLAUDE.md,
// "Task calendar feed (C6a)". C6b (meetings from Apple Calendar over CalDAV) comes later.
import { fileURLToPath } from 'node:url';
import { createCalendarService } from './service.js';
import { createCalendarPublicRouter, createCalendarRouter } from './routes.js';

export default {
  name: 'calendar',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createCalendarService,
  createPublicRouter: createCalendarPublicRouter,
  createRouter: createCalendarRouter,
  // A link someone subscribed to keeps working across a restore, and one replaced or turned off
  // after the backup was made (because it leaked) never comes back to life.
  keepOnRestore: ['calendar_feeds', 'calendar_feed_changes'],
};
