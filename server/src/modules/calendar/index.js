// The task calendar feed (C6a): each person's dated tasks (their own and the shared list's) as an
// iCalendar feed Apple Calendar subscribes to, by a secret link per person (Account → Calendar).
// The feed route is public (a calendar can't sign in) — GET /api/calendar/feed/<token>.ics only;
// managing the link needs a session. Tasks are read through the planner's service. See CLAUDE.md,
// "Task calendar feed (C6a)". C6b: meetings read from each person's Apple Calendar over CalDAV (apple.js,
// caldav.js, icsRead.js) into synced read-only `meeting` records — see "Meetings from Apple Calendar (C6b)".
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
  // C6b: each person's Apple Calendar connection likewise (a password replaced or forgotten after the backup never
  // comes back); what was read and the meetings are rolled back with the database and put right by the next read.
  keepOnRestore: ['calendar_feeds', 'calendar_feed_changes', 'calendar_apple', 'calendar_apple_changes'],
  // C6b: bring the meetings in line with what was read (after a restore they are rolled back).
  start(_ctx, service) {
    service.apple.start();
  },
};
