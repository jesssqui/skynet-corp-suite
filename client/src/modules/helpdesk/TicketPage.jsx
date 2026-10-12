// One support ticket (/helpdesk/tickets/:id, D14): the customer's emails as plain text (never HTML: nothing remote is
// loaded; attachments by name only), our replies seen in the Sent folder, the order it is about — looked up live in
// the store and kept only in this page's memory —, and the saved answers to copy into your own mail app. Reply from
// your mail app: the suite marks the ticket answered when it sees the reply in the Sent folder. Server data: needs a
// connection. The stores sell age-restricted products: nothing here may ever feed a marketing list.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { useRecords } from '../../sync/index.js';
import { PageHeader, Card, Notice, Button, Badge } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { OrderCard } from '../sales/OrderCard.jsx';
import { useAuth } from '../../auth/session.jsx';
import HelpdeskTabs from './Tabs.jsx';
import './helpdesk.css';
import {
  STATE_WORDS, STATE_TONES, waitingText, closedText, reopenedText, fillAnswer, mailtoLink, replySubject, answersFor, orderNote, PRIVACY_NOTE, READ_ONLY_NOTE,
  NOT_SENDERS_ORDER, MAILTO_NOTE,
} from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

function Message({ m }) {
  const out = m.direction === 'out';
  return (
    <li data-testid="helpdesk-message" data-direction={m.direction}>
      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-2)', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong style={{ overflowWrap: 'anywhere' }}>{out ? 'Your reply' : (m.fromName ?? m.fromEmail ?? 'The customer')}</strong>
            <span style={{ ...muted, overflowWrap: 'anywhere' }}>{out ? (m.toEmail ? `to ${m.toEmail}` : '') : m.fromName ? m.fromEmail : ''}</span>
            <span style={{ ...muted, marginLeft: 'auto' }}>{formatDateTime(m.receivedAt)}</span>
          </div>
          {out ? (
            <span style={muted}>Seen in the Sent folder{m.subject ? ` (“${m.subject}”)` : ''}. Your replies’ text isn’t kept here.</span>
          ) : m.purged ? (
            <span style={muted}>This email’s text was deleted (90 days after the ticket was answered or closed).</span>
          ) : (
            // Plain text only: React shows it as text, and the server already turned any HTML into text.
            <div className="helpdesk-text" data-testid="helpdesk-text">{m.text || '(no text)'}</div>
          )}
          {m.truncated && !m.purged ? <span style={muted}>The rest of this long email isn’t kept: see it in your mail app.</span> : null}
          {m.attachments?.length ? (
            <span style={muted} data-testid="helpdesk-attachments">Attachments (not kept here — open the email in your mail app): {m.attachments.join(', ')}</span>
          ) : null}
        </div>
      </Card>
    </li>
  );
}

function OrderBox({ ticketId, storeId }) {
  const [state, setState] = useState({ busy: Boolean(storeId), result: null, error: storeId ? null : { code: 'no_store' } });
  useEffect(() => {
    if (!storeId) return undefined;
    let alive = true;
    // A POST with the ticket's id only: the server reads the order numbers and the customer's email itself, so nothing
    // personal is ever in an address. The answer stays in this page's memory.
    api.post(`/api/helpdesk/tickets/${ticketId}/order`, {})
      .then((result) => alive && setState({ busy: false, result, error: null }))
      .catch((error) => alive && setState({ busy: false, result: null, error }));
    return () => { alive = false; };
  }, [ticketId, storeId]);
  const note = orderNote(state.result, state.error);
  return (
    <Card title="The order">
      <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="helpdesk-order">
        {state.busy ? <span style={muted}>Asking the store…</span> : null}
        {note ? <span style={state.error ? { color: 'var(--danger)', fontSize: 'var(--text-sm)' } : muted}>{note}</span> : null}
        {state.result?.orders?.length ? (
          <ul className="sales-orders" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
            {state.result.orders.map((o) => (
              <li key={o.id} style={{ listStyle: 'none', display: 'grid', gap: 6 }} data-sender-matches={o.senderMatches === false ? '0' : '1'}>
                {o.senderMatches === false ? <Notice tone="warn">{NOT_SENDERS_ORDER}</Notice> : null}
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}><OrderCard o={o} /></ul>
              </li>
            ))}
            {state.result.more ? <li style={muted}>More orders match: the 10 newest are shown.</li> : null}
          </ul>
        ) : null}
        <span style={muted}>Read live from the store and shown only here: nothing about the order is kept (first name only).</span>
      </div>
    </Card>
  );
}

