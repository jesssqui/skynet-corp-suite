// The lead automations (D8), registered by the planner (which hosts the automations that read the CRM
// and make tasks — C8's no-next-step, the Friday review):
//
//   lead-no-next-step   every day at 7:35 — OFF and silent by default, like C8's no-next-step for
//                       relationships: for each open lead with no open dated task naming it
//                       (leadsWithoutNextStep), a task "Set the next step for <lead> (<business>)" due today,
//                       for the lead's owner (else the business's default owner), naming the lead; at most
//                       LEAD_STEP_CAP a run, oldest leads first; never a second while its task is open and
//                       still names the lead. Being dated, that task clears the flag while open (C8's decision).
//   cross-sell          the first workday of each month at 8:05 — ON and silent: the cross-sell list
//                       (crossSellList in @suite/shared/leads: the pairs, the age-restricted rule, consent) as
//                       ONE summary task per business that would sell (its default owner), with the list in its
//                       notes (at most CROSS_SELL_NOTES_MAX lines; the rest on the Cross-sell page) — nothing is
//                       sent; "Make a lead" on the page turns a line into a lead. Once per month and business.
//
// Tasks only (through create = sync.applyLocal as system). See CLAUDE.md, "Leads and the pipeline (D8)".
import { leadsWithoutNextStep, crossSellList } from '@suite/shared/leads';
import { parseLocalDate } from '@suite/shared/time';

export const LEAD_STEP_CAP = 10;
export const CROSS_SELL_NOTES_MAX = 25;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;
const monthText = (ymd) => parseLocalDate(ymd).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });

/** The cross-sell list's lines for one business's task (people and whether that business may email them). */
export function crossSellLines(entries, { max = CROSS_SELL_NOTES_MAX } = {}) {
  const lines = entries.slice(0, max).map((e) => {
    const where = e.account.name !== e.client.name ? `${e.client.name} — ${e.account.name}` : e.client.name;
    const people = e.contacts.length
      ? e.contacts.map((p) => `${p.contact.name}${p.emailConsent ? ' (may email)' : p.contact.email ? ' (no email consent: call or ask)' : ''}`).join(', ')
      : 'no contact on file';
    return `• ${where}: ${e.pair.why} · ${people}`;
  });
  if (entries.length > max) lines.push(`…and ${entries.length - max} more on the Cross-sell page (/crm/cross-sell)`);
  return lines;
}

export function registerLeadAutomations({ automations, crm, planner }) {
  automations.register({
    id: 'lead-no-next-step',
    name: 'Leads with no next step',
    module: 'planner',
    description: 'For each open lead (lead, talking, quoted) with no dated next step, makes a task “Set the next step for …” due today, '
      + `for the lead’s owner. At most ${LEAD_STEP_CAP} a day, oldest leads first. Off until switched on.`,
    trigger: { type: 'schedule', every: 'day', at: '07:35' },
    defaults: { enabled: false, alert: false },
    alertLink: '/crm/pipeline',
    run(_ctx, { today, made, create }) {
      const leads = crm.liveLeads().filter((l) => !crm.getBusiness(l.business_id)?.archived);
      const flagged = leadsWithoutNextStep({ leads, tasks: planner.openLeadTasks() });
      const hasOpen = (l) => made(l.id).some((m) => {
        const st = planner.taskState(m.id);
        return st?.open && st.leadId === l.id;
      });
      const due = flagged.filter((l) => !hasOpen(l))
        .sort((a, b) => String(a.created_at ?? '￿').localeCompare(String(b.created_at ?? '￿')) || (a.id < b.id ? -1 : 1));
      const batch = due.slice(0, LEAD_STEP_CAP);
      const titles = [];
      for (const l of batch) {
        const business = crm.getBusiness(l.business_id);
        const title = `Set the next step for ${l.name}${business ? ` (${business.name})` : ''}`.slice(0, 300);
        create('task', {
          title,
          notes: `Lead: /crm/leads/${l.id}`,
          owner: l.owner ?? planner.automatedOwnerFor(l.business_id),
          business_id: l.business_id,
          client_id: l.client_id ?? null,
          account_id: l.account_id ?? null,
          lead_id: l.id,
          due_date: today,
        }, { key: l.id });
        titles.push(title);
      }
      const rest = due.length - batch.length;
      if (!titles.length) return { summary: flagged.length ? 'Nothing new (their tasks are still open)' : 'Every open lead has a next step' };
      return {
        summary: `Made ${plural(titles.length, 'task')}${rest ? `; ${rest.toLocaleString('en-CA')} more waiting` : ''}`,
        alert: { title: `${plural(titles.length + rest, 'lead')} need a next step`, body: titles.slice(0, 5).join('\n'), link: '/crm/pipeline' },
      };
    },
  });

  automations.register({
    id: 'cross-sell',
    name: 'Monthly cross-sell list',
    module: 'planner',
    description: 'On the first workday of each month, one task per business with the current clients who could use another of its '
      + 'services (a website client with no social media, a consulting client with no website…) in its notes. Age-restricted '
      + 'accounts are never listed for a business that doesn’t already work with them. Nothing is sent.',
    trigger: { type: 'schedule', every: 'month', at: '08:05' },
    defaults: { enabled: true, alert: false },
    alertLink: '/crm/cross-sell',
    run(_ctx, { today, period, made, create }) {
      const month = period?.key ?? today.slice(0, 7);
      const list = crossSellList({ ...crm.crossSellInputs(), today });
      const byBusiness = new Map();
      for (const e of list) {
        const id = e.pair.to.business;
        if (crm.getBusiness(id)?.archived) continue;
        byBusiness.set(id, [...(byBusiness.get(id) ?? []), e]);
      }
      const titles = [];
      for (const [businessId, entries] of byBusiness) {
        const key = `${month}:${businessId}`;
        if (made(key).length) continue; // once per month and business (Run now again changes nothing)
        const business = crm.getBusiness(businessId);
        const title = `Cross-sell for ${monthText(`${month}-01`)}: ${plural(entries.length, 'client')} for ${business?.name ?? 'us'}`;
        create('task', {
          title: title.slice(0, 300),
          notes: [
            `Current clients who could use more from ${business?.name ?? 'us'} (as of ${today}):`,
            ...crossSellLines(entries),
            '',
            'Nothing has been sent. Make a lead from the Cross-sell page (/crm/cross-sell → Make a lead) for the ones worth a call;',
            'email only those marked “may email” — the others: call, or ask in person.',
          ].join('\n'),
          owner: planner.automatedOwnerFor(businessId),
          business_id: businessId,
          due_date: today,
        }, { key });
        titles.push(title);
      }
      if (!titles.length) return { summary: list.length ? 'This month’s lists are made already' : 'No one to cross-sell to this month' };
      return { summary: `Made ${plural(titles.length, 'list')}`, alert: { title: titles[0], body: titles.join('\n'), link: '/crm/cross-sell' } };
    },
  });
}
