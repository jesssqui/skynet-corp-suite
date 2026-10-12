// Files (D10): registers the synced `file` record type (with the module's own check), keeps the bytes
// of uploads in its own tables (files_blobs + files_chunks), and answers the upload and download
// routes. It reads and writes only its own tables; whether a client, account or task is live is
// asked of the crm and planner services. Records are written through sync (devices' steps, or
// sync.applyLocal from the upload route) — the sync module's guard makes any other write fail.
import crypto from 'node:crypto';
import { newId, isId } from '@suite/shared/ids';
import {
  fileTypeOf, magicMatches, cleanFileName, cleanUrl, fileOwner, sizeText, ALLOWED_TEXT, FILE_NOTES_MAX,
} from '@suite/shared/files';
import { HttpError } from '../../lib/httpError.js';
import { FILE_ENTITY, BLOB_FIELDS, FIXED_FIELDS } from './entities.js';

export const CHUNK_BYTES = 512 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const has = (fields, k) => Object.hasOwn(fields, k) && fields[k] !== null && fields[k] !== undefined;
const refuse = (reason, code = 'invalid_value') => ({ code, reason });

/**
 * The module's sync check (only the step's own values and the row before it, so it is right in any
 * arrival order). `blobExists(id)` reads files_blobs (this module's own table).
 */
export function makeCheckFile(blobExists) {
  return function checkFile({ op, fields, current, server }) {
    if (op === 'delete' || !fields) return null;
    if (op === 'create') {
      if (!fileOwner(fields)) return refuse('A file belongs to exactly one client, account or task');
      if (!String(fields.name ?? '').trim()) return refuse('name: required');
      if (fields.kind === 'upload') {
        if (!server) return refuse('Files are uploaded with the Upload button (it needs a connection)', 'op_not_allowed');
        if (!BLOB_FIELDS.every((k) => has(fields, k)) || !blobExists(fields.blob_id)) return refuse('An upload needs its stored file');
        return null;
      }
      if (BLOB_FIELDS.some((k) => has(fields, k))) return refuse('Only uploads have stored bytes');
      return checkKindFields(fields.kind, fields, { creating: true });
    }
    // update
    for (const k of [...FIXED_FIELDS, ...BLOB_FIELDS]) {
      if (Object.hasOwn(fields, k)) return refuse(`${k}: can't be changed (add it again where it belongs instead)`);
    }
    if (Object.hasOwn(fields, 'name') && !String(fields.name ?? '').trim()) return refuse('name: required');
    return checkKindFields(current?.kind, fields, { creating: false });
  };
}

function checkKindFields(kind, fields, { creating }) {
  if (Object.hasOwn(fields, 'url') && fields.url !== null && cleanUrl(fields.url) !== fields.url) {
    return refuse('url: an http or https address, with no password in it');
  }
  if (kind === 'link') {
    if ((creating || Object.hasOwn(fields, 'url')) && !has(fields, 'url')) return refuse('url: a link needs its address');
    if (has(fields, 'vault') || has(fields, 'vault_item')) return refuse('vault: only for password pointers');
  } else if (kind === 'password') {
    if (creating && !has(fields, 'vault_item')) return refuse('vault_item: which item in the password manager');
    if (!creating && Object.hasOwn(fields, 'vault_item') && !has(fields, 'vault_item')) return refuse('vault_item: which item in the password manager');
  } else if (kind === 'upload') {
    if (has(fields, 'url') || has(fields, 'vault') || has(fields, 'vault_item')) return refuse('An uploaded file has no address or vault');
  }
  return null;
}

/** "X-File-Info" (encodeURIComponent of JSON): { id, name, clientId | accountId | taskId, notes? }. */
export function parseUploadInfo(header) {
  const bad = (msg) => new HttpError(400, msg, undefined, { code: 'bad_info' });
  if (!header || header.length > 8192) throw bad('Say which file this is (X-File-Info)');
  let info;
  try {
    info = JSON.parse(decodeURIComponent(header));
  } catch {
    throw bad('X-File-Info is not readable');
  }
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw bad('X-File-Info is not readable');
  if (!isId(info.id)) throw bad('id: a UUIDv7 made on the device');
  const owner = fileOwner({ client_id: info.clientId ?? null, account_id: info.accountId ?? null, task_id: info.taskId ?? null });
  if (!owner || !isId(owner.id)) throw bad('Name exactly one client, account or task');
  if (typeof info.name !== 'string' || !info.name.trim()) throw bad('name: the file’s name');
  const notes = typeof info.notes === 'string' && info.notes.trim() ? info.notes.trim().slice(0, FILE_NOTES_MAX) : null;
  return { id: info.id, name: info.name, owner, notes };
}

