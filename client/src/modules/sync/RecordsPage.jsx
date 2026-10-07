import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader, Card, Button, KeyValue, EmptyState, Notice } from '../../ui/index.js';
import { useSyncEngine, useRecords, useSyncData } from '../../sync/index.js';
import { ClashPanel, FieldInput, FieldsForm, SyncBadges, fieldLabel, formatValue } from '../../sync/components.jsx';

// A plain view of any synced record type, straight from the offline copy: list, add, change,
// tick, delete, settle clashes. The CRM's own pages (C3a/C4a) replace it for real use; this
// one stays as the place to look at what a device holds.

function titleField(def) {
  return Object.values(def.fields).find((f) => f.type === 'text' && f.required) ?? Object.values(def.fields).find((f) => f.type === 'text');
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function AddForm({ def, engine, onDone }) {
  const [values, setValues] = useState({});
  const { busy, error, run } = useAction();
  return (
    <Card title={`New ${def.entity}`}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => engine.create(def.entity, values))) onDone();
        }}
        style={{ display: 'grid', gap: 'var(--space-3)' }}
      >
        <FieldsForm definition={def} values={values} onChange={setValues} idPrefix="new" />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button variant="primary" type="submit" disabled={busy}>Save</Button>
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

/** id -> a readable label for every record on this device (for `id` fields). */
function useLabels(needed) {
  const { data } = useSyncData(async (engine) => {
    if (!needed) return null;
    const labels = new Map();
    for (const d of engine.entities()) {
      const title = titleField(d);
      for (const rec of await engine.list(d.entity)) labels.set(rec.id, `${d.entity} · ${title ? formatValue(title, rec[title.name]) : rec.id}`);
    }
    return labels;
  }, [needed], { entities: needed ? null : [] });
  return data ?? EMPTY;
}

const EMPTY = new Map();
const PAGE = 50; // rows at a time: a phone shouldn't build thousands of rows to show a dozen

function RecordRow({ def, engine, record, first, labels }) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState({});
  const [confirming, setConfirming] = useState(false);
  // Ticks show at once; the record catches up a moment later (written to the offline copy).
  const [ticked, setTicked] = useState({});
  useEffect(() => {
    setTicked((t) => {
      const left = Object.fromEntries(Object.entries(t).filter(([k, v]) => record[k] !== v));
      return Object.keys(left).length === Object.keys(t).length ? t : left;
    });
  }, [record]);
  const { busy, error, run } = useAction();
  const title = titleField(def);
  const canUpdate = def.ops.has('update');
  const booleans = Object.values(def.fields).filter((f) => f.type === 'boolean');
  const shown = Object.values(def.fields)
    .filter((f) => f !== title && (f.type !== 'boolean' || !canUpdate))
    .filter((f) => record[f.name] !== null && record[f.name] !== undefined)
    .map((f) => [fieldLabel(f.name), f.type === 'id' ? (labels.get(record[f.name]) ?? record[f.name]) : formatValue(f, record[f.name])]);

  return (
    <li
      data-record-id={record.id}
      style={{ borderTop: first ? 0 : '1px solid var(--border)', padding: 'var(--space-3) 0', display: 'grid', gap: 'var(--space-2)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <strong style={{ flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' }}>{title ? formatValue(title, record[title.name]) : record.id}</strong>
        <SyncBadges record={record} />
      </div>
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => engine.update(def.entity, record.id, values))) setEditing(false);
          }}
          style={{ display: 'grid', gap: 'var(--space-3)' }}
        >
          <FieldsForm definition={def} values={values} onChange={setValues} idPrefix={`edit-${record.id}`} />
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="primary" type="submit" disabled={busy}>Save</Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <>
          {booleans.length && canUpdate ? (
            <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
              {booleans.map((f) => (
                <FieldInput
                  key={f.name}
                  field={f}
                  idPrefix={`r-${record.id}`}
                  value={Object.hasOwn(ticked, f.name) ? ticked[f.name] : record[f.name]}
                  onChange={async (v) => {
                    setTicked((t) => ({ ...t, [f.name]: v }));
                    if (!(await run(() => engine.update(def.entity, record.id, { [f.name]: v })))) {
                      setTicked(({ [f.name]: _, ...rest }) => rest);
                    }
                  }}
                />
              ))}
            </div>
          ) : null}
          {shown.length ? <KeyValue rows={shown} /> : null}
        </>
      )}
      <ClashPanel record={record} definition={def} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!editing ? (
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {canUpdate ? (
            <Button variant="ghost" onClick={() => { setValues(Object.fromEntries(Object.keys(def.fields).map((n) => [n, record[n]]))); setEditing(true); }}>
              Edit
            </Button>
          ) : null}
          {def.ops.has('delete') ? (
            confirming ? (
              <>
                <Button variant="danger" disabled={busy} onClick={() => run(() => engine.remove(def.entity, record.id))}>Delete</Button>
                <Button variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setConfirming(true)}>Delete…</Button>
            )
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default function RecordsPage() {
  const { entity } = useParams();
  const engine = useSyncEngine();
  const def = engine?.definition(entity) ?? null;
  const { records, loading } = useRecords(entity);
  const labels = useLabels(Boolean(def && Object.values(def.fields).some((f) => f.type === 'id')));
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [entity]);

  if (engine && !def) {
    return (
      <Card>
        <EmptyState title={`No synced records called “${entity}”`}>
          <Link to="/sync">Back to offline data</Link>
        </EmptyState>
      </Card>
    );
  }
  return (
    <>
      <PageHeader
        title={entity}
        subtitle={<Link to="/sync">Offline data</Link>}
        actions={def?.ops.has('create') && !adding ? <Button variant="primary" onClick={() => setAdding(true)}>Add</Button> : null}
      />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {adding && def ? <AddForm def={def} engine={engine} onDone={() => setAdding(false)} /> : null}
        <Card>
          {!def || loading ? (
            <span style={{ color: 'var(--text-muted)' }}>Loading…</span>
          ) : records.length ? (
            <>
              <ul style={{ listStyle: 'none', margin: 'calc(-1 * var(--space-3)) 0', padding: 0 }}>
                {records.slice(0, shown).map((r, i) => (
                  <RecordRow key={r.id} def={def} engine={engine} record={r} first={i === 0} labels={labels} />
                ))}
              </ul>
              {records.length > shown ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: 'var(--space-4)' }}>
                  <Button onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, records.length - shown)} more</Button>
                  <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }} data-testid="records-shown">
                    {shown} of {records.length}
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState title={`No ${entity} records on this device`} />
          )}
        </Card>
      </div>
    </>
  );
}
