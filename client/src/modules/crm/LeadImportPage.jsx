import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { newId } from '@suite/shared/ids';
import { PageHeader, Card, Button, Badge, Notice, Icon } from '../../ui/index.js';
import { api } from '../../api/client.js';
import { store, useSyncStatus } from '../../sync/index.js';
import CrmTabs from './CrmTabs.jsx';
import './crm.css';

// Import leads (/crm/import-leads, D8b): a research / outreach export as a CSV (company_name is the
// one column it needs) becomes leads in Great White North Design's pipeline. The file is sent as text;
// the preview and the import run on the server (POST /api/crm/leads/import/preview and /commit), which
// writes through sync.applyLocal — so this page needs a connection. Nothing existing is changed; rows
// already imported, already in the pipeline or already clients are skipped.

const MAX_BYTES = 5 * 1024 * 1024;
const PAGE = 50;

const STATUS = {
  new: { tone: 'ok', label: 'New', filter: 'New' },
  exists: { tone: 'warn', label: 'Already in the pipeline', filter: 'In pipeline' },
  client: { tone: 'warn', label: 'Already a client', filter: 'Clients' },
  imported: { tone: 'neutral', label: 'Imported before', filter: 'Imported before' },
  duplicate: { tone: 'neutral', label: 'Repeated in this file', filter: 'Repeated' },
  invalid: { tone: 'danger', label: 'Can’t import', filter: 'Problems' },
};

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

const n = (v) => (v ?? 0).toLocaleString('en-CA');

function summary(b) {
  const parts = [`${n(b.imported)} ${b.imported === 1 ? 'lead' : 'leads'} added`];
  if (b.lost) parts.push(`${n(b.lost)} of them marked lost`);
  if (b.tasks) parts.push(`${n(b.tasks)} next ${b.tasks === 1 ? 'step' : 'steps'}`);
  parts.push(`${n(b.skipped)} skipped`);
  if (b.failed) parts.push(`${n(b.failed)} failed`);
  return parts.join(' · ');
}

