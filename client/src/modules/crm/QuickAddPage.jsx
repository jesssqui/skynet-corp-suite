import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { newId } from '@suite/shared/ids';
import { buildMatchIndex, planRow, ACTION_LABELS } from '@suite/shared/intake';
import { formatPhone } from '@suite/shared/normalize';
import {
  PageHeader, Card, Button, Badge, Notice, SelectField, TextAreaField, TextField, Icon, EmptyState,
} from '../../ui/index.js';
import { store, useSyncStatus } from '../../sync/index.js';
import { useClientListData } from './data.js';
import { KIND_LABELS, errorText, businessColor, pickableBusinesses } from './logic.js';
import { FormSheet } from './parts.jsx';
import {
  EXAMPLE, RELATIONSHIP_CHOICES, choiceById, buildRows, targetFrom, saveCounts, editRow, toggleRelationship,
} from './quickAdd.js';
import './crm.css';

// Quick add (/crm/quick-add): the brain dump. One client per line in a loose format (quickAdd.js),
// a preview that can be fixed cell by cell, every row checked against the clients already on this
// device, and Save — through the offline store, so it works with no connection.
//
// Kept for the app session (module state): the text, the edits and choices, and which lines were
// already created with which ids — so a double tap or a retry after a failure never creates a
// line twice (a retry re-uses the same ids; a create that already happened is skipped).

const draft = { text: '', defaultChoice: 'agency:website', edits: new Map(), choices: new Map() };
const session = new Map(); // row key -> { ids: { client, account, contact, 'rel:…' }, done, clientId }

const STATUS_BADGES = {
  new: { tone: 'ok', label: 'New' },
  same: { tone: 'warn', label: 'Already here' },
  similar: { tone: 'warn', label: 'Maybe the same as' },
  duplicate: { tone: 'neutral', label: 'Same as line' },
  invalid: { tone: 'danger', label: 'Needs a client name' },
  done: { tone: 'accent', label: 'Added' },
};

function useWide(query = '(min-width: 1000px)') {
  const get = () => typeof window !== 'undefined' && window.matchMedia(query).matches;
  const [wide, setWide] = useState(get);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return wide;
}

const actionLabel = (action, status) => (action === 'create' ? (status === 'new' ? 'Add' : 'Create anyway') : ACTION_LABELS[action]);
const kindLabel = (kind) => (kind === 'social' ? 'Social' : KIND_LABELS[kind] ?? kind);

/** What a row would make, in a few words ("Client, account, 2 relationships, contact"). */
function makesText(row, data) {
  if (row.action === 'skip' || row.status === 'invalid' || row.status === 'done') return null;
  let plan;
  try {
    const target = row.action === 'add' ? targetFrom(data, row.match?.clientId) : null;
    if (row.action === 'add' && !target) return null;
    plan = planRow(row.clean, { action: row.action, target, makeId: () => 'x' });
  } catch {
    return null;
  }
  const n = { client: 0, account: 0, relationship: 0, contact: 0 };
  for (const op of plan.ops) n[op.entity] += 1;
  const parts = [];
  if (n.client) parts.push('client');
  if (n.account) parts.push('account');
  if (n.relationship) parts.push(n.relationship === 1 ? 'relationship' : `${n.relationship} relationships`);
  if (n.contact) parts.push('contact');
  if (!parts.length) return 'Nothing missing: nothing to add';
  const text = parts.join(', ');
  return `${row.action === 'add' ? 'Adds' : 'Makes'} ${text}`;
}

