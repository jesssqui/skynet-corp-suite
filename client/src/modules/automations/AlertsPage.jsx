// Alerts (C8): what the automations set to "alert" have prepared, newest first. Both people see
// every alert; marking one read is per person and works offline (a synced change).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { store, useRecords } from '../../sync/index.js';
import { useAuth } from '../../auth/session.jsx';
import { PageHeader, Card, Button, EmptyState, Notice, Icon } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { isUnread, readChange, unreadText, safeLink } from './alerts.js';

const PAGE = 50;

export default function AlertsPage() {
  const { session } = useAuth();
  const me = session.user.actor;
  const { records, loading } = useRecords('alert', { sort: '-at' });
  const [shown, setShown] = useState(PAGE);
  const [problem, setProblem] = useState(null);
  const unread = records.filter((a) => isUnread(a, me));

  // Read only (no "unread"): both of one person's devices then always agree — no clash to settle.
  async function mark(ids) {
    setProblem(null);
    try {
      for (const id of ids) await store.update('alert', id, readChange(me));
    } catch (err) {
      setProblem(err.message);
    }
  }

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle={unread.length ? unreadText(unread.length) : 'Nothing new'}
        actions={(
          <>
            {unread.length ? <Button onClick={() => mark(unread.map((a) => a.id))}>Mark all read</Button> : null}
            <Link to="/system/automations" style={{ alignSelf: 'center', fontSize: 'var(--text-sm)' }}>Automations</Link>
          </>
        )}
      />
      {problem ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{problem}</Notice> : null}
      {!loading && !records.length ? (
        <Card>
          <EmptyState title="No alerts yet">
            Automations set to “Alert” put a note here when they prepare something for you. Silent ones just add their tasks.
          </EmptyState>
        </Card>
      ) : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }} data-testid="alerts">
        {records.slice(0, shown).map((a) => {
          const fresh = isUnread(a, me);
          const link = safeLink(a.link);
          return (
            <li key={a.id} data-alert-id={a.id} data-unread={fresh ? 'true' : 'false'}>
              <Card style={{ display: 'grid', gap: 'var(--space-2)', borderLeft: fresh ? '3px solid var(--accent)' : undefined }}>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start' }}>
                  <span style={{ color: fresh ? 'var(--accent)' : 'var(--text-muted)', marginTop: 2 }}><Icon name="bell" size={18} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontWeight: fresh ? 650 : 500 }}>{a.title}</p>
                    <p style={{ margin: '2px 0 0', color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                      {formatDateTime(a.at)}{a._sync?.pending ? ' · waiting to sync' : ''}
                    </p>
                  </div>
                </div>
                {a.body ? <p style={{ margin: 0, fontSize: 'var(--text-sm)', whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{a.body}</p> : null}
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                  {link ? (
                    <Link to={link} onClick={() => fresh && mark([a.id])} style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Open</Link>
                  ) : null}
                  {fresh ? (
                    <Button variant="ghost" onClick={() => mark([a.id])} style={{ minHeight: 36, fontSize: 'var(--text-sm)' }}>Mark read</Button>
                  ) : <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>Read</span>}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      {records.length > shown ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Button onClick={() => setShown((n) => n + PAGE)}>Show more ({records.length - shown} more)</Button>
        </div>
      ) : null}
    </>
  );
}
