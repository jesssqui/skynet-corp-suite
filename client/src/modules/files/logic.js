// Files (D10) on devices, no React (tested in client/test/files.test.js): which files show on a
// client's and an account's Files tab (task files included), how a row is described, the forms for
// links and password pointers, and the plain-English answers for uploads.
import {
  FILE_TYPES, fileTypeOf, cleanFileName, hasUnsafeNameChars, cleanUrl, sizeText, isInlineType, extensionOf, ALLOWED_TEXT,
  FILE_NAME_MAX, FILE_NOTES_MAX, VAULT_MAX, VAULT_ITEM_MAX,
} from '@suite/shared/files';

export const PAGE = 50;

const newestFirst = (a, b) => String(b.created_at ?? b._sync?.createdAt ?? b.id).localeCompare(String(a.created_at ?? a._sync?.createdAt ?? a.id)) || (a.id < b.id ? 1 : -1);

/**
 * Every file shown for a client: its own, its accounts', and those on tasks naming the client or one
 * of its accounts (a task's files follow it when it is filed elsewhere). Newest first, each with
 * `where`: { on: 'client' } | { on: 'account', accountId } | { on: 'task', taskId, accountId }.
 * @param {{ files: object[], tasks: object[], accounts: object[], clientId: string }} input
 *   accounts: the client's live accounts; tasks: every task on the device
 */
export function filesForClient({ files, tasks, accounts, clientId }) {
  const accountIds = new Set(accounts.map((a) => a.id));
  const taskWhere = new Map();
  for (const t of tasks) {
    if (t.client_id === clientId || (t.account_id && accountIds.has(t.account_id))) {
      taskWhere.set(t.id, accountIds.has(t.account_id) ? t.account_id : null);
    }
  }
  const out = [];
  for (const f of files) {
    if (f.client_id === clientId) out.push({ file: f, where: { on: 'client' } });
    else if (f.account_id && accountIds.has(f.account_id)) out.push({ file: f, where: { on: 'account', accountId: f.account_id } });
    else if (f.task_id && taskWhere.has(f.task_id)) out.push({ file: f, where: { on: 'task', taskId: f.task_id, accountId: taskWhere.get(f.task_id) } });
  }
  return out.sort((a, b) => newestFirst(a.file, b.file));
}

/**
 * One tab of the page: 'all' (everything above), 'client' (the client's own) or an account id (the
 * account's own and its tasks' files).
 */
export function filesOnTab(items, tab) {
  if (tab === 'all') return items;
  if (tab === 'client') return items.filter((i) => i.where.on === 'client');
  return items.filter((i) => i.where.accountId === tab);
}

/** Who new files on a tab belong to: the client (All, Client) or the account. */
export function ownerForTab(tab, clientId) {
  return tab === 'all' || tab === 'client' ? { field: 'client_id', id: clientId } : { field: 'account_id', id: tab };
}

/** Counts per tab: { all, client, [accountId]: n }. */
export function tabCounts(items, accounts) {
  const out = { all: items.length, client: 0 };
  for (const a of accounts) out[a.id] = 0;
  for (const i of items) {
    if (i.where.on === 'client') out.client += 1;
    if (i.where.accountId && Object.hasOwn(out, i.where.accountId)) out[i.where.accountId] += 1;
  }
  return out;
}

/** Where a row sits, for the "All" tab: "Client", the account's name, or "Task: <title>". */
export function whereText(where, { accountsById, tasksById }) {
  if (!where) return '';
  if (where.on === 'client') return 'Client';
  if (where.on === 'account') return accountsById.get(where.accountId)?.name ?? 'An account';
  const t = tasksById.get(where.taskId);
  return t ? `Task: ${t.title}` : 'A task';
}