function StatusCell({ row, onChoose }) {
  const b = STATUS_BADGES[row.status];
  let detail = null;
  if ((row.status === 'same' || row.status === 'similar') && row.match) {
    detail = (
      <>
        <Link to={`/crm/clients/${row.match.clientId}`}>{row.match.clientName}</Link>
        <span style={{ color: 'var(--text-muted)' }}>{row.match.by === 'name' ? ` (name like “${row.match.name}”)` : ` (same ${row.match.by})`}</span>
      </>
    );
  } else if (row.status === 'duplicate') {
    detail = <span>{row.duplicateOf}</span>;
  } else if (row.status === 'done' && row.clientId) {
    detail = <Link to={`/crm/clients/${row.clientId}`}>Open</Link>;
  }
  return (
    <div style={{ display: 'grid', gap: 6, justifyItems: 'start', minWidth: 0 }} data-testid="qa-status" data-status={row.status}>
      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' }}>
        <Badge tone={b.tone}>{row.status === 'done' ? <><Icon name="check" size={12} />{b.label}</> : b.label}</Badge>
        {detail}
      </span>
      {row.actions.length > 1 ? (
        <select
          aria-label={`Line ${row.line}: what to do`}
          className="qa-action"
          value={row.action}
          onChange={(e) => onChoose(row, e.target.value)}
          data-testid="qa-action"
        >
          {row.actions.map((a) => <option key={a} value={a}>{actionLabel(a, row.status)}</option>)}
        </select>
      ) : null}
    </div>
  );
}

function RelationshipToggles({ row, choices, businessesById, onToggle, line }) {
  const on = (c) => row.clean.relationships.some((r) => r.business_id === c.business_id && r.kind === c.kind);
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} role="group" aria-label={`Line ${line}: our businesses`}>
      {choices.map((c) => {
        const b = businessesById.get(c.business_id);
        const pressed = on(c);
        return (
          <button
            key={c.id}
            type="button"
            className="qa-chip"
            aria-pressed={pressed}
            title={b ? `${b.name} · ${KIND_LABELS[c.kind]}` : KIND_LABELS[c.kind]}
            onClick={() => onToggle(row, c, !pressed)}
            disabled={row.status === 'done'}
          >
            <span aria-hidden="true" className="qa-dot" style={{ background: businessColor(b) }} />
            {kindLabel(c.kind)}
          </button>
        );
      })}
    </div>
  );
}

/** Where the rest of the line went: the client's notes, the contact's role and notes (nothing is dropped). */
function NotesLines({ row }) {
  const c = row.clean;
  const lines = [];
  if (c.contact?.role) lines.push(['Role', c.contact.role]);
  if (c.client.notes) lines.push(['Client notes', c.client.notes]);
  if (c.contact?.notes) lines.push(['Contact notes', c.contact.notes]);
  if (!lines.length) return null;
  return (
    <div className="qa-sub" data-testid="qa-notes" style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
      {lines.map(([label, text]) => <div key={label}><strong>{label}:</strong> {text}</div>)}
    </div>
  );
}

function Warnings({ row }) {
  const list = [...row.clean.warnings];
  if (row.usedDefault) list.unshift('No business named: using the default');
  if (!list.length) return null;
  return (
    <ul className="qa-warnings">
      {list.map((w) => <li key={w}>{w}</li>)}
    </ul>
  );
}

