// The Support page (/helpdesk, D14): tickets made from each store's support mailbox — waiting for a reply first (the
// longest waiting first; 24 hours or more is flagged), then answered and closed ones. Filters (mailbox, state) live in
// the URL. Server data: needs a connection to the suite (customer emails are never kept on this device).
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useServerData } from '../../api/useServerData.js';
import { PageHeader, Card, Notice, EmptyState, Button, Badge, SelectField, Segmented } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import HelpdeskTabs from './Tabs.jsx';
import { STATE_WORDS, STATE_TONES, STATE_FILTERS, stateFilterOf, waitingText, closedText, ticketLine, PRIVACY_NOTE } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const PAGE = 50;

export default function TicketsPage() {
  const [params, setParams] = useSearchParams();
  const state = stateFilterOf(params.get('state'));
  const mailbox = params.get('mailbox') ?? '';
  const [pages, setPages] = useState(1);
  const qs = new URLSearchParams({ state, limit: String(PAGE * pages), ...(mailbox ? { mailbox } : {}) });
  const { data, error, offline, loading } = useServerData(`/api/helpdesk/tickets?${qs}`, { everyMs: 60_000 });
  const boxes = useServerData('/api/helpdesk/mailboxes', { everyMs: 0 });
  const set = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPages(1);
  };
  const mailboxes = boxes.data?.mailboxes ?? [];
  const counts = data?.counts;
  return (
    <>
      <HelpdeskTabs />
      <PageHeader
        title="Support"
        subtitle={counts ? `${counts.waiting} waiting for a reply${counts.flagged ? ` · ${counts.flagged} over 24 hours` : ''}` : ' '}
      />
      {offline ? <Notice tone="warn" style={{ marginBottom: 'var(--space-4)' }}>Can’t reach the suite server: support emails need a connection (they aren’t kept on this device).</Notice> : null}
      {error && !offline ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{error.message}</Notice> : null}
      {boxes.data && !mailboxes.length ? (
        <Card>
          <EmptyState title="No support mailbox yet">
            Add each store’s support mailbox on <Link to="/system/connections">System → Connections → Support mailboxes</Link>: its emails then show here as tickets.
          </EmptyState>
        </Card>
      ) : null}
      {mailboxes.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'end', marginBottom: 'var(--space-4)' }}>
          <Segmented label="Which tickets" value={state} onChange={(v) => set('state', v === 'waiting' ? '' : v)} options={STATE_FILTERS} />
          {mailboxes.length > 1 ? (
            <SelectField
              id="helpdesk-mailbox"
              label="Mailbox"
              value={mailbox}
              onChange={(v) => set('mailbox', v)}
              options={[{ value: '', label: 'Every mailbox' }, ...mailboxes.map((m) => ({ value: m.id, label: m.name }))]}
              style={{ minWidth: 200 }}
            />
          ) : null}
        </div>
      ) : null}
      {data && mailboxes.length ? (
        data.tickets.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }} data-testid="helpdesk-tickets">
            {data.tickets.map((t) => {
              const line = ticketLine(t);
              return (
                <li key={t.id} data-ticket-id={t.id} data-state={t.state} data-flagged={t.flagged ? '1' : '0'}>
                  <Link to={`/helpdesk/tickets/${t.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                    <Card>
                      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                          <strong style={{ overflowWrap: 'anywhere' }}>{line.title}</strong>
                          {t.flagged ? <Badge tone="danger">Over 24 hours</Badge> : <Badge tone={STATE_TONES[t.state]}>{STATE_WORDS[t.state]}</Badge>}
                        </div>
                        <span style={{ ...muted, overflowWrap: 'anywhere' }}>{line.who}{mailboxes.length > 1 ? ` · ${t.mailbox}` : ''}</span>
                        <span style={muted}>
                          {t.state === 'waiting' ? `${waitingText(t)} · since ${formatDateTime(t.waitingSince)}` : t.state === 'closed' ? closedText(t) : `Answered ${formatDateTime(t.lastReplyAt)}`}
                          {t.messageCount > 1 ? ` · ${t.messageCount} emails` : ''}
                        </span>
                      </div>
                    </Card>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <Card><EmptyState title={state === 'waiting' ? 'Nothing waiting for a reply' : 'No tickets here'}>{state === 'waiting' ? 'Every support email has been answered or closed.' : ''}</EmptyState></Card>
        )
      ) : null}
      {data && data.total > data.tickets.length ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Button onClick={() => setPages((p) => p + 1)} disabled={loading}>Show {Math.min(PAGE, data.total - data.tickets.length)} more</Button>
        </div>
      ) : null}
      <p style={{ ...muted, marginTop: 'var(--space-5)' }}>{PRIVACY_NOTE}</p>
    </>
  );
}
