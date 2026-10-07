// The Friday review (/plan/review): a checklist for the two people to go through together, built
// from what the suite already has — overdue tasks (both people), services renewing in the next 30
// days, active clients quiet for 60 days, this week's goals (marked done in one tap), tasks to
// hand to the other person (one tap), and relationships with no next step. "Duplicate matches"
// (D2) and "this week's order entry" (the wholesale connection) aren't connected yet and say so.
// Each step can be ticked as reviewed (kept on this device, per week).
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, Button, Icon, Segmented, Badge } from '../../ui/index.js';
import { formatDate } from '../../ui/format.js';
import { store } from '../../sync/index.js';
import { useAuth } from '../../auth/session.jsx';
import { BusinessChip, TextButton, useAction } from '../crm/parts.jsx';
import { KIND_LABELS, billingSummary } from '../crm/logic.js';
import { useReviewData } from './data.js';
import { otherActor, ownerLabel } from './logic.js';
import { reviewLists, handoffTasks, weekLabel, weekStart, goalOwner, goalProgress, RENEWAL_DAYS, QUIET_DAYS } from './plan.js';
import { PagedTaskList, ShowMore, PAGE, OwnerBadge, useToday, muted } from './parts.jsx';
import { useFinishedThisSession, getReviewChecks, setReviewCheck } from './prefs.js';
import { TaskSheet, newTaskInitial } from './forms.jsx';
import { GoalTick } from './goals.jsx';
import { PlanTabs } from './planParts.jsx';

const STEPS = ['overdue', 'renewals', 'quiet', 'goals', 'handoff', 'next-step', 'duplicates', 'orders'];

/** One step of the review: heading, count, a "reviewed" tick, and its list. */
function Step({ id, title, count, checked, onCheck, children, hint }) {
  return (
    <Card>
      <section data-review-step={id} aria-label={title}>
        <div className="planner-review-head">
          <label className="planner-review-check">
            <input type="checkbox" checked={checked} onChange={(e) => onCheck(id, e.target.checked)} aria-label={`Reviewed: ${title}`} />
            <span style={{ fontWeight: 650, textDecoration: checked ? 'line-through' : 'none' }}>{title}</span>
          </label>
          {count !== null ? <span style={muted} data-testid={`review-${id}-count`}>{count}</span> : null}
        </div>
        {hint ? <p style={{ ...muted, margin: '0 0 var(--space-2)' }}>{hint}</p> : null}
        {children}
      </section>
    </Card>
  );
}

function Paged({ rows, render, testId, empty }) {
  const [shown, setShown] = useState(10);
  if (!rows.length) return <p style={{ ...muted, margin: 0 }}>{empty}</p>;
  return (
    <>
      <ul className="planner-review-list" data-testid={testId}>{rows.slice(0, shown).map(render)}</ul>
      <ShowMore shown={shown} total={rows.length} onMore={() => setShown((n) => n + PAGE)} />
    </>
  );
}

