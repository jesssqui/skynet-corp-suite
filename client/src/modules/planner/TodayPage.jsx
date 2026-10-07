// Today (/): the signed-in person's day from the device's offline copy — overdue first, then due
// today (timed ones in time order), then the rest of today's top 3; their own tasks and the shared
// list (marked), never the other person's own. Tick to finish (undo stays possible this session),
// "Plan my day" for the morning plan, the capture field (fixed above the tab bar on phones), the
// inbox count and the relationships without a next step.
// Today's calendar (Apple Calendar meetings) is a later package: nothing is shown for it yet.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, Button, EmptyState, Icon } from '../../ui/index.js';
import { formatDate } from '../../ui/format.js';
import { useAuth } from '../../auth/session.jsx';
import { BusinessChip, TextButton } from '../crm/parts.jsx';
import { KIND_LABELS } from '../crm/logic.js';
import { usePlannerData } from './data.js';
import { buildToday, openInbox, relationshipsWithoutNextStep, TOP_LIMIT } from './logic.js';
import { PagedTaskList, ShowMore, PAGE, CaptureBar, CaptureSpacer, useToday, muted } from './parts.jsx';
import { useFinishedThisSession } from './prefs.js';
import { TaskSheet, newTaskInitial } from './forms.jsx';
import PlanSheet from './PlanSheet.jsx';

const SHOWN_FLAGS = 5;

function Section({ title, tone, count, children, testId }) {
  return (
    <Card>
      <div className="planner-section-head">
        <h2 style={tone === 'danger' ? { color: 'var(--danger)' } : undefined}>{title}</h2>
        <span style={muted} data-testid={testId ? `${testId}-count` : undefined}>{count}</span>
      </div>
      {children}
    </Card>
  );
}

