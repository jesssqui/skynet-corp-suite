// The capture inbox (/inbox): anything captured (here, on Today, later by Siri or the share
// sheet), newest first, to sort into a task (two taps: Task, then Save on the pre-filled sheet), a
// note on a client, or nothing (Dismiss, with Undo). Everything is saved on the device first, so it
// works offline.
import { useMemo, useState } from 'react';
import { PageHeader, Card, Button, EmptyState, Icon, Notice } from '../../ui/index.js';
import { formatDateTime, nowIso } from '../../ui/format.js';
import { useAuth } from '../../auth/session.jsx';
import { store } from '../../sync/index.js';
import { SyncBadges } from '../../sync/components.jsx';
import { actorLabel } from '../crm/logic.js';
import { useAction } from '../crm/parts.jsx';
import { usePlannerData } from './data.js';
import { openInbox, clearedFields, titleFromText } from './logic.js';
import { CaptureBar, CaptureSpacer, muted } from './parts.jsx';
import { TaskSheet, InboxNoteSheet, newTaskInitial } from './forms.jsx';

const PAGE = 50;
const SOURCE_LABELS = { typed: 'Typed', phone: 'Phone', siri: 'Siri', share: 'Share sheet' };

function InboxItem({ item, me, onTask, onNote, onDismiss }) {
  const who = actorLabel(item._sync?.createdBy ?? (item._sync?.local ? me : null), me);
  return (
    <li className="planner-inbox-item" data-inbox-id={item.id}>
      <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontWeight: 550 }}>{item.text}</p>
      <div style={{ ...muted, display: 'flex', gap: '0 var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <time dateTime={item.captured_at}>{formatDateTime(item.captured_at)}</time>
        {item.source ? <span>{SOURCE_LABELS[item.source] ?? item.source}</span> : null}
        {who ? <span>by {who === 'You' ? 'you' : who === 'Your partner' ? 'your partner' : who.toLowerCase()}</span> : null}
        <SyncBadges record={item} />
      </div>
      <div className="planner-actions">
        <Button variant="primary" onClick={() => onTask(item)} aria-label={`Make a task: ${item.text}`}><Icon name="tasks" size={18} />Task</Button>
        <Button onClick={() => onNote(item)}><Icon name="note" size={18} />Note on a client…</Button>
        <Button variant="ghost" onClick={() => onDismiss(item)}>Dismiss</Button>
      </div>
    </li>
  );
}

export default function InboxPage() {
  const { data, loading } = usePlannerData();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const [sheet, setSheet] = useState(null);
  const [shown, setShown] = useState(PAGE);
  const [dismissed, setDismissed] = useState(null); // the last dismissed item, for Undo
  const { error, run } = useAction();
  const items = useMemo(() => (data ? openInbox(data.inbox) : []), [data]);
  const close = () => setSheet(null);

  const toTask = (item) => {
    const { title, notes } = titleFromText(item.text);
    setSheet({ kind: 'task', item, initial: newTaskInitial({ me, businesses: data.businesses, title, notes: notes || undefined }) });
  };
  const dismiss = (item) => run(async () => {
    await store.update('inbox_item', item.id, clearedFields({ now: nowIso() }));
    setDismissed(item);
  });
  const undoDismiss = () => run(async () => {
    await store.update('inbox_item', dismissed.id, { cleared_at: null, became_entity: null, became_id: null });
    setDismissed(null);
  });

  return (
    <>
      <PageHeader title="Inbox" subtitle={data ? (items.length ? `${items.length} to sort` : 'Nothing to sort') : ' '} />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <CaptureBar />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {dismissed ? (
          <Notice tone="info">
            <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              Dismissed “{dismissed.text.length > 60 ? `${dismissed.text.slice(0, 59)}…` : dismissed.text}”.
              <button type="button" className="crm-link-button" onClick={undoDismiss}>Undo</button>
            </span>
          </Notice>
        ) : null}
        <Card>
          {!data ? (
            <p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p>
          ) : items.length ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="inbox">
              {items.slice(0, shown).map((item) => (
                <InboxItem
                  key={item.id}
                  item={item}
                  me={me}
                  onTask={toTask}
                  onNote={(i) => setSheet({ kind: 'note', item: i })}
                  onDismiss={dismiss}
                />
              ))}
            </ul>
          ) : (
            <EmptyState title="Inbox is clear">Capture anything above: it waits here until you sort it.</EmptyState>
          )}
          {items.length > shown ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: 'var(--space-3)' }}>
              <Button onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, items.length - shown)} more</Button>
              <span style={muted}>{shown} of {items.length}</span>
            </div>
          ) : null}
        </Card>
      </div>
      <CaptureSpacer />

      {sheet?.kind === 'task' ? (
        <TaskSheet
          initial={sheet.initial}
          title="Make a task"
          onClose={close}
          onDone={close}
          onSaved={(id) => store.update('inbox_item', sheet.item.id, clearedFields({ entity: 'task', id, now: nowIso() }))}
        />
      ) : null}
      {sheet?.kind === 'note' ? <InboxNoteSheet item={sheet.item} onClose={close} onDone={close} /> : null}
    </>
  );
}