export default function ReviewPage() {
  const { data, loading } = useReviewData();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const today = useToday();
  const monday = weekStart(today);
  const { keep, version } = useFinishedThisSession();
  const [checks, setChecks] = useState(() => getReviewChecks(monday));
  const [who, setWho] = useState(me);
  const [sheet, setSheet] = useState(null);
  const { busy, error, run } = useAction();

  const lists = useMemo(() => (data ? reviewLists({
    tasks: data.tasks, today, goals: data.goals, services: data.services, clients: data.clients, accounts: data.accounts,
    relationships: data.relationships, lastActivity: data.lastActivity, businesses: data.businesses,
  }) : null), [data, today]);
  // Tasks ticked or handed over this session stay where they were (with undo) until the page reloads.
  const handoff = useMemo(() => (data ? handoffTasks(data.tasks, { who, today }) : []), [data, who, today]);
  const [handed, setHanded] = useState(() => new Map()); // id -> previous owner
  const handoffRows = useMemo(() => {
    if (!data) return [];
    const extra = [...handed.keys()].map((id) => data.tasks.find((t) => t.id === id)).filter((t) => t && !handoff.includes(t) && handed.get(t.id) === who);
    return [...handoff, ...extra];
  }, [data, handoff, handed, who]);
  const overdue = useMemo(() => (data ? [...lists.overdue, ...data.tasks.filter((t) => keep.has(t.id) && t.done_at && t.due_date && t.due_date < today)] : []), [data, lists, keep, version, today]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = (id, on) => {
    setReviewCheck(monday, id, on);
    setChecks(getReviewChecks(monday));
  };
  const close = () => setSheet(null);
  const rowProps = {
    me, today, businessesById: data?.businessesById, clientsById: data?.clientsById, accountsById: data?.accountsById, goalsById: data?.goalsById,
    onOpen: (task) => setSheet({ kind: 'task', record: task }),
  };
  const other = otherActor(who);
  const handTo = (task) => run(async () => {
    const prev = task.owner;
    await store.update('task', task.id, { owner: other });
    setHanded((m) => new Map(m).set(task.id, prev));
  });
  const handBack = (task) => run(async () => {
    await store.update('task', task.id, { owner: handed.get(task.id) });
    setHanded((m) => {
      const next = new Map(m);
      next.delete(task.id);
      return next;
    });
  });
  const relLine = (svc) => {
    const rel = data.relationshipsById.get(svc.relationship_id);
    const account = rel ? data.accountsById.get(rel.account_id) : null;
    const client = account ? data.clientsById.get(account.client_id) : null;
    return { rel, account, client };
  };
  const checkedCount = STEPS.filter((s) => checks.has(s)).length;

  return (
    <>
      <PageHeader title="Friday review" subtitle={`Week of ${weekLabel(monday)} · ${checkedCount} of ${STEPS.length} reviewed`} />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <PlanTabs />
        {!data ? (
          <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>
        ) : (
          <div className="planner-review-grid" data-testid="review">
            <Step id="overdue" title="Clear anything overdue" count={lists.overdue.length} checked={checks.has('overdue')} onCheck={check} hint="Both people’s and the shared list’s. Tick what’s done, open one to move it or hand it over.">
              {overdue.length ? <PagedTaskList tasks={overdue} testId="review-overdue" {...rowProps} /> : <p style={{ ...muted, margin: 0 }}>Nothing overdue.</p>}
            </Step>

            <Step id="goals" title="This week’s goals" count={lists.weekGoals.length} checked={checks.has('goals')} onCheck={check} hint="Which were hit? Tick a goal to mark it done.">
              <Paged
                rows={lists.weekGoals}
                testId="review-goals"
                empty={<>No goals this week. <Link to="/plan/week">Set them on the Monday plan</Link>.</>}
                render={(g) => {
                  const p = goalProgress(g);
                  return (
                    <li key={g.id} className={`planner-goal${g.done_at ? ' done' : ''}`} data-goal-id={g.id}>
                      <GoalTick goal={g} />
                      <span style={{ display: 'grid', gap: 2, minWidth: 0, alignSelf: 'center' }}>
                        <span className="planner-goal-title-text" style={{ fontWeight: 600 }}>{g.title}</span>
                        <span style={{ ...muted, display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                          <BusinessChip business={data.businessesById.get(g.business_id)} short />
                          <OwnerBadge owner={goalOwner(g)} me={me} />
                          {p.label ? <span>{p.label}</span> : null}
                          <span data-testid="goal-state">{g.done_at ? 'Done' : 'Not done'}</span>
                        </span>
                      </span>
                    </li>
                  );
                }}
              />
            </Step>

            <Step id="renewals" title={`Renewals in the next ${RENEWAL_DAYS} days`} count={lists.renewals.length} checked={checks.has('renewals')} onCheck={check}>
              <Paged
                rows={lists.renewals}
                testId="review-renewals"
                empty="No services renew in the next 30 days."
                render={(svc) => {
                  const { rel, account, client } = relLine(svc);
                  return (
                    <li key={svc.id} data-service-id={svc.id} className="planner-review-row">
                      <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{svc.name}</span>
                        <span style={{ ...muted, display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                          {rel ? <BusinessChip business={data.businessesById.get(rel.business_id)} short /> : null}
                          {client ? <Link to={`/crm/clients/${client.id}`}>{client.name}{account ? ` · ${account.name}` : ''}</Link> : null}
                          {billingSummary(svc) ? <span>{billingSummary(svc)}</span> : null}
                        </span>
                      </span>
                      <Badge tone={svc.renewal_date <= today ? 'warn' : 'neutral'}>Renews {formatDate(svc.renewal_date)}</Badge>
                    </li>
                  );
                }}
              />
            </Step>

            <Step id="quiet" title={`Clients quiet for ${QUIET_DAYS} days`} count={lists.quiet.length} checked={checks.has('quiet')} onCheck={check} hint="Active clients with no note, call or order for two months.">
              <Paged
                rows={lists.quiet}
                testId="review-quiet"
                empty="Every active client has been in touch in the last 60 days."
                render={({ client, last }) => (
                  <li key={client.id} data-client-id={client.id} className="planner-review-row">
                    <Link to={`/crm/clients/${client.id}`} style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{client.name}</Link>
                    <span style={muted}>{last ? `Last: ${formatDate(last.slice(0, 10))}` : 'No activity yet'}</span>
                  </li>
                )}
              />
            </Step>

            <Step id="handoff" title="Hand work to the other person" count={handoff.length} checked={checks.has('handoff')} onCheck={check} hint="Open tasks due by the end of next week, or with no day. One tap hands one over.">
              <div style={{ marginBottom: 'var(--space-2)' }}>
                <Segmented label="Whose tasks" value={who} onChange={setWho} options={[{ value: me, label: 'Yours' }, { value: otherActor(me), label: 'Partner’s' }]} />
              </div>
              {handoffRows.length ? (
                <PagedTaskList
                  tasks={handoffRows}
                  testId="review-handoff"
                  {...rowProps}
                  actions={(task) => (handed.has(task.id) ? (
                    <>
                      <span style={muted}>Handed to {ownerLabel(task.owner, me) === 'You' ? 'you' : 'your partner'}</span>
                      <Button variant="ghost" disabled={busy} onClick={() => handBack(task)}>Undo</Button>
                    </>
                  ) : (
                    <Button disabled={busy} onClick={() => handTo(task)} aria-label={`${other === me ? 'Take' : 'Give to partner'}: ${task.title}`}>
                      <Icon name="arrowRight" size={16} />{other === me ? 'Take it' : 'Give to partner'}
                    </Button>
                  ))}
                />
              ) : <p style={{ ...muted, margin: 0 }}>Nothing open for the next week and a half.</p>}
              {error ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p> : null}
            </Step>

            <Step id="next-step" title="Relationships with no next step" count={lists.noNextStep.length} checked={checks.has('next-step')} onCheck={check}>
              <Paged
                rows={lists.noNextStep}
                testId="review-no-next-step"
                empty="Every active relationship has a dated next step."
                render={(r) => {
                  const account = data.accountsById.get(r.account_id);
                  const client = data.clientsById.get(account?.client_id);
                  return (
                    <li key={r.id} data-relationship-id={r.id} className="planner-review-row">
                      <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                        <Link to={`/crm/clients/${client?.id}`} style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{client?.name}</Link>
                        <span style={{ ...muted, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <BusinessChip business={data.businessesById.get(r.business_id)} short />
                          <span>{account?.name} · {KIND_LABELS[r.kind] ?? r.kind}</span>
                        </span>
                      </span>
                      <TextButton
                        onClick={() => setSheet({
                          kind: 'task',
                          title: 'Next step',
                          initial: newTaskInitial({ me, businesses: data.businesses, context: r.business_id, client_id: account?.client_id, account_id: r.account_id, relationship_id: r.id }),
                        })}
                        aria-label={`Add a next step for ${account?.name}`}
                      >
                        <Icon name="plus" size={14} />Next step
                      </TextButton>
                    </li>
                  );
                }}
              />
            </Step>

            <Step id="duplicates" title="Duplicate matches" count={null} checked={checks.has('duplicates')} onCheck={check}>
              <p style={{ ...muted, margin: 0 }} data-testid="review-not-connected">Not connected yet: matching Order Manager customers to clients comes later.</p>
            </Step>
            <Step id="orders" title="This week’s order entry" count={null} checked={checks.has('orders')} onCheck={check}>
              <p style={{ ...muted, margin: 0 }} data-testid="review-not-connected">Not connected yet: the Wholesale Order Manager’s orders arrive with its connection.</p>
            </Step>
          </div>
        )}
      </div>
      {sheet?.kind === 'task' ? <TaskSheet record={sheet.record} initial={sheet.initial} title={sheet.title} onClose={close} onDone={close} onDeleted={close} /> : null}
    </>
  );
}
