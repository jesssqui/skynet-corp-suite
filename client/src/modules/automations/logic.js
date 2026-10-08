// The Automations page's text, without React (tested in client/test/automations.test.js).
import { formatDateTime } from '../../ui/format.js';
import { actorLabel } from '../crm/logic.js';

const SOON_MS = 90 * 1000;

/** "Oct 9, 2026, 8:00 AM · on schedule · Made the Friday review…" / "… · Run now by you · Failed: …". */
export function runText(run, me) {
  const how = run.trigger === 'schedule' ? 'on schedule'
    : run.trigger === 'event' ? 'after an event'
      : `Run now${run.actor ? ` by ${(actorLabel(run.actor, me) ?? run.actor).toLowerCase()}` : ''}`;
  const what = run.status === 'error' ? `Failed: ${run.error}` : run.summary;
  return `${formatDateTime(run.startedAt)} · ${how} · ${what}`;
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