/** One preview row as a table row (wide screens): every cell editable in place. */
function TableRow({ row, data, choices, businessesById, onEdit, onToggle, onChoose, onMore }) {
  const t = row.typed;
  const done = row.status === 'done';
  const input = (path, label, value, extra = {}) => (
    <input
      className="qa-input"
      aria-label={`Line ${row.line}: ${label}`}
      value={value ?? ''}
      placeholder={extra.placeholder}
      inputMode={extra.inputMode}
      autoComplete="off"
      spellCheck={false}
      disabled={done}
      onChange={(e) => onEdit(row, path, e.target.value)}
    />
  );
  const makes = makesText(row, data);
  return (
    <tr data-qa-row={row.line} data-status={row.status}>
      <td className="qa-num">{row.line}</td>
      <td>
        <div className="qa-stack">
          {input('client.name', 'client', t.client.name, { placeholder: 'Client name' })}
          {input('account.name', 'account', t.account.name, { placeholder: `Account: ${row.clean.client.name ?? 'same as client'}` })}
        </div>
      </td>
      <td><RelationshipToggles row={row} choices={choices} businessesById={businessesById} onToggle={onToggle} line={row.line} /></td>
      <td>
        <div className="qa-stack">
          {input('contact.name', 'contact name', t.contact?.name, { placeholder: row.clean.contact ? `Contact: ${row.clean.contact.name}` : 'Contact name' })}
          {input('contact.email', 'email', t.contact?.email, { placeholder: 'Email', inputMode: 'email' })}
          {input('contact.phone', 'phone', t.contact?.phone, { placeholder: 'Phone', inputMode: 'tel' })}
        </div>
      </td>
      <td>
        <div className="qa-stack">
          {input('client.tags', 'tags', t.client.tags, { placeholder: 'Tags' })}
          <NotesLines row={row} />
          <button type="button" className="crm-link-button" style={{ justifySelf: 'start', minHeight: 32, fontSize: 'var(--text-sm)', textAlign: 'left' }} onClick={() => onMore(row)} disabled={done}>
            {row.clean.client.notes || row.clean.contact?.notes || row.clean.contact?.role ? 'Edit notes…' : 'More…'}
          </button>
        </div>
      </td>
      <td>
        <StatusCell row={row} onChoose={onChoose} />
        {makes ? <div className="qa-makes">{makes}</div> : null}
        <Warnings row={row} />
      </td>
    </tr>
  );
}

/** One preview row as a card (phones): what it will make, the choice, Edit for the details. */
function CardRow({ row, data, choices, businessesById, onToggle, onChoose, onMore }) {
  const c = row.clean;
  const contact = c.contact ? [c.contact.name, c.contact.email, c.contact.phone ? formatPhone(c.contact.phone) : null].filter(Boolean).join(' · ') : null;
  const makes = makesText(row, data);
  return (
    <li className="qa-card" data-qa-row={row.line} data-status={row.status}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <strong style={{ overflowWrap: 'anywhere' }}>
          <span className="qa-num" style={{ marginRight: 6 }}>{row.line}</span>
          {c.client.name ?? <em style={{ color: 'var(--danger)' }}>No name</em>}
        </strong>
        {row.status !== 'done' ? (
          <Button variant="ghost" style={{ minHeight: 'var(--tap)', padding: '0 var(--space-2)', color: 'var(--accent)' }} onClick={() => onMore(row)} aria-label={`Edit line ${row.line}`}>
            <Icon name="edit" size={16} />Edit
          </Button>
        ) : null}
      </div>
      {c.account.name && c.account.name !== c.client.name ? <div className="qa-sub">Account: {c.account.name}</div> : null}
      {contact ? <div className="qa-sub" style={{ overflowWrap: 'anywhere' }}>Contact: {contact}</div> : null}
      {c.client.tags ? <div className="qa-sub">Tags: {c.client.tags}</div> : null}
      <NotesLines row={row} />
      <RelationshipToggles row={row} choices={choices} businessesById={businessesById} onToggle={onToggle} line={row.line} />
      <StatusCell row={row} onChoose={onChoose} />
      {makes ? <div className="qa-makes">{makes}</div> : null}
      <Warnings row={row} />
    </li>
  );
}

