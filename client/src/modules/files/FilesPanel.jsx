// The list of files with its buttons (D10), used on a client's Files tab, the client page's Files card
// and inside a task's sheet. Links and password pointers are saved on the device (offline, like any
// record); uploading and opening an upload need a connection — the panel says so instead of failing.
// Inside a task sheet the panel sits in that sheet's <form>: nothing here is a <form>, every button is
// type="button", and Enter in a field saves this panel's entry instead of the task.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Badge, Notice, TextField, TextAreaField, Icon } from '../../ui/index.js';
import { store, useSyncStatus } from '../../sync/index.js';
import { SyncBadges } from '../../sync/components.jsx';
import { api } from '../../api/client.js';
import { FILE_ACCEPT, ALLOWED_TEXT, sizeText, FILE_KIND_LABELS } from '@suite/shared/files';
import { RecordSync, TextButton, useAction } from '../crm/parts.jsx';
import { actorLabel } from '../crm/logic.js';
import { formatDay } from '../../ui/format.js';
import { useAuth } from '../../auth/session.jsx';
import {
  PAGE, KIND_ICONS, fileDetail, whereText, downloadHref, canShow, isImage, entryValues, entryFields, entryChanges,
  looksLikeSecret, uploadProblem, uploadErrorText,
} from './logic.js';
import { uploadFile } from './upload.js';
import './files.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

/** Offline: the browser says so, or the sync engine can't reach the suite. */
export function useOffline() {
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

/** Enter in a single-line field saves this entry (never the task sheet's form around it). */
const enterSaves = (save) => (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    save();
  }
};

function EntryFields({ kind, v, set, problems, onEnter, idPrefix }) {
  const id = (k) => `${idPrefix}-${k}`;
  return (
    <>
      {kind === 'link' ? (
        <TextField id={id('url')} label="Address" value={v.url} onChange={set('url')} error={problems.url} inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="https://drive.google.com/…" onKeyDown={onEnter} />
      ) : null}
      {kind === 'password' ? (
        <>
          <Notice tone="info">Only <strong>where</strong> to find it: the password manager and the item’s name. Never the password itself.</Notice>
          <TextField id={id('vault')} label="Password manager or vault (optional)" value={v.vault} onChange={set('vault')} error={problems.vault} placeholder="1Password · Business" onKeyDown={onEnter} />
          <TextField id={id('item')} label="Item to look for" value={v.vault_item} onChange={set('vault_item')} error={problems.vault_item} placeholder="Lefty’s — WordPress admin" onKeyDown={onEnter} autoCapitalize="off" autoComplete="off" />
          <TextField id={id('url')} label="Sign-in page (optional)" value={v.url} onChange={set('url')} error={problems.url} inputMode="url" autoCapitalize="off" autoCorrect="off" onKeyDown={onEnter} />
        </>
      ) : null}
      <TextField id={id('name')} label={kind === 'upload' ? 'Name' : 'Name (optional)'} value={v.name} onChange={set('name')} error={problems.name} onKeyDown={onEnter} maxLength={150} />
      <TextAreaField id={id('notes')} label="Notes (optional)" value={v.notes} onChange={set('notes')} error={problems.notes} rows={2} />
      {kind === 'password' && looksLikeSecret(v) ? (
        <Notice tone="warn">That looks like a password. Keep passwords in the password manager only.</Notice>
      ) : null}
    </>
  );
}

