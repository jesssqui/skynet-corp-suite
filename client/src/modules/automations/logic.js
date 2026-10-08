// The Automations page's text, without React (tested in client/test/automations.test.js).
import { formatDateTime } from '../../ui/format.js';
import { actorLabel } from '../crm/logic.js';

const SOON_MS = 90 * 1000;

/** What a run did: its summary, or "Failed: …". */
export function runWhat(run) {
  return run.status === 'error' ? `Failed: ${run.error}` : run.summary;
}

/** When and how a run happened: "Oct 9, 2026, 8:00 AM · on schedule" / "… · Run now by you". */
export function runWhen(run, me) {
  const how = run.trigger === 'schedule' ? 'on schedule'
    : run.trigger === 'event' ? 'after an event'
      : `Run now${run.actor ? ` by ${(actorLabel(run.actor, me) ?? run.actor).toLowerCase()}` : ''}`;
  return `${formatDateTime(run.startedAt)} · ${how}`;
}

/** Both on one line: "Oct 9, 2026, 8:00 AM · on schedule · Made the Friday review…". */
export function runText(run, me) {
  return `${runWhen(run, me)} · ${runWhat(run)}`;
}

/** When it runs next: a time, "Due now (within a minute)", "Switched off", or for event triggers "When it happens". */
export function nextRunText(a, { scheduled = true, now = Date.now() } = {}) {
  if (!a.enabled) return 'Switched off — Run now still works';
  if (a.trigger?.type === 'event') return 'When it happens';
  if (!a.nextRunAt) return '—';
  const at = Date.parse(a.nextRunAt);
  const when = at - now < SOON_MS ? 'Due now (within a minute)' : formatDateTime(a.nextRunAt);
  return scheduled ? when : `${when} — scheduler off on this server`;
}