/** Every field of one row, in a sheet (phones; "More…" on wide screens). */
function RowSheet({ row, choices, businessesById, onClose, onSave }) {
  const [t, setT] = useState(row.typed);
  const set = (path) => (e) => setT((cur) => editRow(cur, path, e.target.value));
  const on = (c) => (t.relationships ?? []).some((r) => r.business_id === c.business_id && r.kind === c.kind);
  const dirty = t !== row.typed;
  return (
    <FormSheet title={`Line ${row.line}`} testId="qa-row-sheet" onClose={onClose} onSave={() => onSave(t)} dirty={dirty} saveLabel="Done">
      <TextField id="qa-client" label="Client name" value={t.client.name ?? ''} onChange={set('client.name')} autoComplete="off" />
      <TextField id="qa-account" label="Account (their business)" hint="Empty: the client’s name" value={t.account.name ?? ''} onChange={set('account.name')} autoComplete="off" />
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Our businesses</span>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              className="qa-chip"
              aria-pressed={on(c)}
              onClick={() => setT((cur) => toggleRelationship(cur, c, !on(c)))}
            >
              <span aria-hidden="true" className="qa-dot" style={{ background: businessColor(businessesById.get(c.business_id)) }} />
              {businessesById.get(c.business_id)?.name ?? ''} · {KIND_LABELS[c.kind]}
            </button>
          ))}
        </div>
      </div>
      <TextField id="qa-contact" label="Contact name" hint="Empty with an email or phone: the client’s name" value={t.contact?.name ?? ''} onChange={set('contact.name')} autoComplete="off" />
      <TextField id="qa-role" label="Role" value={t.contact?.role ?? ''} onChange={set('contact.role')} autoComplete="off" />
      <TextField id="qa-email" label="Email" type="email" inputMode="email" value={t.contact?.email ?? ''} onChange={set('contact.email')} autoComplete="off" />
      <TextField id="qa-phone" label="Phone" type="tel" inputMode="tel" value={t.contact?.phone ?? ''} onChange={set('contact.phone')} autoComplete="off" />
      <TextField id="qa-tags" label="Tags" hint="Separated by commas" value={t.client.tags ?? ''} onChange={set('client.tags')} autoComplete="off" />
      <TextAreaField id="qa-notes" label="Notes about the client" value={t.client.notes ?? ''} onChange={set('client.notes')} />
      <TextAreaField id="qa-contact-notes" label="Contact notes" value={t.contact?.notes ?? ''} onChange={set('contact.notes')} />
    </FormSheet>
  );
}

