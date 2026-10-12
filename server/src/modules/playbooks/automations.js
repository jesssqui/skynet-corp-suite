// A repeating run's later months (D9): a retainer run is started on a device, which makes its first
// month's tasks at once (offline); every later month is made here, on the server, by the daily automation
// `playbook-months` — a phone can't run anything on a schedule, and the server is always on.
//
// Once per run and month: the key `<run id>:<YYYY-MM>` (automations_made) is remembered in the same
// transaction as the month's tasks, so the scheduler again, Run now and restarts never make a month
// twice. A month is made from MONTH_LEAD_DAYS before it starts until it is over; a month that went by
// entirely (the server off) isn't made late, and none starting after the run's end date. Each month's
// tasks come from the run's OWN copy of the steps (run_step), never the playbook: editing the playbook
// changes only future runs. A stopped or done run, a closed or deleted client and an archived business
// get no new months. The offer condition (D8's cross-sell rule) is checked again each month.
import { dueCycles, stepOwner, stepTaskFields, offerSkipReason, actionOf } from '@suite/shared/playbooks';

export const MONTHS_ID = 'playbook-months';

/**
 * What to make today (pure over reads): [{ run, cycle, key, tasks: [fields], skipped: [{ step, why }] }]
 * and what was left out ([{ run, why }]).
 */
export function monthsPlan({ runs, today, made, readsFor }) {
  const out = [];
  const held = [];
  for (const run of runs) {
    const due = dueCycles(run, today).filter((c) => !made(`${run.id}:${c.key}`).length);
    if (!due.length) continue;
    const ctx = readsFor(run);
    if (ctx.why) {
      held.push({ run, why: ctx.why });
      continue;
    }
    for (const cycle of due) {
      const tasks = [];
      const skipped = [];
      for (const step of ctx.steps) {
        if (actionOf(step) !== 'task') continue; // renewal dates are set once, when the run starts
        const why = offerSkipReason(step, { account: ctx.account, relationships: ctx.relationships, businessName: ctx.businessName });
        if (why) {
          skipped.push({ step, why });
          continue;
        }
        const owner = stepOwner(step, { runner: run.runner, business: ctx.business, override: run.owner });
        tasks.push(stepTaskFields({ step, run: ctx.run, owner, cycle, playbookName: ctx.playbookName }));
      }
      out.push({ run, cycle, key: `${run.id}:${cycle.key}`, tasks, skipped });
    }
  }
  return { months: out, held };
}

export function registerPlaybookAutomations({ automations, crm, reads }) {
  const businessName = (id) => crm.getBusiness(id)?.name ?? 'that business';
  /** What a run needs to make a month — or why it can't now. */
  function readsFor(run) {
    const business = crm.getBusiness(run.business_id);
    if (!business) return { why: 'its business is gone' };
    if (business.archived) return { why: `${business.name} is archived` };
    let account = null;
    if (run.client_id) {
      const client = crm.liveRecord('client', run.client_id);
      if (!client) return { why: 'its client was deleted' };
      if (client.status === 'closed') return { why: 'its client is closed' };
      account = run.account_id ? crm.liveAccount(run.account_id) : null;
    }
    const relationship = run.relationship_id ? crm.liveRecord('relationship', run.relationship_id) : null;
    const playbook = run.playbook_id ? reads.playbook(run.playbook_id) : null;
    return {
      business,
      account,
      relationships: account ? crm.accountRelationships(account.id) : [],
      businessName,
      playbookName: playbook?.name ?? null,
      // Refs that went away read as none (a deleted account or relationship isn't put on new tasks).
      run: { ...run, account_id: account ? run.account_id : null, relationship_id: relationship && account ? run.relationship_id : null },
      steps: reads.runSteps(run.id),
    };
  }

  automations.register({
    id: MONTHS_ID,
    name: 'Repeating playbooks (retainers)',
    module: 'playbooks',
    description: 'Makes each month’s tasks for a playbook run that repeats every month (a content retainer), a week before the month starts, '
      + 'from the steps the run started with. Once per run and month; the first month is made when the run is started. Nothing for a run '
      + 'that is done or stopped, a closed client or an archived business.',
    trigger: { type: 'schedule', every: 'day', at: '07:20' },
    defaults: { enabled: true, alert: false },
    alertLink: '/playbooks',
    run(_ctx, { today, made, create, remember }) {
      const { months, held } = monthsPlan({ runs: reads.repeatingRuns(), today, made, readsFor });
      let made_ = 0;
      for (const m of months) {
        for (const fields of m.tasks) {
          create('task', fields);
          made_ += 1;
        }
        remember(m.key, 'playbook_run', m.run.id);
      }
      const parts = [];
      if (months.length) parts.push(`Made ${made_} task${made_ === 1 ? '' : 's'} for ${months.map((m) => `${m.run.name} (${m.cycle.label})`).join(', ')}`);
      const skippedOffers = months.reduce((n, m) => n + m.skipped.length, 0);
      if (skippedOffers) parts.push(`${skippedOffers} offer${skippedOffers === 1 ? '' : 's'} left out (they already have it)`);
      if (held.length) parts.push(`waiting: ${held.map((h) => `${h.run.name} — ${h.why}`).join('; ')}`);
      return {
        summary: parts.length ? parts.join('; ') : 'Nothing to do',
        alert: months.length ? { title: `Retainer tasks for ${months.map((m) => m.cycle.label).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`, body: parts[0] } : undefined,
      };
    },
  });
}