export default function LeadImportPage() {
  const offline = useOffline();
  const [file, setFile] = useState(null); // { name, text }
  const [fileError, setFileError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [filter, setFilter] = useState('all');
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState(null); // 'preview' | 'commit'
  const [error, setError] = useState(null);
  const [batch, setBatch] = useState(null);
  const pending = useRef(null); // the batch id of a commit not yet confirmed (a retry re-uses it)
  const inputRef = useRef(null);

  async function pickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    pending.current = null; // another file is another import
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
      setFile({ name: f.name, text: await readFileText(f) });
    } catch {
      setFile(null);
      setFileError('That file couldn’t be read.');
    }
  }

  async function runPreview() {
    pending.current = null;
    setBusy('preview');
    setError(null);
    setBatch(null);
    try {
      const p = await api.post('/api/crm/leads/import/preview', { text: file.text, fileName: file.name });
      setPreview(p);
      setFilter('all');
      setShown(PAGE);
    } catch (err) {
      setPreview(null);
      setError(err.status === 0 ? 'Can’t reach the suite right now. Importing needs a connection.' : err.message);
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (busy) return;
    setBusy('commit');
    setError(null);
    pending.current ??= newId();
    try {
      const r = await api.post('/api/crm/leads/import/commit', { batchId: pending.current, text: file.text, fileName: file.name });
      pending.current = null;
      setBatch(r.batch);
      setPreview(null);
      try { store.syncNow(); } catch { /* signed out meanwhile */ }
    } catch (err) {
      if (err.status !== 0) pending.current = null; // refused: a new attempt is a new batch
      setError(err.status === 0 ? 'Lost the connection. Try again: the same import continues, nothing is made twice.' : err.message);
    } finally {
      setBusy(null);
    }
  }

  const rows = preview?.rows ?? [];
  const filtered = useMemo(() => (filter === 'all' ? rows : rows.filter((r) => r.status === filter)), [rows, filter]);
  const newCount = preview?.counts?.new ?? 0;

  return (
    <>
      <PageHeader
        title="Import leads"
        subtitle="A research or outreach CSV, as leads for Great White North Design. Nothing already here is changed or added twice."
        actions={<Link to="/crm/pipeline" className="crm-link-button" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="back" size={16} />Pipeline</Link>}
      />
      <CrmTabs />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {offline ? (
          <Notice tone="warn"><span data-testid="lead-imp-offline">You’re offline. Importing runs on the suite, so it needs a connection.</span></Notice>
        ) : null}

        <Card title="1 · Choose the file">
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              One row per prospect; the only column it needs is <strong>company_name</strong>. Email, phone, city, research notes, the outreach stage and a value
              are used when they’re there. Up to 5 MB and 2,000 rows.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
              <input ref={inputRef} type="file" accept=".csv,text/csv,.txt" onChange={pickFile} className="imp-file" aria-label="CSV file" />
              <Button onClick={() => inputRef.current?.click()}><Icon name="upload" size={18} />{file ? 'Choose another file' : 'Choose a CSV file'}</Button>
              {file ? <span style={{ fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' }} data-testid="lead-imp-file"><strong>{file.name}</strong></span> : null}
            </div>
            {fileError ? <Notice tone="danger">{fileError}</Notice> : null}
            {file ? (
              <div>
                <Button variant="primary" onClick={runPreview} disabled={offline || busy !== null} data-testid="lead-imp-preview">
                  {busy === 'preview' ? 'Checking…' : 'Preview'}
                </Button>
              </div>
            ) : null}
          </div>
        </Card>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        {preview ? (
          <Card padded={false}>
            <h2 className="imp-card-title">2 · Check the preview</h2>
            <div style={{ padding: '0 var(--space-4) var(--space-3)', display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 'var(--text-sm)' }} data-testid="lead-imp-notes">
                {n(newCount)} new {newCount === 1 ? 'lead' : 'leads'} as <strong>Lead</strong> in Great White North Design, source Outreach.
                {preview.alreadyEmailed ? ` ${n(preview.alreadyEmailed)} already emailed (kept as an email entry on the lead’s timeline).` : ''}
                {preview.willBeLost ? ` ${n(preview.willBeLost)} marked do-not-email in the file will be added as Lost (not a fit).` : ''}
                {preview.willMakeTasks ? ` ${n(preview.willMakeTasks)} with a follow-up date get a next-step task.` : ''}
              </span>
              {newCount - (preview.willMakeTasks ?? 0) > 0 ? (
                <span className="qa-sub">The rest will show as “No next step” on Today and the pipeline until you give them a dated next step.</span>
              ) : null}
              {preview.rowsWithWarnings ? <span className="qa-sub">{n(preview.rowsWithWarnings)} rows have a value that couldn’t be stored as a field (a bad phone or email): it’s kept in the lead’s notes.</span> : null}
            </div>
            <div style={{ padding: '0 var(--space-4) var(--space-3)', display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Show rows" data-testid="lead-imp-counts">
              <button type="button" className="qa-chip" aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); setShown(PAGE); }}>All {n(preview.total)}</button>
              {Object.entries(STATUS).filter(([k]) => preview.counts[k]).map(([k, s]) => (
                <button key={k} type="button" className="qa-chip" aria-pressed={filter === k} data-filter={k} onClick={() => { setFilter(k); setShown(PAGE); }}>
                  {s.filter} {n(preview.counts[k])}
                </button>
              ))}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="qa-table imp-table" data-testid="lead-imp-table">
                <thead><tr><th>Row</th><th>Lead</th><th>Contact</th><th>What happens</th></tr></thead>
                <tbody>
                  {filtered.slice(0, shown).map((r) => {
                    const s = STATUS[r.status] ?? STATUS.invalid;
                    return (
                      <tr key={r.row} data-imp-row={r.row} data-status={r.status}>
                        <td className="qa-num">{r.row}</td>
                        <td><strong style={{ overflowWrap: 'anywhere' }}>{r.name ?? '—'}</strong></td>
                        <td className="qa-sub" style={{ overflowWrap: 'anywhere' }}>{[r.email, r.phone].filter(Boolean).join(' · ') || '—'}</td>
                        <td>
                          <div style={{ display: 'grid', gap: 4, justifyItems: 'start' }}>
                            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 'var(--text-sm)' }}>
                              <Badge tone={s.tone}>{s.label}</Badge>
                              {r.status === 'new' && r.stage === 'lost' ? <Badge tone="warn">Lost</Badge> : null}
                              {r.status === 'new' && r.emailed ? <Badge>Emailed</Badge> : null}
                              {r.reason ? <span style={{ color: r.status === 'invalid' ? 'var(--danger)' : 'var(--text-muted)' }}>{r.reason}</span> : null}
                            </span>
                            {r.nextStep ? <span className="qa-sub">Next step {r.nextStep}</span> : null}
                            {r.warnings?.length ? <ul className="qa-warnings">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filtered.length > shown ? (
              <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--border)' }}>
                <Button onClick={() => setShown((c) => c + PAGE)}>Show {Math.min(PAGE, filtered.length - shown)} more</Button>
                <span className="qa-sub">{shown} of {n(filtered.length)}</span>
              </div>
            ) : null}
            <div className="qa-savebar" style={{ padding: 'var(--space-3) var(--space-4)', background: 'var(--surface)', borderRadius: '0 0 var(--radius-lg) var(--radius-lg)' }}>
              <Button variant="primary" onClick={commit} disabled={offline || busy !== null || !newCount} data-testid="lead-imp-commit">
                {busy === 'commit' ? 'Importing…' : newCount ? `Import ${n(newCount)} ${newCount === 1 ? 'lead' : 'leads'}` : 'Nothing new to import'}
              </Button>
              {preview.total - newCount ? <span className="qa-sub">{n(preview.total - newCount)} skipped</span> : null}
            </div>
          </Card>
        ) : null}

        {batch ? (
          <Notice tone={batch.failed ? 'warn' : 'ok'}>
            <span data-testid="lead-imp-result">
              Imported: {summary(batch)}.
              {batch.failed ? ` Rows that failed: ${batch.problems.map((p) => `${p.row} (${p.reason})`).join(', ')}.` : ''}
            </span>{' '}
            <Link to="/crm/pipeline">See the pipeline</Link>
          </Notice>
        ) : null}
      </div>
    </>
  );
}