export function createFilesService({ db, config, services, log, now = Date.now }) {
  const { sync, crm, planner } = services;
  if (!sync) throw new Error('files needs the sync module registered before it (modules/index.js)');
  // Its files belong to clients, accounts and tasks: without the crm and the planner (the sync engine's own
  // tests run without them) the module stays off — no record type, and its routes answer 503.
  if (!crm || !planner) return disabledService();
  const limits = config.files;

  const q = {
    blob: db.prepare('SELECT * FROM files_blobs WHERE id = ?'),
    blobExists: db.prepare('SELECT 1 FROM files_blobs WHERE id = ?').pluck(),
    insertBlob: db.prepare('INSERT INTO files_blobs (id, size, sha256, chunks, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)'),
    insertChunk: db.prepare('INSERT INTO files_chunks (blob_id, n, data) VALUES (?, ?, ?)'),
    chunk: db.prepare('SELECT data FROM files_chunks WHERE blob_id = ? AND n = ?').pluck(),
    used: db.prepare('SELECT coalesce(sum(size), 0) AS bytes, count(*) AS n FROM files_blobs'),
    record: db.prepare('SELECT * FROM files_items WHERE id = ?'),
    counts: db.prepare(`SELECT kind, count(*) AS n FROM files_items WHERE deleted_at IS NULL GROUP BY kind`),
    // Blobs to purge: their record deleted more than purgeDays ago, or no record names them at all.
    purgeable: db.prepare(`SELECT b.id FROM files_blobs b
      WHERE NOT EXISTS (SELECT 1 FROM files_items i WHERE i.blob_id = b.id AND (i.deleted_at IS NULL OR i.deleted_at > ?))
        AND b.created_at < ?`).pluck(),
    deleteBlob: db.prepare('DELETE FROM files_blobs WHERE id = ?'),
  };

  sync.registerEntity({ module: 'files', ...FILE_ENTITY, check: makeCheckFile((id) => Boolean(q.blobExists.get(id))) });

  const iso = (ms = now()) => new Date(ms).toISOString();

  /** Is the record's owner (and its chain) live? */
  function ownerLive(row) {
    if (row.client_id) return Boolean(crm.liveRecord('client', row.client_id));
    if (row.account_id) return Boolean(crm.liveAccount(row.account_id));
    if (row.task_id) return Boolean(planner.taskState(row.task_id)?.live);
    return false;
  }

  function usage() {
    const { bytes, n } = q.used.get();
    return { usedBytes: bytes, blobs: n, maxFileBytes: limits.maxFileBytes, maxTotalBytes: limits.maxTotalBytes, purgeDays: limits.purgeDays };
  }

  /**
   * Delete the bytes of files deleted more than purgeDays ago (and any blob no record names — none
   * should exist: a blob and its record are written in one transaction; a minute's grace covers an
   * upload in progress). Returns how many were purged. Runs at start and before each upload.
   */
  function purge() {
    const t = now();
    const ids = q.purgeable.all(iso(t - limits.purgeDays * DAY_MS), iso(t - 60_000));
    if (!ids.length) return 0;
    db.transaction(() => { for (const id of ids) q.deleteBlob.run(id); })();
    log?.info?.(`purged the stored bytes of ${ids.length} deleted file(s)`);
    return ids.length;
  }

  /**
   * Everything that can be refused from the headers alone, before any of the body is read:
   * the type (by extension), the size, the space left, and the owner being live.
   * Returns { existing } when this id was uploaded before (a retry: no quota check).
   */
  function precheck({ id, name, owner, size }) {
    const type = fileTypeOf(cleanFileName(name));
    if (!type) {
      throw new HttpError(415, `That kind of file can’t be added here. Allowed: ${ALLOWED_TEXT}.`, undefined, { code: 'type_not_allowed' });
    }
    if (!(size > 0)) throw new HttpError(400, 'That file is empty', undefined, { code: 'empty' });
    if (size > limits.maxFileBytes) {
      throw new HttpError(413, `Files can be at most ${sizeText(limits.maxFileBytes)} (this one is ${sizeText(size)})`, undefined, { code: 'too_big' });
    }
    const existing = q.record.get(id);
    if (existing) {
      if (existing.kind !== 'upload') throw new HttpError(409, 'That id is already used', undefined, { code: 'exists' });
      return { existing, type };
    }
    if (!ownerLive({ [owner.field]: owner.id })) {
      throw new HttpError(404, 'The client, account or task this file was for isn’t here any more', undefined, { code: 'owner_not_found' });
    }
    purge();
    const { usedBytes } = usage();
    if (usedBytes + size > limits.maxTotalBytes) {
      throw new HttpError(413, `No room left: the suite keeps at most ${sizeText(limits.maxTotalBytes)} of files (${sizeText(usedBytes)} used). Delete some first.`, undefined, { code: 'no_space' });
    }
    return { existing: null, type };
  }

  /** Store the bytes and make the record, in one transaction. → { file, created } */
  function store({ id, name, owner, notes, bytes, actor }) {
    const clean = cleanFileName(name);
    const type = fileTypeOf(clean);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const existing = q.record.get(id);
    if (existing) {
      // The same upload sent again (its answer was lost): the same answer. Anything else under that id: refused.
      if (existing.kind === 'upload' && existing.sha256 === sha256 && existing[owner.field] === owner.id) {
        return { file: recordView(existing), created: false };
      }
      throw new HttpError(409, 'That id is already used by another file', undefined, { code: 'exists' });
    }
    if (!magicMatches(clean, bytes)) {
      throw new HttpError(422, `That file isn’t really a .${type.ext} file (its contents don’t match its name)`, undefined, { code: 'type_mismatch' });
    }
    const result = db.transaction(() => {
      const blobId = newId();
      const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
      q.insertBlob.run(blobId, bytes.length, sha256, chunks, iso(), actor);
      for (let n = 0; n < chunks; n++) q.insertChunk.run(blobId, n, bytes.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES));
      const r = sync.applyLocal({
        actor, entity: 'file', op: 'create', recordId: id,
        fields: { kind: 'upload', name: clean, [owner.field]: owner.id, notes, blob_id: blobId, size: bytes.length, content_type: type.type, sha256 },
      });
      if (r.status !== 'applied') {
        const gone = ['not_found', 'deleted'].includes(r.code);
        throw new HttpError(gone ? 404 : 400, gone ? 'The client, account or task this file was for isn’t here any more' : `Couldn’t save it: ${r.reason}`,
          undefined, { code: gone ? 'owner_not_found' : r.code });
      }
      return q.record.get(id);
    })();
    log?.info?.(`file uploaded ${id} (${bytes.length} bytes, ${type.type})`); // never its name
    return { file: recordView(result), created: true };
  }

  const recordView = (r) => ({
    id: r.id, kind: r.kind, name: r.name, client_id: r.client_id, account_id: r.account_id, task_id: r.task_id,
    notes: r.notes, size: r.size, content_type: r.content_type, sha256: r.sha256, created_at: r.created_at, created_by: r.created_by,
  });

  /**
   * A live upload whose owner is live, with its stored bytes: { record, blob } — else a 404/410 HttpError.
   * (Deleted, under a deleted client/account/task, or not an upload: 404, as if it never existed.)
   */
  function forDownload(id) {
    const r = isId(id) ? q.record.get(id) : null;
    if (!r || r.deleted_at || r.kind !== 'upload' || !ownerLive(r)) throw new HttpError(404, 'No such file', undefined, { code: 'not_found' });
    const blob = q.blob.get(r.blob_id);
    if (!blob) throw new HttpError(410, 'This file’s contents were removed after it was deleted', undefined, { code: 'purged' });
    return { record: r, blob };
  }

  return {
    usage,
    purge,
    precheck,
    store,
    forDownload,
    /** One piece of a blob (Buffer), or null. */
    chunk: (blobId, n) => q.chunk.get(blobId, n) ?? null,
    /** Live files per kind (System page / tests). */
    counts: () => Object.fromEntries(q.counts.all().map((r) => [r.kind, r.n])),
  };
}

function disabledService() {
  const off = () => { throw new HttpError(503, 'Files need the CRM and the planner', undefined, { code: 'files_off' }); };
  return { disabled: true, usage: off, purge: () => 0, precheck: off, store: off, forDownload: off, chunk: () => null, counts: () => ({}) };
}
