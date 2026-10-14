// The helpdesk's automation (D14), registered with the automations framework (C8): a task on the SHARED list for each
// ticket waiting on us — "Answer support email #12 (TinsXpress)", business retail (the mailbox's business), due the day
// the customer wrote. Tasks only, made and changed through sync (applyLocal as system); nothing is ever sent.
//
// What a task holds (decision): the ticket's number, the mailbox's name and a link to the ticket — never the customer's
// name, email, subject or words. Tasks are synced to every device and their titles go into the calendar feed (C6a), so
// customer emails stay on the Support page (server data).
//
// Keys `ticket:<ticket id>:<episode>` (an episode = each time the ticket waits on us again): one task per wait.
// "Who finished it decides" (../automations/taskBook.js):
//   - the ticket answered (our reply seen in the Sent folder), closed on the Support page or its mailbox removed →
//     the suite finishes the open task, saying why;
//   - a person ticks the task off (or deletes it) while the ticket still waits → that person handled it: the ticket is
//     CLOSED (closed_reason task_done / task_deleted), never a second task for that wait;
//   - the customer writes again after a reply or a close → a new episode → a new task.
// On and silent by default: the task on Today is the reminder (an alert would repeat it).
import { BUSINESS_IDS } from '@suite/shared/crm';
import { localDate } from '@suite/shared/time';
import { markWrote, suiteWrote, suiteFinished, finishTask, dayText } from '../automations/taskBook.js';

export const PULLED_EVENT = 'helpdesk.pulled';
export const CHANGED_EVENT = 'helpdesk.changed';
export const AUTOMATION_ID = 'helpdesk-tickets';
/** New tasks a run (runs follow every read, every few minutes): the rest come with the next runs, oldest first. */
export const TASK_CAP = 25;
const PREFIX = 'ticket:';
/** One task per wait: `ticket:<id>:<episode>`, and `.r<n>` after the n-th reopen on the Support page (review fix). */
export const taskKey = (t) => `${PREFIX}${t.id}:${t.episode}${t.reopen_count ? `.r${t.reopen_count}` : ''}`;
const keyTicketId = (key) => key.slice(PREFIX.length).split(':')[0];

/** A waiting ticket as a task: title, notes (no customer data), due the day it started waiting (the server's day). */
export function ticketItem(t) {
  const day = localDate(new Date(t.waiting_since));
  // Review fix: "wrote again" only when the customer did; a person's reopen says so instead.
  const again = t.wait_reason === 'reopened' ? ': reopened' : t.episode > 1 ? ': the customer wrote again' : '';
  const title = `Answer support email #${t.number} (${t.mailbox_name})${again}`;
  const notes = [
    `A customer wrote to ${t.mailbox_name} on ${dayText(day)}${again === ': reopened' ? ' (reopened on the Support page)' : t.episode > 1 ? ' (again, after an earlier reply)' : ''}.`,
    `Read it, and the order it’s about, on the Support page: /helpdesk/tickets/${t.id}`,
    'The email isn’t copied here: customer emails stay on the Support page.',
    '',
    'Reply from your own mail app. The suite marks the ticket answered when it sees your reply in the Sent folder, and finishes this task. '
      + 'Ticking this task off yourself closes the ticket (no reply needed).',
  ].join('\n');
  return { key: taskKey(t), ticketId: t.id, title, notes, due: day, order: t.waiting_since, businessId: t.business_id ?? BUSINESS_IDS.retail };
}

/** Why a task's ticket no longer waits (for the line the suite adds when it finishes the task). */
export function goneWhy(ticket) {
  if (!ticket) return 'The support mailbox was removed from the suite (or the ticket was deleted)';
  if (ticket.state === 'answered') return `Answered from your mail on ${dayText(localDate(new Date(ticket.last_reply_at)))}`;
  if (ticket.state === 'closed') {
    if (ticket.closed_reason === 'no_reply_needed') return 'Closed on the Support page (no reply needed)';
    return 'The ticket was closed';
  }
  return 'Answered, and the customer wrote again: see the newer task';
}

function openByKey(madeLike, planner) {
  const out = new Map();
  for (const m of madeLike(PREFIX)) {
    const state = planner.taskState(m.id);
    if (!state?.open) continue;
    const list = out.get(m.key) ?? [];
    if (!list.some((x) => x.id === m.id)) list.push({ id: m.id, state });
    out.set(m.key, list);
  }
  return out;
}