export default function QuickAddPage() {
  const { data, loading } = useClientListData();
  const status = useSyncStatus();
  const wide = useWide();
  const [text, setTextState] = useState(draft.text);
  const [defaultChoice, setDefaultState] = useState(draft.defaultChoice);
  const [edits, setEdits] = useState(draft.edits);
  const [choices, setChoices] = useState(draft.choices);
  const [tick, setTick] = useState(0); // the session map changed
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [sheetRow, setSheetRow] = useState(null);
  const savingRef = useRef(false);
  const deferredText = useDeferredValue(text);

  const setText = (v) => { draft.text = v; setTextState(v); setResult(null); };
  const setDefault = (v) => { draft.defaultChoice = v; setDefaultState(v); };
  const putEdit = (key, typed) => setEdits((cur) => { const m = new Map(cur); m.set(key, typed); draft.edits = m; return m; });
  const putChoice = (row, action) => setChoices((cur) => { const m = new Map(cur); m.set(row.key, { action, status: row.status }); draft.choices = m; return m; });

  const businessesById = useMemo(() => new Map((data?.businesses ?? []).map((b) => [b.id, b])), [data]);
  const pickable = useMemo(() => new Set(pickableBusinesses(data?.businesses ?? []).map((b) => b.id)), [data]);
  const relChoices = useMemo(() => RELATIONSHIP_CHOICES.filter((c) => pickable.has(c.business_id) || !data), [pickable, data]);
  const defaults = useMemo(() => { const c = choiceById(defaultChoice); return c ? [{ business_id: c.business_id, kind: c.kind }] : []; }, [defaultChoice]);
  const index = useMemo(() => (data ? buildMatchIndex(data) : null), [data]);
  const rows = useMemo(
    () => (data ? buildRows(deferredText, { data, defaults, edits, choices, session, index }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deferredText, data, defaults, edits, choices, index, tick],
  );
  const counts = saveCounts(rows);
  const tally = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  const offline = status?.phase === 'offline' || (typeof navigator !== 'undefined' && navigator.onLine === false);

  const onEdit = (row, path, value) => putEdit(row.key, editRow(row.typed, path, value));
  const onToggle = (row, choice, on) => putEdit(row.key, toggleRelationship(row.typed, choice, on));

  async function save() {
    if (savingRef.current || !data) return; // a double tap
    savingRef.current = true;
    setSaving(true);
    setResult(null);
    let created = 0;
    let added = 0;
    let failure = null;
    try {
      for (const row of rows) {
        if (row.status === 'done' || row.status === 'invalid' || row.action === 'skip' || !row.action) continue;
        const s = session.get(row.key) ?? { ids: {}, done: false, clientId: null };
        session.set(row.key, s);
        const target = row.action === 'add' ? targetFrom(data, row.match?.clientId) : null;
        if (row.action === 'add' && !target) {
          failure = { line: row.line, message: 'The client to add to isn’t on this device any more.' };
          break;
        }
        const plan = planRow(row.clean, { action: row.action, target, makeId: (k) => (s.ids[k] ??= newId()) });
        try {
          for (const op of plan.ops) {
            try {
              await store.create(op.entity, op.fields, { id: op.id });
            } catch (err) {
              if (err?.code !== 'already_exists') throw err; // made by an earlier try: done
            }
          }
        } catch (err) {
          failure = { line: row.line, message: errorText(err) };
          break;
        }
        s.done = true;
        s.clientId = plan.clientId;
        if (row.action === 'add') added += 1;
        else created += 1;
        setTick((n) => n + 1);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
      setResult({ created, added, failure });
    }
  }

  const startOver = () => {
    session.clear();
    setTick((n) => n + 1);
    draft.edits = new Map();
    draft.choices = new Map();
    setEdits(draft.edits);
    setChoices(draft.choices);
    setText('');
  };

  const saveLabel = counts.create && counts.add
    ? `Add ${counts.create} ${counts.create === 1 ? 'client' : 'clients'} + ${counts.add} to existing`
    : counts.add ? `Add to ${counts.add} existing ${counts.add === 1 ? 'client' : 'clients'}`
      : counts.create ? `Add ${counts.create} ${counts.create === 1 ? 'client' : 'clients'}` : 'Nothing to add';
  const defaultOptions = [
    ...relChoices.map((c) => ({ value: c.id, label: `${businessesById.get(c.business_id)?.name ?? 'Our business'} · ${KIND_LABELS[c.kind]}` })),
    { value: 'none', label: 'None (add relationships later)' },
  ];

  return (
    <>
      <PageHeader
        title="Quick add"
        subtitle="Type or paste your clients, one per line. Check the preview, then add them all."
        actions={<Link to="/crm" className="crm-link-button" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="back" size={16} />Clients</Link>}
      />
      <div className="qa-top">
        <Card>
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <TextAreaField
              id="qa-text"
              label="Clients, one per line"
              rows={wide ? 10 : 7}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={EXAMPLE}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              inputStyle={{ fontSize: 15, fontFamily: 'var(--font)', minHeight: wide ? 200 : 150 }}
            />
            <SelectField
              id="qa-default"
              label="Lines that don’t name one of our businesses"
              value={defaultChoice}
              onChange={setDefault}
              options={defaultOptions}
            />
          </div>
        </Card>
        <Card>
          <details className="qa-howto" open={wide} key={wide ? 'wide' : 'narrow'}>
          <summary>How to write a line</summary>
          <div style={{ display: 'grid', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
            <p style={{ margin: 0 }}>The client’s name first, then anything, in any order, separated by <code>-</code> <code>—</code> <code>,</code> <code>;</code> or <code>|</code>:</p>
            <pre className="qa-example" data-testid="qa-example">{EXAMPLE}</pre>
            <ul className="qa-help">
              <li><strong>Our businesses:</strong> website, web, design → Great White North Design (website); social → GWND (social); consulting; wholesale.</li>
              <li><strong>Contact:</strong> an email and/or phone anywhere; the name beside it is the contact. Or <code>contact:</code> / <code>owner:</code>.</li>
              <li><strong>Their business:</strong> <code>Client (Account)</code> or <code>account:</code>. Otherwise the account is named like the client.</li>
              <li><strong>Also:</strong> <code>#tag</code>, <code>tags:</code>, <code>notes:</code> (the rest of the line), a role (<code>Karen O’Neil, owner</code>). Anything else is kept in the client’s notes.</li>
            </ul>
          </div>
          </details>
        </Card>
      </div>

      <section style={{ marginTop: 'var(--space-5)', display: 'grid', gap: 'var(--space-3)' }} aria-label="Preview">
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 650, marginRight: 'var(--space-2)' }}>Preview</h2>
          {rows.length ? (
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} data-testid="qa-counts">
              <Badge>{rows.length} {rows.length === 1 ? 'line' : 'lines'}</Badge>
              {Object.entries(STATUS_BADGES).filter(([k]) => tally[k]).map(([k, b]) => (
                <Badge key={k} tone={b.tone}>{tally[k]} {k === 'similar' ? 'maybe the same' : k === 'duplicate' ? 'repeated' : b.label.toLowerCase()}</Badge>
              ))}
            </span>
          ) : null}
        </div>
        {!data && loading ? <p style={{ color: 'var(--text-muted)', margin: 0 }}>Loading…</p> : null}
        {data && !rows.length ? (
          <Card><EmptyState title="Nothing to preview yet">Type or paste a line per client above — the preview shows here as you type.</EmptyState></Card>
        ) : null}
        {rows.length && wide ? (
          <Card padded={false} style={{ overflowX: 'auto' }}>
            <table className="qa-table" data-testid="qa-preview">
              <thead>
                <tr><th>#</th><th>Client / account</th><th>Our businesses</th><th>Contact</th><th>Tags</th><th>What happens</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <TableRow key={row.key} row={row} data={data} choices={relChoices} businessesById={businessesById}
                    onEdit={onEdit} onToggle={onToggle} onChoose={putChoice} onMore={setSheetRow} />
                ))}
              </tbody>
            </table>
          </Card>
        ) : null}
        {rows.length && !wide ? (
          <ul className="qa-cards" data-testid="qa-preview">
            {rows.map((row) => (
              <CardRow key={row.key} row={row} data={data} choices={relChoices} businessesById={businessesById}
                onToggle={onToggle} onChoose={putChoice} onMore={setSheetRow} />
            ))}
          </ul>
        ) : null}

        {result ? (
          <Notice tone={result.failure ? 'danger' : 'ok'}>
            <span data-testid="qa-result">
              {result.created || result.added
                ? `Added ${result.created} ${result.created === 1 ? 'client' : 'clients'}${result.added ? ` and filled in ${result.added} existing` : ''}${offline ? ' on this device: they sync when you’re back online.' : '.'}`
                : result.failure ? '' : 'Nothing to add.'}
              {result.failure ? ` Line ${result.failure.line} wasn’t saved: ${result.failure.message} Fix it and save again — lines already added won’t be added twice.` : ''}
            </span>{' '}
            {result.created || result.added ? <Link to="/crm">See them in Clients</Link> : null}
          </Notice>
        ) : null}

        {rows.length ? (
          <div className="qa-savebar">
            <Button variant="primary" onClick={save} disabled={saving || !(counts.create + counts.add)} data-testid="qa-save">
              {saving ? 'Adding…' : saveLabel}
            </Button>
            {counts.skip ? <span className="qa-sub">{counts.skip} skipped</span> : null}
            {offline ? <span className="qa-sub">Offline: saved on this device, synced later</span> : null}
            <Button variant="ghost" onClick={startOver} style={{ marginLeft: 'auto' }}>Start a new list</Button>
          </div>
        ) : null}
      </section>

      {sheetRow ? (
        <RowSheet
          row={sheetRow}
          choices={relChoices}
          businessesById={businessesById}
          onClose={() => setSheetRow(null)}
          onSave={(typed) => { putEdit(sheetRow.key, typed); setSheetRow(null); }}
        />
      ) : null}
    </>
  );
}
