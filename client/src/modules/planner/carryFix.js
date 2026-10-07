// "Carried over twice · Remove the extra" (C4b), without React: works on the sync engine (or the
// store) so it is tested against a real server (client/test/planning-forms.test.js).
//
// When both devices carried the same goal before seeing each other's copy, each moved the goal's
// open tasks to its own copy, so those tasks also carry an open goal_id clash between the two
// copies. Removing the extra moves its open tasks to the copy kept, deletes the extra, sends that,
// then settles those clashes keeping the surviving goal — otherwise "Use this instead" would point
// at the deleted copy. Settling a clash needs a connection (C2b).
import { isOpenTask } from '@suite/shared/planner';

/** Open goal_id clashes on tasks that are only about these goals: [{ task, clash }]. */
export function goalClashesToSettle(tasks, goalIds) {
  const out = [];
  for (const t of tasks) {
    for (const c of t._sync?.clashes ?? []) {
      if (c.field === 'goal_id' && !c.resolved && goalIds.has(c.winner?.value) && goalIds.has(c.loser?.value)) out.push({ task: t, clash: c });
    }
  }
  return out;
}

/**
 * Remove the extra copies of a goal carried twice, keeping `keep`.
 * @param {{ list, update, remove, syncNow, resolveClash }} engine
 * @returns {Promise<{ moved: number, settled: number }>}
 */
export async function removeExtraCopies(engine, { keep, extras }) {
  const extraIds = new Set(extras.map((e) => e.id));
  let moved = 0;
  for (const t of await engine.list('task')) {
    if (isOpenTask(t) && extraIds.has(t.goal_id)) {
      await engine.update('task', t.id, { goal_id: keep.id });
      moved += 1;
    }
  }
  for (const e of extras) await engine.remove('goal', e.id);
  await engine.syncNow('carry-fix'); // the moves reach the server before the clashes are settled
  let settled = 0;
  const ids = new Set([keep.id, ...extraIds]);
  for (const { task, clash } of goalClashesToSettle(await engine.list('task'), ids)) {
    if (task.goal_id !== keep.id) continue; // changed again since: leave it for a person
    await engine.resolveClash(clash.id, 'keep_winner'); // the record keeps the surviving goal
    settled += 1;
  }
  return { moved, settled };
}
