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
      return 'This, or what it belongs to, was deleted before the change reached the server.';
    case 'parent_discarded':
      return 'What it belongs to was discarded on this device, so it can never be sent. Point it at another record (Fix…) or discard it.';
    case 'already_linked':
      return 'That outside record is already linked to another one. Undo that link first, or discard this.';
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

/** "client “Lefty’s”" for a record this device holds, else "client 0193…27a7". */
function useRecordName(engine, ref) {
  const { data } = useSyncData(async (e) => {
    if (!ref) return null;
    const rec = await e.get(ref.entity, ref.id, { orphans: true });
    const def = e.definition(ref.entity);
    const title = rec && Object.values(def?.fields ?? {}).find((f) => f.type === 'text' && rec[f.name]);
    return title ? `${ref.entity} “${rec[title.name]}”` : null;
  }, [ref?.entity, ref?.id], { entities: ref ? [ref.entity] : [] });
  if (!ref) return null;
  return data ?? `${ref.entity} ${ref.id.slice(0, 4)}…${ref.id.slice(-4)}`;
}

/** A change waiting for a record the server doesn't have yet: what it waits for, since when. */
function WaitingItem({ entry, engine }) {
  const { step, parked } = entry;
  const missing = parked.missing ?? null;
  const name = useRecordName(engine, missing);
  const what = !missing ? 'Waiting for its record'
    : missing.field ? `Waiting for its ${name} (${fieldLabel(missing.field).toLowerCase()})`
      : `Waiting for this ${name} to reach the server`;
  return (
    <li style={{ borderTop: '1px solid var(--border)', padding: 'var(--space-3) 0', display: 'grid', gap: 'var(--space-2)' }} data-waiting={entry.n}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <strong>{OP_LABEL[step.op]} {step.entity}</strong>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
          since {when(parked.at)}{parked.triedAt && parked.triedAt !== parked.at ? ` · last tried ${when(parked.triedAt)}` : ''}
        </span>
      </div>
      <span style={{ fontSize: 'var(--text-sm)' }} data-testid="waiting-for">{what}</span>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{parked.reason}</span>
      <StepFields step={step} definition={engine.definition(step.entity)} />
      <div>
        <Button variant="ghost" onClick={() => engine.discardWaiting(entry.n)}>
          {step.op === 'create' ? 'Discard (and what waits for it)' : 'Discard'}
        </Button>
      </div>
    </li>
  );
}

function StepFields({ step, definition, fields: shown }) {
  const fields = Object.entries(shown ?? step.fields ?? {});
  if (!fields.length) return null;
  return <KeyValue rows={fields.map(([name, value]) => [fieldLabel(name), formatValue(definition?.fields?.[name], value)])} />;
}

function AttentionItem({ entry, engine }) {
  const { step } = entry;
  const definition = engine.definition(step.entity);
  const [editing, setEditing] = useState(false);
  // Start from what the person last saw: the refused values with their later waiting edits on top.
  const [values, setValues] = useState(entry.latest ?? step.fields ?? {});
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
          <>
            <StepFields step={step} definition={definition} fields={entry.latest} />
            {entry.laterChanges ? (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Includes {entry.laterChanges} later change{entry.laterChanges === 1 ? '' : 's'} made on this device.
              </span>
            ) : null}
          </>
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
              These changes need a record the server doesn’t have yet — made on the other device and not sent yet, or
              lost when the server was restored from a backup. They are sent again after every sync and go in once it
              arrives. If what they wait for was refused above and you discard it, they move up there too.
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {waiting.map((e) => <WaitingItem key={e.n} entry={e} engine={engine} />)}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
