import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { newId } from '@suite/shared/ids';
import { readTable, CsvError } from '@suite/shared/csv';
import { detectMapping, MAPPING_FIELDS, ACTION_LABELS } from '@suite/shared/intake';
import { formatPhone } from '@suite/shared/normalize';
import { PageHeader, Card, Button, Badge, Notice, SelectField, Icon } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/session.jsx';
import { store, useSyncStatus } from '../../sync/index.js';
import { useBusinesses } from './data.js';
import { KIND_LABELS, actorLabel, pickableBusinesses } from './logic.js';
import { RELATIONSHIP_CHOICES, choiceById } from './quickAdd.js';
import './crm.css';

// Import (/crm/import): the accounting customer list as a CSV. The file is read here for the
// column mapping (headers and a sample); the preview and the import itself run on the server
// (POST /api/crm/import/preview and /commit), which writes through sync.applyLocal — so this page
// needs a connection, unlike the rest of the CRM. Rows already imported, already here (same
// email or phone) or maybe the same (similar name) are skipped unless the person chooses
// otherwise; nothing existing is ever overwritten.

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const PAGE = 50;

const STATUS = {
  new: { tone: 'ok', label: 'New', filter: 'New' },
  same: { tone: 'warn', label: 'Already here', filter: 'Already here' },
  similar: { tone: 'warn', label: 'Maybe the same as', filter: 'Maybe the same' },
  changed: { tone: 'warn', label: 'Changed since last import — not applied', filter: 'Changed' },
  imported: { tone: 'neutral', label: 'Imported before', filter: 'Imported before' },
  duplicate: { tone: 'neutral', label: 'Same as row', filter: 'Repeated' },
  invalid: { tone: 'danger', label: 'Can’t import', filter: 'Problems' },
};

const actionLabel = (action, status) => (action === 'create' ? (status === 'new' ? 'Import' : 'Create anyway') : ACTION_LABELS[action]);

/** A file's text: UTF-8, or Windows-1252 when it isn't (older QuickBooks Desktop exports). */
async function readFileText(file) {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('windows-1252').decode(buf);
  } catch {
    return utf8;
  }
}

function useOffline() {
  const status = useSyncStatus();
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return !online || status?.phase === 'offline';
}

function Adds({ adds, businessesById }) {
  if (!adds) return null;
  const parts = [];
  if (adds.account) parts.push('an account');
  if (adds.contact) parts.push('a contact');
  for (const r of adds.relationships) parts.push(`${businessesById.get(r.business_id)?.name ?? 'our business'} · ${KIND_LABELS[r.kind]}`);
  return <div className="qa-makes">{parts.length ? `“Add only what’s missing” adds ${parts.join(', ')}` : 'Nothing missing to add'}</div>;
}