function NoNextStep({ flagged, data, onAdd }) {
  const [shown, setShown] = useState(SHOWN_FLAGS); // 5, then 50 more at a time (thousands at scale)
  const rows = flagged.slice(0, shown);
  return (
    <Card>
      <div className="planner-section-head">
        <h2>No next step</h2>
        <span style={muted} data-testid="no-next-step-count">{flagged.length}</span>
      </div>
      <p style={{ ...muted, margin: '0 0 var(--space-2)' }} data-testid="no-next-step-summary">
        {flagged.length === 1 ? '1 active relationship has' : `${flagged.length} active relationships have`} no dated next step.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="no-next-step">
        {rows.map((r) => {
          const account = data.accountsById.get(r.account_id);
          const client = data.clientsById.get(account?.client_id);
          return (
            <li key={r.id} data-relationship-id={r.id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--border)', padding: 'var(--space-1) 0' }}>
              <span style={{ display: 'grid', gap: 2, minWidth: 0, flex: '1 1 180px' }}>
                <Link to={`/crm/clients/${client?.id}`} style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{client?.name}</Link>
                <span style={{ ...muted, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <BusinessChip business={data.businessesById.get(r.business_id)} short />
                  <span>{account?.name} · {KIND_LABELS[r.kind] ?? r.kind}</span>
                </span>
              </span>
              <TextButton onClick={() => onAdd(r, account)} aria-label={`Add a next step for ${account?.name}`}><Icon name="plus" size={14} />Next step</TextButton>
            </li>
          );
        })}
      </ul>
      <ShowMore shown={shown} total={flagged.length} onMore={() => setShown((n) => n + PAGE)} testId="no-next-step-more" />
    </Card>
  );
}

export default function TodayPage() {
  const { data, loading } = usePlannerData();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const today = useToday();
  const { keep, version } = useFinishedThisSession();
  const [sheet, setSheet] = useState(null);

  const view = useMemo(() => (data ? buildToday({ tasks: data.tasks, me, today, keep }) : null), [data, me, today, keep, version]);
  const flagged = useMemo(() => {
    if (!data) return [];
    const rows = relationshipsWithoutNextStep(data);
    const name = (r) => data.clientsById.get(data.accountsById.get(r.account_id)?.client_id)?.name ?? '';
    return rows.sort((a, b) => name(a).localeCompare(name(b)) || (a.id < b.id ? -1 : 1));
  }, [data]);
  const inboxCount = useMemo(() => (data ? openInbox(data.inbox).length : 0), [data]);

  const rowProps = {
    me, today, businessesById: data?.businessesById, clientsById: data?.clientsById, accountsById: data?.accountsById,
    onOpen: (task) => setSheet({ kind: 'task', record: task }),
  };
  const close = () => setSheet(null);
  const addTask = () => setSheet({ kind: 'task', initial: newTaskInitial({ me, businesses: data?.businesses ?? [] }) });
  const addNextStep = (rel, account) => setSheet({
    kind: 'task',
    title: 'Next step',
    initial: newTaskInitial({
      me, businesses: data.businesses, context: rel.business_id, client_id: account?.client_id, account_id: rel.account_id, relationship_id: rel.id,
    }),
  });

  return (
    <>
      <PageHeader
        title="Today"
        subtitle={formatDate(today, { weekday: true })}
        actions={(
          <>
            <Button variant="primary" onClick={() => setSheet({ kind: 'plan' })} disabled={!data}><Icon name="star" size={18} />Plan my day</Button>
            <Button onClick={addTask} disabled={!data}><Icon name="plus" size={18} />Task</Button>
          </>
        )}
      />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <CaptureBar inboxCount={inboxCount} />
        {!data ? (
          <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>
        ) : (
          <div className="planner-today">
            <div className="planner-col" data-testid="today-tasks">
              {view.overdue.length ? (
                <Section title="Overdue" tone="danger" count={view.overdue.length} testId="overdue">
                  <PagedTaskList tasks={view.overdue} testId="overdue" {...rowProps} />
                </Section>
              ) : null}
              {view.dueToday.length ? (
                <Section title="Due today" count={view.dueToday.length} testId="due-today">
                  <PagedTaskList tasks={view.dueToday} testId="due-today" {...rowProps} />
                </Section>
              ) : null}
              {view.picked.length ? (
                <Section title="Also in today’s top 3" count={view.picked.length} testId="picked">
                  <PagedTaskList tasks={view.picked} testId="picked" {...rowProps} />
                </Section>
              ) : null}
              {!view.total ? (
                <Card>
                  <EmptyState title="Nothing due today">
                    Plan my day picks up to three tasks to focus on; anything captured waits in the inbox.
                  </EmptyState>
                </Card>
              ) : null}
            </div>
            <div className="planner-col">
              <Card>
                <Link to="/inbox" className="planner-link-row" data-testid="today-inbox">
                  <Icon name="inbox" size={20} />
                  {inboxCount ? `${inboxCount} in the inbox to sort` : 'Inbox is clear'}
                  <Icon name="chevron" size={16} />
                </Link>
                <div style={{ ...muted, display: 'flex', gap: 'var(--space-2)', alignItems: 'center', minHeight: 'var(--tap)' }}>
                  <Icon name="star" size={18} style={{ color: 'var(--warn)' }} />
                  <span data-testid="today-top">Top 3: {view.topCount} of {TOP_LIMIT} picked</span>
                  <TextButton style={{ marginLeft: 'auto' }} onClick={() => setSheet({ kind: 'plan' })}>Plan</TextButton>
                </div>
                <Link to="/tasks" className="planner-link-row">
                  <Icon name="tasks" size={20} /> All tasks <Icon name="chevron" size={16} />
                </Link>
              </Card>
              {flagged.length ? <NoNextStep flagged={flagged} data={data} onAdd={addNextStep} /> : null}
            </div>
          </div>
        )}
      </div>
      <CaptureSpacer />

      {sheet?.kind === 'plan' ? <PlanSheet data={data} me={me} today={today} inboxCount={inboxCount} onClose={close} /> : null}
      {sheet?.kind === 'task' ? (
        <TaskSheet record={sheet.record} initial={sheet.initial} title={sheet.title} onClose={close} onDone={close} onDeleted={close} />
      ) : null}
    </>
  );
}
