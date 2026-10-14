// Saved answers (/helpdesk/answers, D14): text to copy into your own mail app when answering a support email — for one
// mailbox (store) or every one. Synced records: they work offline like tasks. "{name}" becomes the customer's first
// name when copied. Edits send only what changed (a partner's edit made meanwhile survives).
import { useState } from 'react';
import { store, useRecords } from '../../sync/index.js';
import { SyncBadges } from '../../sync/components.jsx';
import { useServerData } from '../../api/useServerData.js';
import { PageHeader, Card, Button, EmptyState, TextField, TextAreaField, SelectField, Sheet, Notice } from '../../ui/index.js';
import HelpdeskTabs from './Tabs.jsx';
import { answerProblem, answerChanges } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

function AnswerSheet({ answer, mailboxes, onClose }) {
  const [v, setV] = useState({ title: answer?.title ?? '', body: answer?.body ?? '', mailbox_id: answer?.mailbox_id ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const problem = answerProblem(v);
  const choices = [{ value: '', label: 'Every mailbox' }, ...mailboxes.map((m) => ({ value: m.id, label: m.name }))];
  if (v.mailbox_id && !choices.some((c) => c.value === v.mailbox_id)) choices.push({ value: v.mailbox_id, label: 'A mailbox (not loaded)' });
  async function save() {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fields = answerChanges(answer, v);
      if (answer) {
        if (Object.keys(fields).length) await store.update('saved_answer', answer.id, fields);
      } else await store.create('saved_answer', fields);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await store.remove('saved_answer', answer.id);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={answer ? 'Edit saved answer' : 'New saved answer'}
      onClose={onClose}
      onSubmit={save}
      testId="helpdesk-answer-sheet"
      footer={(
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', width: '100%' }}>
          <Button type="submit" variant="primary" disabled={busy || problem !== null}>Save</Button>
          <Button onClick={onClose}>Cancel</Button>
          {answer ? <Button onClick={() => setConfirm(true)} style={{ marginLeft: 'auto' }}>Delete…</Button> : null}
        </div>
      )}
    >
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <TextField id="answer-title" label="Title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="Where is my order" />
        <TextAreaField id="answer-body" label="Answer" rows={8} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })}
          hint="{name} becomes the customer’s first name when you copy it." />
        <SelectField id="answer-mailbox" label="For" value={v.mailbox_id} onChange={(x) => setV({ ...v, mailbox_id: x })} options={choices} />
        {v.title || v.body ? (problem ? <span style={muted}>{problem}</span> : null) : null}
        {confirm ? (
          <Notice tone="warn">
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <span>Delete “{answer.title}”?</span>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button variant="primary" onClick={remove} disabled={busy}>Delete it</Button>
                <Button onClick={() => setConfirm(false)}>Keep it</Button>
              </div>
            </div>
          </Notice>
        ) : null}
        {error ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p> : null}
      </div>
    </Sheet>
  );
}

export default function AnswersPage() {
  const { records, loading } = useRecords('saved_answer', { sort: (a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || String(a.title).localeCompare(String(b.title)) });
  const boxes = useServerData('/api/helpdesk/mailboxes', { everyMs: 0 });
  const mailboxes = boxes.data?.mailboxes ?? [];
  const nameOf = (id) => (id ? mailboxes.find((m) => m.id === id)?.name ?? 'One mailbox' : 'Every mailbox');
  const [open, setOpen] = useState(null); // null | 'new' | answer
  return (
    <>
      <HelpdeskTabs />
      <PageHeader title="Saved answers" subtitle="Copy one into your mail app when you answer a support email." actions={<Button variant="primary" onClick={() => setOpen('new')} data-testid="helpdesk-answer-new">New answer</Button>} />
      {!loading && !records.length ? (
        <Card><EmptyState title="No saved answers yet">Write the answers you give often (“Where is my order”, “How to return”) once, then copy them from a ticket.</EmptyState></Card>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }} data-testid="helpdesk-answer-list">
          {records.map((a) => (
            <li key={a.id} data-answer-id={a.id}>
              <Card>
                <button type="button" onClick={() => setOpen(a)} style={{ all: 'unset', cursor: 'pointer', display: 'grid', gap: 4, width: '100%' }}>
                  <strong>{a.title}</strong>
                  <span style={{ ...muted, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{a.body.slice(0, 160)}{a.body.length > 160 ? '…' : ''}</span>
                  <span style={muted}>{nameOf(a.mailbox_id)} <SyncBadges record={a} /></span>
                </button>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {open ? <AnswerSheet answer={open === 'new' ? null : open} mailboxes={mailboxes} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
