// All tasks (/tasks): filters for whose (Mine / Partner's / Shared / All), our business, client and
// due (overdue / today / this week / no date / done), kept in the URL so Back restores them; 50
// rows at a time; the add/edit sheet with every field (reassigning the owner is the handoff).
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader, Card, Button, EmptyState, Icon, Segmented, SelectField } from '../../ui/index.js';
import { useAuth } from '../../auth/session.jsx';
import { pickableBusinesses } from '../crm/logic.js';
import { usePlannerData } from './data.js';
import { filterTasks, OWNER_FILTERS, DUE_FILTERS } from './logic.js';
import { TaskList, useToday, muted } from './parts.jsx';
import { useFinishedThisSession } from './prefs.js';
import { TaskSheet, newTaskInitial } from './forms.jsx';

const PAGE = 50;
const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });

export default function TasksPage() {
  const { data, loading } = usePlannerData();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const today = useToday();
  const { keep, version } = useFinishedThisSession();
  const [params, setParams] = useSearchParams();
  const owner = params.get('owner') ?? 'all';
  const business = params.get('business') ?? '';
  const client = params.get('client') ?? '';
  const due = params.get('due') ?? 'open';
  const [shown, setShown] = useState(PAGE);
  const [sheet, setSheet] = useState(null);
  useEffect(() => setShown(PAGE), [owner, business, client, due]);

  const setParam = (key, value, fallback = '') => {
    // From the address bar, not this render's params: two quick changes (a tap, then a pick) must
    // not undo each other while the router re-renders.
    const next = new URLSearchParams(window.location.search);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const rows = useMemo(
    () => (data ? filterTasks(data.tasks, { owner, business, client, due }, { me, today, keep }) : []),
    [data, owner, business, client, due, me, today, keep, version],
  );
  // Clients to filter by: those with a task (a long client list would be no use here), plus the chosen one.
  const clientOptions = useMemo(() => {
    if (!data) return [];
    const ids = new Set(data.tasks.map((t) => t.client_id).filter(Boolean));
    if (client) ids.add(client);
    return [...ids].map((id) => data.clientsById.get(id) ?? { id, name: '(deleted client)' }).sort(byName);
  }, [data, client]);
  const businessOptions = useMemo(() => pickableBusinesses(data?.businesses ?? [], business || null), [data, business]);
  const filtered = owner !== 'all' || business || client || due !== 'open';
  const close = () => setSheet(null);

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={data ? `${rows.length} ${due === 'done' ? 'done' : rows.length === 1 ? 'task' : 'tasks'}` : ' '}
        actions={(
          <Button
            variant="primary"
            disabled={!data}
            onClick={() => setSheet({
              initial: newTaskInitial({
                me, businesses: data.businesses, context: business || null, client_id: client || undefined,
                owner: owner === 'shared' ? 'shared' : undefined,
              }),
            })}
          >
            <Icon name="plus" size={18} />New task
          </Button>
        )}
      />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Whose</span>
          <div style={{ overflowX: 'auto' }}>
            <Segmented label="Whose" value={owner} onChange={(v) => setParam('owner', v, 'all')} options={OWNER_FILTERS} />
          </div>
        </div>
        <div className="planner-filters">
          <SelectField
            id="tasks-due"
            label="Due"
            value={due}
            onChange={(v) => setParam('due', v, 'open')}
            options={DUE_FILTERS}
          />
          <SelectField
            id="tasks-business"
            label="Our business"
            value={business}
            onChange={(v) => setParam('business', v)}
            options={[{ value: '', label: 'All our businesses' }, ...businessOptions.map((b) => ({ value: b.id, label: b.name }))]}
          />
          <SelectField
            id="tasks-client"
            label="Client"
            value={client}
            onChange={(v) => setParam('client', v)}
            options={[{ value: '', label: 'Any client' }, ...clientOptions.map((c) => ({ value: c.id, label: c.name }))]}
          />
        </div>
        <Card>
          {!data ? (
            <p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p>
          ) : rows.length ? (
            <TaskList
              tasks={rows.slice(0, shown)}
              testId="task-list"
              me={me}
              today={today}
              businessesById={data.businessesById}
              clientsById={data.clientsById}
              accountsById={data.accountsById}
              onOpen={(task) => setSheet({ record: task })}
            />
          ) : (
            <EmptyState title={filtered ? 'No tasks match' : 'No open tasks'}>
              {filtered
                ? <button type="button" className="crm-link-button" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear the filters</button>
                : 'Add one with New task, or turn something from the inbox into one.'}
            </EmptyState>
          )}
          {rows.length > shown ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: 'var(--space-3)' }}>
              <Button onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</Button>
              <span style={muted} data-testid="tasks-shown">{shown} of {rows.length}</span>
            </div>
          ) : null}
        </Card>
      </div>

      {sheet ? <TaskSheet record={sheet.record} initial={sheet.initial} onClose={close} onDone={close} onDeleted={close} /> : null}
    </>
  );
}