/** Add a link or a password pointer (offline-friendly: a synced record). */
function NewEntry({ kind, owner, onDone }) {
  const [v, setV] = useState(() => entryValues(kind));
  const [problems, setProblems] = useState({});
  const { busy, error, run } = useAction();
  const made = useRef(null); // saved once: a retry never makes a second
  const set = (k) => (e) => setV((cur) => ({ ...cur, [k]: e.target.value }));
  const save = async () => {
    if (busy) return;
    const r = entryFields(v);
    setProblems(r.problems);
    if (Object.keys(r.problems).length) return;
    const ok = await run(async () => {
      if (!made.current) made.current = await store.create('file', { kind, [owner.field]: owner.id, ...r.fields });
    });
    if (ok) onDone();
  };
  return (
    <div className="files-entry" data-testid={`files-new-${kind}`}>
      <strong>{kind === 'link' ? 'Add a link' : 'Add a password pointer'}</strong>
      <EntryFields kind={kind} v={v} set={set} problems={problems} onEnter={enterSaves(save)} idPrefix={`files-new-${kind}`} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="files-actions">
        <Button variant="primary" onClick={save} disabled={busy}>Save</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function EditEntry({ file, onDone }) {
  const [start] = useState(() => entryValues(file.kind, file));
  const [v, setV] = useState(start);
  const [problems, setProblems] = useState({});
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setV((cur) => ({ ...cur, [k]: e.target.value }));
  const save = async () => {
    if (busy) return;
    const r = entryChanges(file, start, v);
    setProblems(r.problems);
    if (Object.keys(r.problems).length) return;
    if (await run(async () => { if (Object.keys(r.fields).length) await store.update('file', file.id, r.fields); })) onDone();
  };
  const remove = async () => {
    if (await run(() => store.remove('file', file.id))) onDone();
  };
  return (
    <div className="files-entry" data-testid="files-edit">
      <EntryFields kind={file.kind} v={v} set={set} problems={problems} onEnter={enterSaves(save)} idPrefix={`files-edit-${file.id}`} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {confirming ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <Notice tone="warn">
            Delete “{file.name}”? It goes from both of your devices.
            {file.kind === 'upload' ? ' Its contents are kept 30 days, then removed (backups made before then still have it).' : ''}
          </Notice>
          <div className="files-actions">
            <Button variant="danger" onClick={remove} disabled={busy}>Delete</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Keep it</Button>
          </div>
        </div>
      ) : (
        <div className="files-actions">
          <Button variant="primary" onClick={save} disabled={busy}>Save</Button>
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
          <Button variant="ghost" style={{ marginLeft: 'auto', color: 'var(--danger)' }} onClick={() => setConfirming(true)}>Delete…</Button>
        </div>
      )}
    </div>
  );
}

/** An image shown in the app (same origin, so the session's cookie goes with it). */
function ImageViewer({ file, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="files-viewer" role="dialog" aria-modal="true" aria-label={file.name} onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid="files-viewer">
      <div className="files-viewer-bar">
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{file.name}</span>
        <a className="files-viewer-button" href={downloadHref(file.id)} download="">Download</a>
        <button type="button" className="files-viewer-button" onClick={onClose} aria-label="Close"><Icon name="close" size={20} /></button>
      </div>
      <img src={downloadHref(file.id, { show: true })} alt={file.name} />
    </div>
  );
}

function FileRow({ item, showWhere, accountsById, tasksById, offline, me, onView }) {
  const { file, where } = item;
  const [editing, setEditing] = useState(false);
  const who = file._sync?.createdBy ? actorLabel(file._sync.createdBy, me) : null;
  const when = file._sync?.createdAt ? formatDay(file._sync.createdAt) : null;
  const local = file._sync?.local;
  const title = (() => {
    if (file.kind === 'link') return <a href={file.url} target="_blank" rel="noopener noreferrer">{file.name}</a>;
    if (file.kind === 'upload' && !offline && !local) return <a href={downloadHref(file.id)} download="">{file.name}</a>;
    return <span>{file.name}</span>;
  })();
  return (
    <li className="files-row" data-file-id={file.id} data-kind={file.kind}>
      <span className="files-icon" aria-hidden="true"><Icon name={KIND_ICONS[file.kind] ?? 'note'} size={18} /></span>
      <div style={{ minWidth: 0, display: 'grid', gap: 2 }}>
        <div className="files-name">{title}</div>
        <div style={muted}>
          {[FILE_KIND_LABELS[file.kind] === 'File' ? null : FILE_KIND_LABELS[file.kind], fileDetail(file), showWhere ? whereText(where, { accountsById, tasksById }) : null, [who, when].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
        </div>
        {where?.on === 'task' && showWhere ? (
          <Link to={`/tasks?open=${where.taskId}`} style={{ ...muted, width: 'fit-content' }}>Open the task</Link>
        ) : null}
        {file.kind === 'password' && file.url ? <a href={file.url} target="_blank" rel="noopener noreferrer" style={{ ...muted, width: 'fit-content' }}>Open the sign-in page</a> : null}
        {file.notes ? <p className="files-notes">{file.notes}</p> : null}
        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}><SyncBadges record={file} /></span>
        <RecordSync record={file} what="file" />
        {editing ? <EditEntry file={file} onDone={() => setEditing(false)} /> : null}
      </div>
      {!editing ? (
        <div className="files-row-actions">
          {file.kind === 'upload' && canShow(file) && !offline && !local ? (
            isImage(file)
              ? <TextButton onClick={() => onView(file)}>View</TextButton>
              : <a className="files-text-link" href={downloadHref(file.id, { show: true })} target="_blank" rel="noopener">Open</a>
          ) : null}
          <TextButton onClick={() => setEditing(true)} aria-label={`Edit ${file.name}`}>Edit</TextButton>
        </div>
      ) : null}
    </li>
  );
}

/**
 * @param {{
 *   owner: { field: 'client_id'|'account_id'|'task_id', id: string },   where new files go
 *   items: { file, where }[],                                            what to list (newest first)
 *   showWhere?: boolean, accountsById?: Map, tasksById?: Map,
 *   limit?: number, moreLink?: string, emptyText?: string, testId?: string,
 * }} props
 */
export function FilesPanel({ owner, items, showWhere = false, accountsById = new Map(), tasksById = new Map(), limit = null, moreLink = null, emptyText = 'No files yet.', testId = 'files' }) {
  const offline = useOffline();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const [adding, setAdding] = useState(null);
  const [uploads, setUploads] = useState([]); // { key, file, name, progress, error, done }
  const [shown, setShown] = useState(limit ?? PAGE);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [usage, setUsage] = useState(null);
  const picker = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    if (offline) return;
    api.get('/api/files/usage').then(setUsage, () => {});
  }, [offline]);

  // An upload's row goes once its record is on this device (pulled after the upload).
  const listed = useMemo(() => new Set(items.map((i) => i.file.id)), [items]);
  useEffect(() => {
    setUploads((cur) => (cur.some((u) => u.done && listed.has(u.id)) ? cur.filter((u) => !(u.done && listed.has(u.id))) : cur));
  }, [listed]);

  const patch = (key, p) => setUploads((cur) => cur.map((u) => (u.key === key ? { ...u, ...p } : u)));

  const send = useCallback(async (files, existing = null) => {
    let room = usage;
    for (const file of files) {
      const key = existing ?? `u${seq.current++}`;
      const problem = uploadProblem(file, room);
      if (existing) patch(key, { error: problem, progress: 0 });
      else setUploads((cur) => [...cur, { key, file, name: file.name, progress: 0, error: problem, done: false }]);
      if (problem) continue;
      // eslint-disable-next-line no-await-in-loop
      const r = await uploadFile({ file, owner, onProgress: (p) => patch(key, { progress: p }) });
      if (r.status === 200 || r.status === 201) {
        patch(key, { done: true, progress: 1, id: r.id });
        room = room ? { ...room, usedBytes: room.usedBytes + (r.status === 201 ? file.size : 0) } : room;
        setUsage(room);
        store.syncNow().catch(() => {});
      } else {
        patch(key, { error: uploadErrorText(r.status, r.body) });
      }
    }
  }, [owner, usage]);

  const pick = (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (files.length) send(files);
  };
  const drop = (e) => {
    e.preventDefault();
    setDragging(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    if (offline) {
      setUploads((cur) => [...cur, ...files.map((f) => ({ key: `u${seq.current++}`, file: f, name: f.name, progress: 0, error: 'Uploading needs a connection: try again when you’re back online.', done: false }))]);
      return;
    }
    send(files);
  };
  const dragOver = (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };

  const rows = items.slice(0, shown);
  return (
    <div
      className={`files-panel${dragging ? ' files-dragging' : ''}`}
      data-testid={testId}
      onDragOver={dragOver}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget) || setDragging(false)}
      onDrop={drop}
    >
      <div className="files-actions">
        <Button variant="primary" onClick={() => picker.current?.click()} disabled={offline} data-testid="files-upload">
          <Icon name="upload" size={16} />Upload
        </Button>
        <Button onClick={() => setAdding('link')} disabled={adding === 'link'}><Icon name="link" size={16} />Add link</Button>
        <Button onClick={() => setAdding('password')} disabled={adding === 'password'}><Icon name="key" size={16} />Password pointer</Button>
        <input ref={picker} type="file" multiple accept={FILE_ACCEPT} onChange={pick} hidden data-testid="files-input" />
      </div>
      <p style={{ ...muted, margin: 0 }}>
        {offline
          ? 'Uploading and opening files need a connection. Links and password pointers can be added now.'
          : `Drop files here or use Upload: ${ALLOWED_TEXT}${usage ? `, up to ${sizeText(usage.maxFileBytes)} each (${sizeText(usage.usedBytes)} of ${sizeText(usage.maxTotalBytes)} used)` : ''}.`}
      </p>
      {adding ? <NewEntry key={adding} kind={adding} owner={owner} onDone={() => setAdding(null)} /> : null}
      {uploads.length ? (
        <ul className="files-list" data-testid="files-uploads">
          {uploads.map((u) => (
            <li key={u.key} className="files-row" data-upload={u.name}>
              <span className="files-icon" aria-hidden="true"><Icon name="upload" size={18} /></span>
              <div style={{ minWidth: 0, display: 'grid', gap: 4 }}>
                <div className="files-name">{u.name}</div>
                {u.error ? (
                  <Notice tone="danger">{u.error}</Notice>
                ) : u.done ? (
                  <span style={muted}>Uploaded</span>
                ) : (
                  <progress max="1" value={u.progress} aria-label={`Uploading ${u.name}`} style={{ width: '100%' }} />
                )}
              </div>
              <div className="files-row-actions">
                {u.error && !offline ? <TextButton onClick={() => send([u.file], u.key)}>Try again</TextButton> : null}
                {u.error || u.done ? <TextButton onClick={() => setUploads((cur) => cur.filter((x) => x.key !== u.key))} aria-label={`Dismiss ${u.name}`}>Dismiss</TextButton> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length ? (
        <ul className="files-list" data-testid={`${testId}-list`}>
          {rows.map((item) => (
            <FileRow key={item.file.id} item={item} showWhere={showWhere} accountsById={accountsById} tasksById={tasksById} offline={offline} me={me} onView={setViewing} />
          ))}
        </ul>
      ) : (!uploads.length ? <p style={{ ...muted, margin: 0 }}>{emptyText}</p> : null)}
      <div className="files-actions">
        {items.length > shown && !moreLink ? (
          <TextButton style={{ paddingLeft: 0 }} onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, items.length - shown)} more ({shown} of {items.length})</TextButton>
        ) : null}
        {moreLink && items.length > shown ? <Link to={moreLink} style={{ ...muted, minHeight: 'var(--tap)', display: 'inline-flex', alignItems: 'center' }}>All {items.length} files</Link> : null}
      </div>
      {dragging ? <div className="files-drop-hint" aria-hidden="true"><Badge tone="accent">Drop to upload</Badge></div> : null}
      {viewing ? <ImageViewer file={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
