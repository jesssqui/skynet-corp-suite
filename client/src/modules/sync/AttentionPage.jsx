import { useState } from 'react';
import { PageHeader, Card, Button, Badge, KeyValue, EmptyState, Notice } from '../../ui/index.js';
import { useSyncEngine, useSyncData } from '../../sync/index.js';
import { FieldsForm, fieldLabel, formatValue } from '../../sync/components.jsx';

const OP_LABEL = { create: 'New', update: 'Change to', delete: 'Delete' };

/** Why the server refused a change, in plain words (the server's own reason is shown under it). */
function explain(entry) {
  switch (entry.code) {
    case 'constraint':
      return 'It points to something the server doesn’t have — it may have been deleted, or not been sent yet.';
    case 'deleted':
      return 'This was deleted before the change reached the server.';
    case 'invalid_value':
      return 'The server didn’t accept one of the values.';
    case 'unknown_field':
    case 'unknown_entity':
      return 'This version of the app doesn’t match the server. Reload the app, then fix or discard this.';
    case 'op_not_allowed':
      return 'That kind of change isn’t allowed here.';
    case 'already_exists':
      return 'Something with the same id already exists on the server.';
    default:
      return 'The server couldn’t accept this change.';
  }
}

function when(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function StepFields({ step, definition }) {
  const fields = Object.entries(step.fields ?? {});
  if (!fields.length) return null;
  return <KeyValue rows={fields.map(([name, value]) => [fieldLabel(name), formatValue(definition?.fields?.[name], value)])} />;
}

function AttentionItem({ entry, engine }) {
  const { step } = entry;
  const definition = engine.definition(step.entity);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(step.fields ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  // An update only sends what it changes: edit just those fields.
  const editable = definition && step.op !== 'delete'
    ? { ...definition, fields: step.op === 'create' ? definition.fields : Object.fromEntries(Object.keys(step.fields ?? {}).filter((n) => definition.fields[n]).map((n) => [n, definition.fields[n]])) }
    : null;

  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-attention={entry.n}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <strong>{OP_LABEL[step.op]} {step.entity}</strong>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>{when(entry.at)}</span>
        </div>
        <Notice tone="warn">
          {explain(entry)}
          <span style={{ display: 'block', marginTop: 4, color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
            <Badge>{entry.code}</Badge> {entry.reason}
          </span>
        </Notice>
        {editing && editable ? (
          <FieldsForm definition={editable} values={values} onChange={setValues} idPrefix={`fix-${entry.n}`} />
        ) : (
          <StepFields step={step} definition={definition} />
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {editing ? (
            <>
              <Button variant="primary" disabled={busy} onClick={() => run(() => engine.fixAttention(entry.n, values))}>Send the fixed change</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={() => run(() => engine.retryAttention(entry.n))}>Try again</Button>
              {editable ? <Button disabled={busy} onClick={() => setEditing(true)}>Fix…</Button> : null}
              <Button variant="ghost" disabled={busy} onClick={() => run(() => engine.discardAttention(entry.n))}>
                {step.op === 'create' ? 'Discard (and later changes to it)' : 'Discard'}
              </Button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Changes the server refused, and changes waiting for a record this device hasn't received. */
export default function AttentionPage() {
  const engine = useSyncEngine();
  const { data } = useSyncData(async (e) => ({ attention: await e.attentionList(), waiting: await e.waitingList() }));
  const attention = data?.attention ?? [];
  const waiting = data?.waiting ?? [];

  return (
    <>
      <PageHeader title="Needs attention" subtitle="Changes the server couldn’t accept. Fix them, try again, or let them go." />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {attention.length ? (
          attention.map((entry) => <AttentionItem key={entry.n} entry={entry} engine={engine} />)
        ) : (
          <Card><EmptyState title="Nothing needs attention">Every change made on this device was accepted or is on its way.</EmptyState></Card>
        )}

        {waiting.length ? (
          <Card title="Waiting for their record">
            <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              These changes are for records the server doesn’t have yet (for example after it was restored from a backup and
              the other device hasn’t reconnected). They are sent again after every sync.
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {waiting.map((e) => (
                <li key={e.n} style={{ borderTop: '1px solid var(--border)', padding: 'var(--space-3) 0', display: 'grid', gap: 'var(--space-2)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <strong>{OP_LABEL[e.step.op]} {e.step.entity}</strong>
                    <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>since {when(e.parked.at)}</span>
                  </div>
                  <StepFields step={e.step} definition={engine.definition(e.step.entity)} />
                  <div><Button variant="ghost" onClick={() => engine.discardWaiting(e.n)}>Discard</Button></div>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