/**
 * What to do, from the waiting tickets and what the automation made before — pure over its inputs, so `accept` and
 * `run` decide the same way. → [{ action: create | update | reopen | finish | close, … }]
 */
export function ticketPlan({ waiting, closedByTask = [], ticketById, made, madeLike, planner }) {
  const io = { planner, made };
  const open = openByKey(madeLike, planner);
  const plan = [];
  // Review fix (mistaken ticks): a person reopened the task the suite closed a ticket for → the ticket waits again.
  for (const t of closedByTask) {
    if ((open.get(taskKey(t)) ?? []).length) plan.push({ action: 'unclose', key: taskKey(t), ticketId: t.id, title: `#${t.number}` });
  }
  const items = waiting.map(ticketItem);
  const listed = new Set([...items.map((i) => i.key), ...plan.map((p) => p.key)]);
  for (const item of items) {
    const tasks = open.get(item.key) ?? [];
    if (tasks.length) {
      const { id, state: st } = tasks.at(-1);
      const fields = {};
      if (item.title !== st.title && suiteWrote(io, id, 'title', st.title)) fields.title = item.title;
      if (item.notes !== st.notes && suiteWrote(io, id, 'notes', st.notes)) fields.notes = item.notes;
      if (st.dueDate !== item.due && suiteWrote(io, id, 'due_date', st.dueDate)) fields.due_date = item.due;
      if (Object.keys(fields).length) plan.push({ action: 'update', key: item.key, taskId: id, fields, title: fields.title ?? st.title });
      continue;
    }
    const rows = made(item.key).map((m) => ({ id: m.id, state: planner.taskState(m.id) }));
    if (!rows.length) {
      plan.push({
        action: 'create', key: item.key, order: item.order, title: item.title,
        fields: { owner: 'shared', business_id: item.businessId, title: item.title, notes: item.notes, due_date: item.due },
      });
      continue;
    }
    const mine = rows.filter((r) => suiteFinished(io, r.id, r.state));
    if (mine.length) {
      const { id, state: st } = mine.at(-1);
      plan.push({ action: 'reopen', key: item.key, taskId: id, ownNotes: suiteWrote(io, id, 'notes', st.notes), notes: st.notes, title: st.title });
      continue;
    }
    // A person ticked it off (or deleted it) while the ticket still waits: they dealt with it — close the ticket, at the
    // moment they did it (review fix: an email that came after that is a new wait, not swallowed), by them.
    const last = rows.at(-1);
    const deleted = rows.every((r) => !r.state?.live);
    const closedAt = (deleted ? last.state?.doneAt ?? last.state?.deletedAt : rows.find((r) => r.state?.live && r.state.doneAt)?.state.doneAt) ?? null;
    plan.push({
      action: 'close', key: item.key, ticketId: item.ticketId, reason: deleted ? 'task_deleted' : 'task_done', title: item.title,
      closedAt, by: last.state?.updatedBy ?? null, taskId: deleted ? null : rows.find((r) => r.state?.live)?.id ?? null,
    });
  }
  for (const [key, tasks] of open) {
    if (listed.has(key)) continue;
    plan.push({ action: 'finish', key, taskIds: tasks.map((t) => t.id), why: goneWhy(ticketById(keyTicketId(key))), title: tasks.at(-1).state.title });
  }
  return plan;
}
export const actionable = (plan) => plan.length > 0;

