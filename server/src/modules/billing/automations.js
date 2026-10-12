// The quote follow-up (D17): when a quote is sent, a task "Follow up on quote GWND-Q-0007 for …" due 7 days later, for
// the business's default owner, naming the quote's lead (so it is the lead's dated next step), client, account and
// relationship. Finished by the suite ("Quote … accepted on …" / "declined" / "deleted") when the quote is decided on a
// device — events after a device's push (billing.changed) and after each send (billing.quote_sent). Who finished it
// decides: one key per quote (`quote:<id>`), so a task a person finished or deleted is never made again; the suite only
// finishes open ones. Tasks only — nothing is ever sent. On and silent by default.
import { QUOTE_FOLLOW_UP_DAYS, moneyText } from '@suite/shared/billing';
import { addDays } from '@suite/shared/planner';
import { dayText, finishTask } from '../automations/taskBook.js';

export const FOLLOW_UP_ID = 'quote-follow-up';
const keyOf = (quoteId) => `quote:${quoteId}`;

/**
 * What the follow-up automation would do now: { create: [quote], finish: [{ taskId, why }] }. `made(key)` /
 * `madeLike(prefix)` = what it made before; `taskState(id)` the planner's.
 */
export function followUpPlan({ billing, made, madeLike, taskState }) {
  const create = billing.sentQuotes().filter((quote) => !made(keyOf(quote.id)).length);
  const finish = [];
  for (const m of madeLike('quote:')) {
    if (m.entity !== 'task') continue;
    const st = taskState(m.id);
    if (!st?.open) continue;
    const quote = billing.quoteRow(m.key.slice('quote:'.length));
    if (quote && !quote.deleted_at && quote.status === 'sent') continue;
    const why = !quote || quote.deleted_at ? 'The quote was deleted'
      : quote.status === 'accepted' ? `Quote ${quote.number} was accepted${quote.decided_on ? ` on ${dayText(quote.decided_on)}` : ''}`
        : quote.status === 'declined' ? `Quote ${quote.number} was declined${quote.decided_on ? ` on ${dayText(quote.decided_on)}` : ''}`
          : null;
    if (why) finish.push({ taskId: m.id, why });
  }
  return { create, finish };
}

export function registerBillingAutomations({ automations, planner, crm, billing }) {
  automations.register({
    id: FOLLOW_UP_ID,
    name: 'Follow up on sent quotes',
    module: 'billing',
    description: `When a quote is sent, makes a task to follow up ${QUOTE_FOLLOW_UP_DAYS} days later, for the lead’s owner (else the business’s `
      + 'default owner; with the lead, so it is the lead’s next step). The task finishes itself when the quote is accepted or declined. Nothing is sent.',
    trigger: {
      type: 'event',
      events: ['billing.quote_sent', 'billing.changed'],
      key: (data) => data.key,
      label: 'When a quote is sent, accepted or declined',
      accept: () => {
        const p = followUpPlan({
          billing, made: (k) => automations.made(FOLLOW_UP_ID, k), madeLike: (pre) => automations.madeLike(FOLLOW_UP_ID, pre), taskState: planner.taskState,
        });
        return p.create.length > 0 || p.finish.length > 0;
      },
    },
    defaults: { enabled: true, alert: false },
    alertLink: '/costs/billing',
    run(_ctx, io) {
      const { now, today, made, madeLike, create } = io;
      const plan = followUpPlan({ billing, made, madeLike, taskState: planner.taskState });
      let made_ = 0;
      for (const quote of plan.create) {
        const who = quote.to_name || 'them';
        const lead = quote.lead_id ? crm.liveRecord('lead', quote.lead_id) : null;
        create('task', {
          title: `Follow up on quote ${quote.number} for ${who}`.slice(0, 300),
          notes: [
            `Sent on ${dayText(quote.sent_on)}: ${moneyText(quote.total_cents ?? 0)}${quote.title ? ` — ${quote.title}` : ''}.`,
            'Ask whether they have questions or want to go ahead. When they answer, mark the quote Accepted or Declined — this task then finishes itself.',
            `Quote: /costs/billing/quotes/${quote.id}`,
          ].join('\n'),
          // Review fix: the lead's owner when it has one (whoever is working the lead), else the business's default owner.
          owner: (lead && lead.owner) || planner.automatedOwnerFor(quote.business_id),
          business_id: quote.business_id,
          client_id: quote.client_id ?? null,
          account_id: quote.account_id ?? null,
          relationship_id: quote.relationship_id ?? null,
          lead_id: lead ? lead.id : null,
          // Review fix: never already overdue (a quote re-adopted or restored from the archive after a restore).
          due_date: [addDays(quote.sent_on, QUOTE_FOLLOW_UP_DAYS), today].sort()[1],
        }, { key: keyOf(quote.id) });
        made_ += 1;
      }
      let finished = 0;
      for (const f of plan.finish) if (finishTask({ ...io, planner }, f.taskId, f.why, now)) finished += 1;
      const parts = [];
      if (made_) parts.push(`Made ${made_} follow-up task${made_ === 1 ? '' : 's'}`);
      if (finished) parts.push(`finished ${finished}`);
      return { summary: parts.join('; ') || 'Nothing to do' };
    },
  });
}