function RowStatus({ row, choice, onChoose, businessesById }) {
  const s = STATUS[row.status];
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
  } else if ((row.status === 'imported' || row.status === 'changed') && row.previous) {
    detail = (
      <span style={{ color: 'var(--text-muted)' }}>
        {formatDateTime(row.previous.at)}{row.previous.fileName ? ` from ${row.previous.fileName}` : ''}
        {row.previous.live ? null : ' · since deleted'}
      </span>
    );
  } else if (row.status === 'invalid') {
    detail = <span style={{ color: 'var(--danger)' }}>{row.problems.join('; ')}</span>;
  }
  const action = choice ?? row.action;
  return (
    <div style={{ display: 'grid', gap: 6, justifyItems: 'start', minWidth: 0 }} data-testid="imp-status" data-status={row.status}>
      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' }}>
        <Badge tone={s.tone}>{s.label}</Badge>
        {detail}
      </span>
      {row.actions.length > 1 ? (
        <select className="qa-action" aria-label={`Row ${row.row}: what to do`} value={action} onChange={(e) => onChoose(row, e.target.value)}>
          {row.actions.map((a) => <option key={a} value={a}>{actionLabel(a, row.status)}</option>)}
        </select>
      ) : null}
      {action === 'add' ? <Adds adds={row.adds} businessesById={businessesById} /> : null}
      {row.warnings.length ? <ul className="qa-warnings">{row.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
    </div>
  );
}

const contactText = (c) => (c ? [c.name, c.email, c.phone ? formatPhone(c.phone) : null].filter(Boolean).join(' · ') : '—');

function Progress({ batch }) {
  const pct = batch.totalRows ? Math.round((batch.processed / batch.totalRows) * 100) : 0;
  return (
    <div style={{ display: 'grid', gap: 6 }} data-testid="imp-progress">
      <span style={{ fontSize: 'var(--text-sm)' }}>Importing… {batch.processed.toLocaleString('en-CA')} of {batch.totalRows.toLocaleString('en-CA')} rows</span>
      <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.3s' }} />
      </div>
    </div>
  );
}

function batchSummary(b) {
  const parts = [`${b.createdClients} new ${b.createdClients === 1 ? 'client' : 'clients'}`];
  if (b.addedTo) parts.push(`${b.addedTo} filled in`);
  parts.push(`${b.skipped} skipped`);
  if (b.failed) parts.push(`${b.failed} failed`);
  return parts.join(' · ');
}

function PastImports({ batches, me }) {
  if (!batches?.length) return null;
  return (
    <Card padded={false} style={{ marginTop: 'var(--space-5)' }}>
      <h2 className="imp-card-title">Past imports</h2>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="imp-batches">
        {batches.map((b) => (
          <li key={b.id} data-batch-id={b.id} style={{ borderTop: '1px solid var(--border)', padding: 'var(--space-3) var(--space-4)', display: 'grid', gap: 2 }}>
            <span style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'baseline' }}>
              <strong style={{ overflowWrap: 'anywhere' }}>{b.fileName ?? 'CSV file'}</strong>
              {b.source ? <Badge>{b.source}</Badge> : null}
              {b.status !== 'done' ? <Badge tone={b.status === 'running' ? 'accent' : 'warn'}>{b.status === 'running' ? 'Running' : b.status === 'interrupted' ? 'Stopped part-way (import it again to finish)' : 'Failed'}</Badge> : null}
            </span>
            <span className="qa-sub">
              {formatDateTime(b.startedAt)} · by {(actorLabel(b.actor, me) ?? 'someone').toLowerCase()} · {b.totalRows.toLocaleString('en-CA')} rows
            </span>
            <span style={{ fontSize: 'var(--text-sm)' }}>{batchSummary(b)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function ImportPage() {
  const offline = useOffline();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const { businesses } = useBusinesses();
  const businessesById = useMemo(() => new Map(businesses.map((b) => [b.id, b])), [businesses]);
  const pickable = useMemo(() => new Set(pickableBusinesses(businesses).map((b) => b.id)), [businesses]);
  const [file, setFile] = useState(null); // { name, text, headers, sample, rows }
  const [fileError, setFileError] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [source, setSource] = useState(null);
  const [relChoice, setRelChoice] = useState('agency:website');
  const [preview, setPreview] = useState(null);
  const [choices, setChoices] = useState(new Map());
  const [filter, setFilter] = useState('all');
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState(null); // 'preview' | 'commit'
  const [error, setError] = useState(null);
  const [batch, setBatch] = useState(null);
  const [batches, setBatches] = useState(null);
  const pending = useRef(null); // the batch id of a commit not yet confirmed (a retry re-uses it)
  const inputRef = useRef(null);

  const loadBatches = useCallback(async () => {
    try {
      const r = await api.get('/api/crm/import/batches');
      setBatches(r.batches);
      return r;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => { if (!offline) loadBatches(); }, [offline, loadBatches]);

  const rel = choiceById(relChoice);
  const request = () => ({
    text: file.text, fileName: file.name, mapping,
    business: rel?.business_id ?? null, kind: rel?.kind ?? null,
  });

  async function pickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setFileError(null);
    setPreview(null);
    setBatch(null);
    setError(null);
    if (f.size > MAX_BYTES) {
      setFile(null);
      setFileError(`That file is ${(f.size / 1024 / 1024).toFixed(1)} MB. Up to 5 MB at a time: split it and import the parts.`);
      return;
    }
    try {
      const text = await readFileText(f);
      const table = readTable(text, { maxRows: MAX_ROWS });
      if (!table.rows.length) throw new Error('That file has no rows under its header row.');
      const guess = detectMapping(table.headers);
      setFile({ name: f.name, text, headers: table.headers, sample: table.rows.slice(0, 3), rows: table.rows.length });
      setMapping(guess.mapping);
      setSource(guess.source);
      setChoices(new Map());
    } catch (err) {
      setFile(null);
      setFileError(err instanceof CsvError ? `That file has more than ${MAX_ROWS.toLocaleString('en-CA')} rows: split it and import the parts.` : (err.message || 'That file couldn’t be read as a CSV.'));
    }
  }

  async function runPreview() {
    setBusy('preview');
    setError(null);
    try {
      const p = await api.post('/api/crm/import/preview', request());
      setPreview(p);
      setChoices(new Map());
      setFilter('all');
      setShown(PAGE);
      return p;
    } catch (err) {
      setError(err.status === 0 ? 'Can’t reach the suite right now. Importing needs a connection.' : err.message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (busy) return;
    setBusy('commit');
    setError(null);
    pending.current ??= newId();
    const sent = {};
    for (const [row, c] of choices) sent[row] = c;
    try {
      const r = await api.post('/api/crm/import/commit', { ...request(), batchId: pending.current, choices: sent });
      setBatch(r.batch);
      let b = r.batch;
      while (b.status === 'running') {
        await new Promise((res) => setTimeout(res, 600));
        try {
          b = (await api.get(`/api/crm/import/batches/${b.id}`)).batch;
          setBatch(b);
        } catch (err) {
          if (err.status !== 0) throw err; // a blip: keep asking
        }
      }
      pending.current = null;
      setPreview(null);
      // Bring the new records onto this device now rather than at the next periodic sync.
      try { store.syncNow(); } catch { /* signed out meanwhile */ }
      await loadBatches();
    } catch (err) {
      if (err.status !== 0) pending.current = null; // refused: a new attempt is a new batch
      setError(err.status === 0 ? 'Lost the connection. Try again: the same import continues, nothing is made twice.' : err.message);
    } finally {
      setBusy(null);
    }
  }

  const rows = preview?.rows ?? [];
  const filtered = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
  const counts = useMemo(() => {
    const n = { create: 0, add: 0, skip: 0 };
    for (const r of rows) {
      const a = choices.get(r.row)?.action ?? r.action;
      if (r.status !== 'invalid') n[a] = (n[a] ?? 0) + 1;
    }
    return n;
  }, [rows, choices]);
  const choose = (row, action) => setChoices((cur) => new Map(cur).set(row.row, { action, status: row.status }));
  const relOptions = [
    ...RELATIONSHIP_CHOICES.filter((c) => pickable.has(c.business_id)).map((c) => ({ value: c.id, label: `${businessesById.get(c.business_id)?.name ?? ''} · ${KIND_LABELS[c.kind]}` })),
    { value: 'none', label: 'None (add relationships later)' },
  ];
  const columnOptions = [{ value: '', label: '— Not in this file —' }, ...(file?.headers ?? []).map((h, i) => ({ value: String(i), label: h }))];
  const sampleOf = (i) => (i === null || i === undefined ? null : file.sample.map((r) => r[i]).find((v) => v && v.trim()));
  const importLabel = counts.create || counts.add
    ? [counts.create ? `Import ${counts.create.toLocaleString('en-CA')} ${counts.create === 1 ? 'client' : 'clients'}` : null,
      counts.add ? `${counts.create ? '+ ' : 'Add to '}${counts.add} existing` : null].filter(Boolean).join(' ')
    : 'Nothing new to import';
  const done = batch && batch.status !== 'running';

  return (
    <>
      <PageHeader
        title="Import customers"
        subtitle="Your accounting customer list as a CSV. Nothing already here is changed or added twice."
        actions={<Link to="/crm" className="crm-link-button" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="back" size={16} />Clients</Link>}
      />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {offline ? (
          <Notice tone="warn"><span data-testid="imp-offline">You’re offline. Importing runs on the suite, so it needs a connection — <Link to="/crm/quick-add">Quick add</Link> works offline.</span></Notice>
        ) : null}

        <Card title="1 · Choose the file">
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              Export your customers as CSV from QuickBooks, Wave, Xero or FreshBooks (or any spreadsheet). Up to 5 MB and 10,000 rows.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
              <input ref={inputRef} id="imp-file" type="file" accept=".csv,text/csv,.txt" onChange={pickFile} className="imp-file" aria-label="CSV file" />
              <Button onClick={() => inputRef.current?.click()}><Icon name="upload" size={18} />{file ? 'Choose another file' : 'Choose a CSV file'}</Button>
              {file ? (
                <span style={{ fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' }} data-testid="imp-file-name">
                  <strong>{file.name}</strong> · {file.rows.toLocaleString('en-CA')} {file.rows === 1 ? 'row' : 'rows'}{source ? ` · looks like a ${source} export` : ''}
                </span>
              ) : null}
            </div>
            {fileError ? <Notice tone="danger">{fileError}</Notice> : null}
          </div>
        </Card>

        {file ? (
          <Card title="2 · Match the columns">
            <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
              <div className="imp-mapping">
                {MAPPING_FIELDS.map((f) => {
                  const sample = sampleOf(mapping?.[f.key]);
                  return (
                    <SelectField
                      key={f.key}
                      id={`map-${f.key}`}
                      label={f.label}
                      value={mapping?.[f.key] === null || mapping?.[f.key] === undefined ? '' : String(mapping[f.key])}
                      onChange={(v) => { setMapping((m) => ({ ...m, [f.key]: v === '' ? null : Number(v) })); setPreview(null); }}
                      options={columnOptions}
                      hint={sample ? `e.g. ${sample.length > 40 ? `${sample.slice(0, 40)}…` : sample}` : f.hint}
                    />
                  );
                })}
              </div>
              <SelectField
                id="imp-business"
                label="What our business does for these clients"
                hint="Each new client gets this relationship. Wholesale customers usually come from the Order Manager later."
                value={relChoice}
                onChange={(v) => { setRelChoice(v); setPreview(null); }}
                options={relOptions}
                style={{ maxWidth: 520 }}
              />
              <div>
                <Button variant="primary" onClick={runPreview} disabled={offline || busy !== null} data-testid="imp-preview">
                  {busy === 'preview' ? 'Checking…' : 'Preview'}
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        {error ? <Notice tone="danger">{error}</Notice> : null}

        {preview ? (
          <Card padded={false}>
            <h2 className="imp-card-title">3 · Check the preview</h2>
            <div style={{ padding: '0 var(--space-4) var(--space-3)', display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Show rows" data-testid="imp-counts">
              <button type="button" className="qa-chip" aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); setShown(PAGE); }}>All {preview.total.toLocaleString('en-CA')}</button>
              {Object.entries(STATUS).filter(([k]) => preview.counts[k]).map(([k, s]) => (
                <button key={k} type="button" className="qa-chip" aria-pressed={filter === k} data-filter={k} onClick={() => { setFilter(k); setShown(PAGE); }}>
                  {s.filter} {preview.counts[k].toLocaleString('en-CA')}
                </button>
              ))}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="qa-table imp-table" data-testid="imp-preview-table">
                <thead><tr><th>Row</th><th>Client / account</th><th>Contact</th><th>Address</th><th>What happens</th></tr></thead>
                <tbody>
                  {filtered.slice(0, shown).map((r) => (
                    <tr key={r.row} data-imp-row={r.row} data-status={r.status}>
                      <td className="qa-num">{r.row}</td>
                      <td>
                        <strong style={{ overflowWrap: 'anywhere' }}>{r.client.name ?? '—'}</strong>
                        {r.account.name && r.account.name !== r.client.name ? <div className="qa-sub">{r.account.name}</div> : null}
                        {r.client.tags ? <div className="qa-sub">Tags: {r.client.tags}</div> : null}
                      </td>
                      <td style={{ overflowWrap: 'anywhere' }}>{contactText(r.contact)}</td>
                      <td className="qa-sub" style={{ overflowWrap: 'anywhere' }}>{r.account.address ?? '—'}</td>
                      <td><RowStatus row={r} choice={choices.get(r.row)?.action} onChoose={choose} businessesById={businessesById} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length > shown ? (
              <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--border)' }}>
                <Button onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, filtered.length - shown)} more</Button>
                <span className="qa-sub">{shown} of {filtered.length.toLocaleString('en-CA')}</span>
              </div>
            ) : null}
            <div className="qa-savebar" style={{ padding: 'var(--space-3) var(--space-4)', background: 'var(--surface)', borderRadius: '0 0 var(--radius-lg) var(--radius-lg)' }}>
              <Button variant="primary" onClick={commit} disabled={offline || busy !== null || !(counts.create + counts.add)} data-testid="imp-commit">
                {busy === 'commit' ? 'Importing…' : importLabel}
              </Button>
              {counts.skip ? <span className="qa-sub">{counts.skip.toLocaleString('en-CA')} skipped</span> : null}
              {preview.counts.invalid ? <span className="qa-sub">{preview.counts.invalid} can’t be imported</span> : null}
            </div>
          </Card>
        ) : null}

        {batch && batch.status === 'running' ? <Card><Progress batch={batch} /></Card> : null}
        {done ? (
          <Notice tone={batch.status === 'done' && !batch.failed ? 'ok' : 'warn'}>
            <span data-testid="imp-result">
              {batch.status === 'done' ? 'Imported' : batch.status === 'interrupted' ? 'Stopped part-way' : 'The import failed'}: {batchSummary(batch)}.
              {batch.failed ? ` Rows that failed: ${batch.problems.map((p) => `${p.row} (${p.reason})`).join(', ')}.` : ''}
              {batch.error ? ` ${batch.error}` : ''}
            </span>{' '}
            <Link to="/crm">See your clients</Link>
          </Notice>
        ) : null}

        <PastImports batches={batches} me={me} />
      </div>
    </>
  );
}