function Answers({ ticket, mailboxId }) {
  const { records } = useRecords('saved_answer');
  const [copied, setCopied] = useState(null);
  const list = answersFor(records, mailboxId);
  async function copy(a) {
    const text = fillAnswer(a.body, ticket.customerName);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(a.id);
    } catch {
      setCopied(`fail:${a.id}`);
    }
  }
  return (
    <Card title="Saved answers">
      <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="helpdesk-answers">
        {list.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-3)' }}>
            {list.map((a) => (
              <li key={a.id} data-answer-id={a.id} style={{ display: 'grid', gap: 6 }}>
                <strong>{a.title}</strong>
                <span style={{ ...muted, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{fillAnswer(a.body, ticket.customerName).slice(0, 240)}{a.body.length > 240 ? '…' : ''}</span>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <Button onClick={() => copy(a)} data-testid="helpdesk-copy">{copied === a.id ? 'Copied' : 'Copy'}</Button>
                  {ticket.customerEmail ? (
                    <a className="helpdesk-link-button" href={mailtoLink({ to: ticket.customerEmail, subject: ticket.subject, body: fillAnswer(a.body, ticket.customerName) })} data-testid="helpdesk-mailto">
                      Write it in Mail
                    </a>
                  ) : null}
                  {copied === `fail:${a.id}` ? <span style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>Couldn’t copy: select the text instead</span> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : <span style={muted}>No saved answers for this mailbox yet.</span>}
        <span style={muted}>
          Best: reply to the email itself in your mail app and paste the answer — the suite then finds your reply by its thread.
          “Write it in Mail” starts a new email “{replySubject(ticket.subject)}”, found by its subject and address. {MAILTO_NOTE} <Link to="/helpdesk/answers">Edit saved answers</Link>
        </span>
      </div>
    </Card>
  );
}

export default function TicketPage() {
  const { id } = useParams();
  const { data, error, offline, replace } = useServerData(`/api/helpdesk/tickets/${id}`, { everyMs: 60_000 });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const t = data?.ticket;
  async function act(what) {
    setBusy(true);
    setProblem(null);
    try {
      const out = await api.post(`/api/helpdesk/tickets/${id}/${what}`, {});
      replace((d) => ({ ...d, ticket: out.ticket }));
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server.' : err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <HelpdeskTabs />
      <PageHeader title={t ? `#${t.number} · ${t.subject || '(no subject)'}` : 'Support ticket'} subtitle={t ? `${t.mailbox} · ${t.customerName ? `${t.customerName} · ` : ''}${t.customerEmail ?? ''}` : ' '} />
      <p style={{ margin: '0 0 var(--space-4)' }}><Link to="/helpdesk">← All tickets</Link></p>
      {offline ? <Notice tone="warn" style={{ marginBottom: 'var(--space-4)' }}>Can’t reach the suite server: support emails need a connection (they aren’t kept on this device).</Notice> : null}
      {error && !offline ? <Notice tone="danger">{error.status === 404 ? 'This ticket isn’t here any more (its mailbox was removed, or it was deleted a year after it was answered).' : error.message}</Notice> : null}
      {t ? (
        <div className="helpdesk-layout">
          <div style={{ display: 'grid', gap: 'var(--space-4)', alignContent: 'start', minWidth: 0 }}>
            <Card>
              <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="helpdesk-ticket" data-state={t.state}>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge tone={STATE_TONES[t.state]}>{STATE_WORDS[t.state]}</Badge>
                  {t.flagged ? <Badge tone="danger">Over 24 hours</Badge> : null}
                  <span style={muted}>{t.state === 'waiting' ? waitingText(t) : t.state === 'closed' ? closedText(t, me) : `Answered ${formatDateTime(t.lastReplyAt)}`}</span>
                  {t.reopenedAt && t.state === 'waiting' ? <span style={muted}>{reopenedText(t, me, formatDateTime)}</span> : null}
                </div>
                <span style={muted}>{READ_ONLY_NOTE}</span>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  {t.state === 'closed'
                    ? <Button onClick={() => act('reopen')} disabled={busy || offline}>Reopen</Button>
                    : <Button onClick={() => act('close')} disabled={busy || offline} data-testid="helpdesk-close">Close: no reply needed</Button>}
                </div>
                {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
              </div>
            </Card>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }} data-testid="helpdesk-messages">
              {data.messages.map((m) => <Message key={m.id} m={m} />)}
            </ul>
          </div>
          <div style={{ display: 'grid', gap: 'var(--space-4)', alignContent: 'start', minWidth: 0 }}>
            <OrderBox ticketId={t.id} storeId={data.mailbox?.storeId ?? null} />
            <Answers ticket={t} mailboxId={t.mailboxId} />
          </div>
        </div>
      ) : null}
      <p style={{ ...muted, marginTop: 'var(--space-5)' }}>{PRIVACY_NOTE}</p>
    </>
  );
}