export function registerHelpdeskAutomations({ automations, planner, helpdesk, db }) {
  const closedByTask = db.prepare("SELECT * FROM helpdesk_tickets WHERE state = 'closed' AND closed_reason IN ('task_done', 'task_deleted')");
  const inputs = (made, madeLike) => ({ waiting: helpdesk.waitingTickets(), closedByTask: closedByTask.all(), ticketById: helpdesk.ticketRow, made, madeLike, planner });

  automations.register({
    id: AUTOMATION_ID,
    name: 'Support emails to answer',
    module: 'helpdesk',
    description: 'After each read of the support mailboxes: a task on the shared list for each ticket waiting for a reply (its number and '
      + 'mailbox only — the email stays on the Support page), due the day the customer wrote. Finished when your reply shows up in the '
      + 'Sent folder or the ticket is closed; ticking it off yourself closes the ticket. '
      + `At most ${TASK_CAP} new a run (the longest waiting first).`,
    trigger: {
      type: 'event', events: [PULLED_EVENT, CHANGED_EVENT], key: (d) => d?.key ?? null, label: 'After each read of the support mailboxes',
      accept: () => actionable(ticketPlan(inputs((key) => automations.made(AUTOMATION_ID, key), (p) => automations.madeLike(AUTOMATION_ID, p)))),
    },
    defaults: { enabled: true, alert: false },
    alertLink: '/helpdesk',
    run(_ctx, run) {
      const plan = ticketPlan(inputs(run.made, run.madeLike));
      const io = { planner, made: run.made, madeLike: run.madeLike, remember: run.remember, update: run.update };
      const out = { made: [], finished: 0, reopened: 0, updated: 0, closed: 0, unclosed: 0, rest: 0 };
      for (const p of plan) {
        if (p.action === 'finish') {
          for (const id of p.taskIds) if (finishTask(io, id, p.why, run.now)) out.finished += 1;
        } else if (p.action === 'update') {
          run.update('task', p.taskId, p.fields);
          for (const f of ['title', 'notes', 'due_date']) if (p.fields[f] !== undefined) markWrote(io, p.taskId, f, p.fields[f]);
          out.updated += 1;
        } else if (p.action === 'reopen') {
          const line = `The ticket waits for a reply again — reopened by the suite on ${dayText(run.today)}.`;
          const notes = p.notes ? `${p.notes}\n\n${line}` : line;
          run.update('task', p.taskId, { done_at: null, notes });
          if (p.ownNotes) markWrote(io, p.taskId, 'notes', notes);
          out.reopened += 1;
        } else if (p.action === 'close') {
          const t = helpdesk.closeFromTask(p.ticketId, { closedAt: p.closedAt ?? run.now.toISOString(), by: p.by, reason: p.reason });
          // One line on the task says what that did (a deleted task has no notes to add to).
          if (p.taskId) {
            const st = planner.taskState(p.taskId);
            const line = t?.state === 'waiting'
              ? `Ticket #${t.number} was closed when this was ticked off, but the customer wrote again afterwards: see the newer task.`
              : `Ticket #${t?.number ?? '?'} was closed when this was ticked off (no reply needed). Reopen this task to reopen the ticket.`;
            if (st?.live) run.update('task', p.taskId, { notes: st.notes ? `${st.notes}\n\n${line}` : line });
          }
          out.closed += 1;
        } else if (p.action === 'unclose') {
          helpdesk.uncloseFromTask(p.ticketId);
          out.unclosed += 1;
        }
      }
      // Planned again for the new tasks: closing a ticket above may have started a new wait (an email after the tick).
      const creates = ticketPlan(inputs(run.made, run.madeLike)).filter((p) => p.action === 'create').sort((a, b) => String(a.order).localeCompare(String(b.order)));
      for (const p of creates.slice(0, TASK_CAP)) {
        const id = run.create('task', p.fields, { key: p.key });
        for (const f of ['title', 'notes', 'due_date']) markWrote(io, id, f, p.fields[f]);
        out.made.push(p.title);
      }
      out.rest = Math.max(0, creates.length - TASK_CAP);
      const parts = [
        out.made.length ? `made ${out.made.length} task${out.made.length === 1 ? '' : 's'}` : null,
        out.rest ? `${out.rest} more waiting (made with the next reads)` : null,
        out.reopened ? `reopened ${out.reopened}` : null,
        out.updated ? `brought ${out.updated} up to date` : null,
        out.finished ? `finished ${out.finished}` : null,
        out.closed ? `closed ${out.closed} ticket${out.closed === 1 ? '' : 's'} whose task a person ticked off` : null,
        out.unclosed ? `reopened ${out.unclosed} ticket${out.unclosed === 1 ? '' : 's'} whose task a person reopened` : null,
      ].filter(Boolean);
      const summary = parts.length ? parts.join('; ').replace(/^./, (c) => c.toUpperCase()) : 'Every waiting ticket has its task';
      if (!out.made.length) return { summary };
      return {
        summary,
        alert: { title: `Support: ${out.made.length + out.rest} email${out.made.length + out.rest === 1 ? '' : 's'} to answer`, body: out.made.slice(0, 5).join('\n'), link: '/helpdesk' },
      };
    },
  });
}
