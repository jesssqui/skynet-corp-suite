// The goal add/edit form without React (C4b): what it holds and the fields it saves, with the same
// "only what you changed" contract as the CRM's and the task's forms (../crm/formFields.js).
// Kind and period are not edited here: a goal is made in its week or month (a goal carried over
// is a new copy), so an edit never sends one without the other (the server refuses that).
import { GOAL_TITLE_MAX } from '@suite/shared/planner';
import { valuesFrom } from '../crm/formFields.js';
import { textOrNull } from '../crm/logic.js';
import { nowIso } from '../../ui/format.js';

export { editChanges, isDirty } from '../crm/formFields.js';

/** "5", "2.5", "" -> 5, 2.5, null; NaN when it isn't a number. */
function numberOrNull(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

export const goalForm = {
  defaults: { title: '', business_id: '', owner: '', target: '', progress: '', notes: '', done: false, done_at: '' },
  fromRecord: (v, record) => ({
    ...v,
    target: Number.isFinite(record?.target) ? String(record.target) : '',
    progress: Number.isFinite(record?.progress) ? String(record.progress) : '',
    done: Boolean(record?.done_at),
  }),
  toFields(v) {
    const problems = {};
    const title = textOrNull(v.title);
    if (!title) problems.title = 'What is the goal?';
    else if (title.length > GOAL_TITLE_MAX) problems.title = `Keep it under ${GOAL_TITLE_MAX} characters`;
    if (!v.business_id) problems.business_id = 'Pick one of our businesses (or Personal)';
    const target = numberOrNull(v.target);
    if (Number.isNaN(target) || (target !== null && target <= 0)) problems.target = 'A number more than 0 (or leave it empty)';
    const progress = numberOrNull(v.progress);
    if (Number.isNaN(progress) || (progress !== null && progress < 0)) problems.progress = 'A number, 0 or more';
    return {
      problems,
      fields: {
        title,
        business_id: v.business_id || null,
        owner: v.owner || null,
        target: Number.isFinite(target) ? target : null,
        progress: Number.isFinite(progress) ? progress : null,
        notes: textOrNull(v.notes),
        done_at: v.done ? (v.done_at || nowIso()) : null,
      },
    };
  },
};

/** The form's values for a goal, or a new one with `initial` (business, owner…). */
export function goalValues(record, initial = {}) {
  return { ...valuesFrom(goalForm, record), ...(record ? {} : initial) };
}
