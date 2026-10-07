// The client page's Tasks card (C4a): this client's open tasks (both people's and the shared
// list), overdue first, with ticks; "Add task" pre-filled with the client and the timeline's
// business/account filter. Also the "No next step · Add" line on a relationship row.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Icon } from '../../ui/index.js';
import { useAuth } from '../../auth/session.jsx';
import { TextButton } from '../crm/parts.jsx';
import { compareDue, isOpenTask } from './logic.js';
import { TaskList, useToday, muted, PAGE } from './parts.jsx';
import { useFinishedThisSession } from './prefs.js';
import { TaskSheet, newTaskInitial } from './forms.jsx';

const SHOWN = 10;

const h2 = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' };

/**
 * @param {{ client, tasks, businesses, businessesById, accountsById, filter: { business, account } }} props
 *   tasks: the tasks naming this client (open and done); filter: the timeline's ('all' or an id)
 */
export function ClientTasksCard({ client, tasks, businesses, businessesById, accountsById, filter }) {
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const today = useToday();
  const { keep, version } = useFinishedThisSession();
  const [sheet, setSheet] = useState(null);
  const [shown, setShown] = useState(SHOWN); // 10, then 50 more at a time
  const open = useMemo(
    () => tasks.filter((t) => isOpenTask(t) || keep.has(t.id)).sort(compareDue),
    [tasks, keep, version],
  );
  const doneCount = tasks.filter((t) => !isOpenTask(t)).length;
  const clientsById = useMemo(() => new Map([[client.id, client]]), [client]);
  const close = () => setSheet(null);
  const add = () => setSheet({
    initial: newTaskInitial({
      me,
      businesses,
      context: filter.business !== 'all' ? filter.business : null,
      client_id: client.id,
      account_id: filter.account !== 'all' ? filter.account : undefined,
    }),
  });
  const rows = open.slice(0, shown);
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
        <h2 style={h2}>Tasks</h2>
        <TextButton onClick={add}><Icon name="plus" size={14} />Add task</TextButton>
      </div>
      {open.length ? (
        <TaskList
          tasks={rows}
          testId="client-tasks"
          me={me}
          today={today}
          businessesById={businessesById}
          clientsById={clientsById}
          accountsById={accountsById}
          showClient={false}
          onOpen={(task) => setSheet({ record: task })}
        />
      ) : <p style={{ ...muted, margin: 0 }}>No open tasks for this client.</p>}
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
        {open.length > shown ? <TextButton style={{ paddingLeft: 0 }} onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, open.length - shown)} more ({shown} of {open.length})</TextButton> : null}
        {doneCount ? <Link to={`/tasks?client=${client.id}&due=done`} style={{ ...muted, minHeight: 'var(--tap)', display: 'inline-flex', alignItems: 'center' }}>{doneCount} done</Link> : null}
      </div>
      {sheet ? <TaskSheet record={sheet.record} initial={sheet.initial} onClose={close} onDone={close} onDeleted={close} /> : null}
    </Card>
  );
}

/**
 * "No next step · Add" under an active relationship with no open, dated task for it: Add opens a
 * task sheet for the relationship (its account, the client and its business pre-filled).
 */
export function NoNextStepLine({ rel, clientId, businesses }) {
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }} data-testid="no-next-step-flag">
      <span style={{ color: 'var(--warn)', fontSize: 'var(--text-sm)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Icon name="alert" size={14} />No next step
      </span>
      <TextButton onClick={() => setOpen(true)} aria-label="Add a next step for this relationship">Add</TextButton>
      {open ? (
        <TaskSheet
          title="Next step"
          initial={newTaskInitial({ me, businesses, context: rel.business_id, client_id: clientId, account_id: rel.account_id, relationship_id: rel.id })}
          onClose={() => setOpen(false)}
          onDone={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
