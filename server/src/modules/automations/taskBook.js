// What an automation did to its own tasks (D3, reused by D5 and D6): automations only ever make or
// change tasks, and a person may change those tasks too. So that the suite never undoes a person's
// work, it remembers — in automations_made, under its own keys — which values it wrote and which
// tasks it finished:
//   wrote:<task id>:<field>:<hash of the value>   the suite wrote this value of the field
//   suite-done:<task id>:<done_at>                 the suite finished the task at that moment
// A field whose current value the suite didn't write is a person's: left alone. A task finished by
// the suite may be reopened by it when its reason comes back; one a person finished (or deleted)
// is their call.
//
// `io` = the run's { planner, made, madeLike?, remember, update } (planner = the planner's service).
import crypto from 'node:crypto';
import { localDate, parseLocalDate } from '@suite/shared/time';

/** "Aug 1, 2026" for a calendar day. */
export const dayText = (ymd) => (ymd ? parseLocalDate(ymd).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : 'an unknown day');

const hash = (v) => crypto.createHash('sha256').update(String(v ?? '')).digest('hex').slice(0, 20);
const wroteKey = (id, field, value) => `wrote:${id}:${field}:${hash(value)}`;
export const doneKey = (id, doneAt) => `suite-done:${id}:${doneAt}`;

/** Remember that the suite wrote this value of a task's field (so a later change is known to be a person's). */
export function markWrote(io, id, field, value) {
  io.remember(wroteKey(id, field, value), 'task', id);
}
/** Is the task's current value of `field` one the suite wrote? (false = a person changed it: leave it). */
export function suiteWrote(io, id, field, value) {
  return io.made(wroteKey(id, field, value)).length > 0;
}
/** Was this task finished by the suite (and not reopened and finished again by a person since)? */
export function suiteFinished(io, id, state = io.planner.taskState(id)) {
  return Boolean(state?.live && state.doneAt && io.made(doneKey(id, state.doneAt)).length);
}

/** Finish one of the suite's own tasks (done_at), adding a line to its notes that says why. */
export function finishTask(io, id, why, now) {
  const t = io.planner.taskState(id);
  if (!t?.open) return false;
  const doneAt = now.toISOString();
  const line = `${why} — finished by the suite on ${dayText(localDate(now))}.`;
  io.update('task', id, { done_at: doneAt, notes: t.notes ? `${t.notes}\n\n${line}` : line });
  io.remember(doneKey(id, doneAt), 'task', id);
  return true;
}
