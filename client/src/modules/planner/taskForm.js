// The task add/edit form without React: what it holds and the fields it saves, so the "only what
// you changed" rule is tested against a real engine (client/test/planner-forms.test.js). Same
// contract as the CRM's forms (../crm/formFields.js: valuesFrom, editChanges, isDirty).
import { ESTIMATE_MAX_MINUTES, TASK_TITLE_MAX, topField } from '@suite/shared/planner';
import { valuesFrom } from '../crm/formFields.js';
import { textOrNull } from '../crm/logic.js';
import { nowIso } from '../../ui/format.js';

export { editChanges, isDirty, changedFields } from '../crm/formFields.js';

export const taskForm = {
  defaults: {
    title: '', notes: '', owner: '', business_id: '', client_id: '', account_id: '', relationship_id: '', goal_id: '',
    due_date: '', due_time: '', estimate: '', done: false, done_at: '', top: false, top_prev: '', today: '', me: 'owner',
  },
  // estimate is typed/picked as text; done and top are ticks over done_at / the person's top field.
  fromRecord: (v, record) => ({
    ...v,
    estimate: record?.estimate_minutes ? String(record.estimate_minutes) : '',
    done: Boolean(record?.done_at),
  }),
  toFields(v) {
    const problems = {};
    const title = textOrNull(v.title);
    if (!title) problems.title = 'Give the task a title';
    else if (title.length > TASK_TITLE_MAX) problems.title = `Keep it under ${TASK_TITLE_MAX} characters`;
    if (!v.business_id) problems.business_id = 'Pick one of our businesses (or Personal)';
    if (v.due_time && !v.due_date) problems.due_time = 'Pick a date for this time';
    const est = String(v.estimate ?? '').trim();
    const estimate = est === '' ? null : Number(est);
    if (estimate !== null && !(Number.isSafeInteger(estimate) && estimate >= 1 && estimate <= ESTIMATE_MAX_MINUTES)) {
      problems.estimate = 'Minutes, from 1 to a week';
    }
    // Ticked "top 3 today" (this person's own pick): today; unticked: cleared if it was today's,
    // else whatever day it was.
    const topOn = v.top ? v.today : (v.top_prev && v.top_prev !== v.today ? v.top_prev : null);
    return {
      problems,
      fields: {
        title,
        notes: textOrNull(v.notes),
        owner: v.owner || null,
        business_id: v.business_id || null,
        client_id: v.client_id || null,
        account_id: v.account_id || null,
        relationship_id: v.relationship_id || null,
        goal_id: v.goal_id || null,
        due_date: v.due_date || null,
        due_time: v.due_date ? (v.due_time || null) : null,
        estimate_minutes: Number.isSafeInteger(estimate) ? estimate : null,
        done_at: v.done ? (v.done_at || nowIso()) : null,
        [topField(v.me || 'owner')]: topOn || null,
      },
    };
  },
};

/**
 * The form's values for a task (or a new one): `today` (the device's local date, for the top-3
 * tick), `me` (whose pick the tick is) and `initial` (pre-filled values for a new task: owner,
 * business, client…).
 */
export function taskValues(record, { today, me = 'owner', initial = {} } = {}) {
  const v = { ...valuesFrom(taskForm, record), today, me, ...(record ? {} : initial) };
  v.top_prev = record?.[topField(me)] ?? '';
  v.top = Boolean(v.top_prev) && v.top_prev === today;
  return v;
}

/**
 * Picking a client, account or relationship keeps the others consistent: a relationship sets its
 * account and business (a next step is for that business); a client change drops an account or
 * relationship of another client; an account change drops a relationship on another account.
 */
export function linkChange(v, key, value, { accountsById, relationshipsById }) {
  const next = { ...v, [key]: value };
  if (key === 'relationship_id' && value) {
    const rel = relationshipsById.get(value);
    if (rel) {
      next.account_id = rel.account_id;
      next.business_id = rel.business_id;
      next.client_id = accountsById.get(rel.account_id)?.client_id ?? next.client_id;
    }
  }
  if (key === 'client_id') {
    if (next.account_id && accountsById.get(next.account_id)?.client_id !== value) next.account_id = '';
    const rel = relationshipsById.get(next.relationship_id);
    if (rel && accountsById.get(rel.account_id)?.client_id !== value) next.relationship_id = '';
  }
  if (key === 'account_id' && value) {
    const rel = relationshipsById.get(next.relationship_id);
    if (rel && rel.account_id !== value) next.relationship_id = '';
  }
  if (key === 'due_date' && !value) next.due_time = '';
  return next;
}

/**
 * Picking the goal a task is part of (C4b): only the goal changes. The business is never changed
 * silently (the task may be a client's next step for another business): when it differs from the
 * goal's, the sheet says so and offers one tap to use the goal's (goalBusinessNote).
 */
export function goalPick(v, goalId) {
  return { ...v, goal_id: goalId };
}

/** The goal's business when the form's business differs from it (for "Different business from the goal"), else null. */
export function goalBusinessNote(v, goalsById) {
  const goal = v.goal_id ? goalsById?.get(v.goal_id) : null;
  return goal && v.business_id && goal.business_id !== v.business_id ? goal.business_id : null;
}