const KIND_NAMES = { pdf: 'PDF', png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', gif: 'GIF image', webp: 'WebP image', heic: 'HEIC photo', heif: 'HEIF photo', svg: 'SVG image', docx: 'Word document', doc: 'Word document', xlsx: 'Excel spreadsheet', xls: 'Excel spreadsheet', csv: 'CSV', pptx: 'PowerPoint', ppt: 'PowerPoint', zip: 'Zip archive', txt: 'Text', md: 'Text' };

/** The grey line under a file's name. */
export function fileDetail(f) {
  if (f.kind === 'upload') {
    const own = extensionOf(f.name);
    const ext = own && FILE_TYPES[own]?.type === f.content_type ? own : (Object.keys(FILE_TYPES).find((e) => FILE_TYPES[e].type === f.content_type) ?? own);
    return [KIND_NAMES[ext] ?? (ext ? ext.toUpperCase() : 'File'), sizeText(f.size)].filter(Boolean).join(' · ');
  }
  if (f.kind === 'link') return hostOf(f.url) ?? 'Link';
  const where = [f.vault, f.vault_item].filter(Boolean).join(' → ');
  return where ? `In ${where}` : 'Password pointer';
}

export const KIND_ICONS = { upload: 'note', link: 'link', password: 'key' };

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** The download address; `show` asks to see an image or PDF in the browser (anything else still downloads). */
export function downloadHref(id, { show = false } = {}) {
  return `/api/files/${id}/download${show ? '?inline=1' : ''}`;
}

/** Can this upload be shown in the browser (images and PDFs; never SVG)? */
export const canShow = (f) => f.kind === 'upload' && isInlineType(f.content_type);
export const isImage = (f) => canShow(f) && String(f.content_type).startsWith('image/');

// ---- links and password pointers (made on the device, offline) ------------------------------------

const trimOrNull = (v) => {
  const s = String(v ?? '').trim();
  return s ? s : null;
};

/** A typed name without control, bidi or invisible characters (the server refuses them). */
export function safeName(v) {
  return trimOrNull([...String(v ?? '')].filter((c) => !hasUnsafeNameChars(c)).join('').replace(/\s+/g, ' '));
}

/** The form's starting values (a new one, or a record being edited). */
export function entryValues(kind, record = null) {
  return {
    kind,
    name: record?.name ?? '',
    url: record?.url ?? '',
    vault: record?.vault ?? '',
    vault_item: record?.vault_item ?? '',
    notes: record?.notes ?? '',
  };
}

/**
 * Form values → the record's fields, or problems. A link's name defaults to its address's host; a
 * password pointer needs the item's name and never a password (a warning, not a guess: nothing here
 * can tell, so the form says it plainly).
 * → { fields, problems }
 */
export function entryFields(v) {
  const problems = {};
  const fields = { notes: trimOrNull(v.notes) };
  if (fields.notes && fields.notes.length > FILE_NOTES_MAX) problems.notes = `At most ${FILE_NOTES_MAX} characters`;
  const urlText = trimOrNull(v.url);
  const url = urlText ? cleanUrl(urlText) : null;
  if (urlText && !url) problems.url = 'An address like https://drive.google.com/… (no password in it)';
  if (v.kind === 'link') {
    if (!urlText) problems.url = 'The link’s address';
    fields.url = url;
    fields.name = trimOrNull(v.name) ?? (url ? hostOf(url) : null);
  } else if (v.kind === 'password') {
    fields.url = url;
    fields.vault = trimOrNull(v.vault);
    fields.vault_item = trimOrNull(v.vault_item);
    if (!fields.vault_item) problems.vault_item = 'Which item to look for in the password manager';
    if (fields.vault && fields.vault.length > VAULT_MAX) problems.vault = `At most ${VAULT_MAX} characters`;
    if (fields.vault_item && fields.vault_item.length > VAULT_ITEM_MAX) problems.vault_item = `At most ${VAULT_ITEM_MAX} characters`;
    fields.name = trimOrNull(v.name) ?? fields.vault_item;
  } else {
    // A renamed upload: cleaned like the upload's own name was (no path, reserved or invisible characters).
    fields.name = trimOrNull(v.name) ? cleanFileName(v.name) : null;
  }
  if (fields.name && v.kind !== 'upload') fields.name = safeName(fields.name);
  if (!fields.name) problems.name = 'A name';
  else if ([...fields.name].length > FILE_NAME_MAX) problems.name = `At most ${FILE_NAME_MAX} characters`;
  return { fields, problems };
}

/** Only what changed since the form opened (another person's change meanwhile must survive). */
export function entryChanges(record, start, v) {
  const { fields, problems } = entryFields({ ...v, kind: record.kind });
  const before = entryFields({ ...start, kind: record.kind }).fields;
  const changed = {};
  for (const [k, value] of Object.entries(fields)) {
    if (record.kind === 'upload' && !['name', 'notes'].includes(k)) continue;
    if (value !== before[k]) changed[k] = value;
  }
  return { fields: changed, problems };
}

/** Does a password pointer's text look like a password was typed in (a warning shown under the form)? */
export function looksLikeSecret(v) {
  const text = [v.vault_item, v.notes, v.name].filter(Boolean).join(' ');
  return /\b(pass(word)?|pwd|pw|pin)\s*[:=]\s*\S+/i.test(text);
}

// ---- uploads ------------------------------------------------------------------------------------------

/** Checked on the device before sending (the server checks again): → null or a plain-English problem. */
export function uploadProblem(file, usage) {
  const name = cleanFileName(file.name);
  if (!fileTypeOf(name)) return `“${name}” can’t be added: allowed are ${ALLOWED_TEXT}.`;
  if (!file.size) return `“${name}” is empty.`;
  if (usage?.maxFileBytes && file.size > usage.maxFileBytes) return `“${name}” is ${sizeText(file.size)}: files can be at most ${sizeText(usage.maxFileBytes)}.`;
  if (usage?.maxTotalBytes && usage.usedBytes + file.size > usage.maxTotalBytes) {
    return `No room for “${name}”: the suite keeps at most ${sizeText(usage.maxTotalBytes)} of files (${sizeText(usage.usedBytes)} used). Delete some first.`;
  }
  return null;
}

/** The X-File-Info header for an upload. */
export function uploadInfoHeader({ id, name, owner, notes }) {
  const key = { client_id: 'clientId', account_id: 'accountId', task_id: 'taskId' }[owner.field];
  return encodeURIComponent(JSON.stringify({ id, name, [key]: owner.id, ...(notes ? { notes } : {}) }));
}

/** What to tell the person when an upload didn't go through. */
export function uploadErrorText(status, body) {
  if (status === 0) return 'Can’t reach the suite: uploading needs a connection. Try again when you’re back online.';
  if (status === 401) return 'You’re signed out: sign in again, then try again.';
  if (body?.error && status < 500) return body.error;
  if (status === 503) return 'The suite is busy: try again in a moment.';
  return 'The upload didn’t go through: try again.';
}
