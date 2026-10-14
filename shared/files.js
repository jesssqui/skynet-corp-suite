// Files (D10): what can be kept on a client's, an account's or a task's Files tab, shared by the
// server (the upload route, the checks on the `file` record type) and devices (the Files tab, the
// upload button). No I/O here.
//
// Three kinds of file record:
//   upload    a file's bytes, kept by the suite (sent online; listed offline)
//   link      an address somewhere else (Google Drive, Dropbox, a Figma file…)
//   password  a pointer to a password manager entry — WHICH vault and item, never the secret itself
export const FILE_KINDS = ['upload', 'link', 'password'];
export const FILE_KIND_LABELS = { upload: 'File', link: 'Link', password: 'Password pointer' };

// Who a file belongs to: exactly one of these (a client, one of their accounts, or a task).
export const FILE_OWNER_FIELDS = ['client_id', 'account_id', 'task_id'];

export const FILE_NAME_MAX = 150;
export const FILE_NOTES_MAX = 2000;
export const FILE_URL_MAX = 2000;
export const VAULT_MAX = 100;
export const VAULT_ITEM_MAX = 200;

// Default limits (server settings FILES_MAX_MB, FILES_MAX_TOTAL_MB, FILES_PURGE_DAYS).
export const DEFAULT_MAX_FILE_MB = 25;
export const DEFAULT_MAX_TOTAL_MB = 500;
export const DEFAULT_PURGE_DAYS = 30;

const MB = 1024 * 1024;
export const mb = (n) => n * MB;

/**
 * The types that may be uploaded, by extension (lowercase, no dot). The extension decides the type
 * the file is stored and sent with — never what the browser claims. `inline`: may be shown in the
 * browser (opened in a tab, an image shown in the app); everything else always downloads. `magic`:
 * the first bytes such a file must start with (checked on upload for the inline types, so a page
 * renamed .png can't be shown). HTML, SVG-as-image, scripts and programs are never inline; HTML,
 * XML, scripts and programs can't be uploaded at all.
 */
export const FILE_TYPES = {
  png: { type: 'image/png', inline: true, magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  jpg: { type: 'image/jpeg', inline: true, magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { type: 'image/jpeg', inline: true, magic: [[0xff, 0xd8, 0xff]] },
  gif: { type: 'image/gif', inline: true, magic: [[0x47, 0x49, 0x46, 0x38]] },
  webp: { type: 'image/webp', inline: true, magic: [[0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50]] },
  pdf: { type: 'application/pdf', inline: true, magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]] },
  heic: { type: 'image/heic' },
  heif: { type: 'image/heif' },
  svg: { type: 'image/svg+xml' }, // logos: always downloaded, never shown in the app's origin
  psd: { type: 'image/vnd.adobe.photoshop' },
  ai: { type: 'application/postscript' },
  eps: { type: 'application/postscript' },
  txt: { type: 'text/plain' },
  csv: { type: 'text/csv' },
  md: { type: 'text/markdown' },
  rtf: { type: 'application/rtf' },
  doc: { type: 'application/msword' },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xls: { type: 'application/vnd.ms-excel' },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  ppt: { type: 'application/vnd.ms-powerpoint' },
  pptx: { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  odt: { type: 'application/vnd.oasis.opendocument.text' },
  ods: { type: 'application/vnd.oasis.opendocument.spreadsheet' },
  odp: { type: 'application/vnd.oasis.opendocument.presentation' },
  pages: { type: 'application/vnd.apple.pages' },
  numbers: { type: 'application/vnd.apple.numbers' },
  key: { type: 'application/vnd.apple.keynote' },
  zip: { type: 'application/zip' },
};

/** What the file picker offers (`accept`): every allowed extension. */
export const FILE_ACCEPT = Object.keys(FILE_TYPES).map((e) => `.${e}`).join(',');

/** The plain-English list shown with the upload button and in a refusal. */
export const ALLOWED_TEXT = 'images, PDFs, documents, spreadsheets, presentations, text and zip files';

/** The extension of a name, lowercase without the dot ('' when none). */
export function extensionOf(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name ?? ''));
  return m ? m[1].toLowerCase() : '';
}

/** { ext, type, inline, magic } for an allowed name, or null. */
export function fileTypeOf(name) {
  const ext = extensionOf(name);
  const t = Object.hasOwn(FILE_TYPES, ext) ? FILE_TYPES[ext] : null;
  return t ? { ext, type: t.type, inline: Boolean(t.inline), magic: t.magic ?? null } : null;
}

/** May a stored type be shown in the browser (images and PDFs; never SVG or anything else)? */
export function isInlineType(type) {
  return Object.values(FILE_TYPES).some((t) => t.inline && t.type === type);
}

/** Do the first bytes match what this type must start with? (true for types without a check) */
export function magicMatches(name, bytes) {
  const t = fileTypeOf(name);
  if (!t?.magic) return true;
  return t.magic.some((sig) => bytes.length >= sig.length && sig.every((b, i) => b === null || bytes[i] === b));
}

// Control characters, bidi overrides (which can make "gpj.exe" look like "exe.jpg"), zero-width
// characters and characters that are not allowed in names on Windows or macOS.
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff<>:"/\\|?*]/g;
// The ones no name may hold at all, whatever it is (a link's, a pointer's, a renamed file's): control,
// bidi and invisible characters. The server refuses them (D10 review); cleanFileName takes them out.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/** Does a name hold control, bidi or invisible characters? */
export const hasUnsafeNameChars = (name) => UNSAFE_NAME_CHARS.test(String(name ?? ''));

/**
 * A safe file name: only the last part of a path, no control/bidi/invisible characters or ones
 * file systems refuse, no leading dots or spaces, spaces collapsed, NFC, at most FILE_NAME_MAX
 * characters keeping the extension; "file" when nothing is left.
 */
export function cleanFileName(name) {
  let s = String(name ?? '').normalize('NFC');
  s = s.split(/[/\\]/).pop();
  s = s.replace(BAD_CHARS, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  s = s.replace(/\s+(\.[A-Za-z0-9]{1,10})$/, '$1'); // "logo .png" → "logo.png"
  if (!s) return 'file';
  if ([...s].length > FILE_NAME_MAX) {
    const ext = extensionOf(s);
    const chars = [...s];
    const keep = ext ? FILE_NAME_MAX - ext.length - 1 : FILE_NAME_MAX;
    s = ext ? `${chars.slice(0, keep).join('').trimEnd()}.${ext}` : chars.slice(0, keep).join('').trimEnd();
  }
  return s;
}

/**
 * The name a download is saved as: the record's (cleaned) name, with the stored type's extension
 * added when a rename lost it — the bytes are still that type.
 */
export function downloadName(name, type) {
  const clean = cleanFileName(name);
  const ext = extensionOf(clean);
  if (ext && FILE_TYPES[ext]?.type === type) return clean;
  const want = Object.entries(FILE_TYPES).find(([, t]) => t.type === type)?.[0];
  return want ? `${clean}.${want}` : clean;
}

/** An http(s) address (links and a password pointer's optional address), or null. */
export function cleanUrl(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
  if (url.username || url.password) return null; // never a password in an address
  return url.href.length > FILE_URL_MAX ? null : url.href;
}

/** "312 KB", "4.2 MB" (binary units, like Finder's "MB" closely enough for two people). */
export function sizeText(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} bytes`;
  if (n < MB) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

/** The record's owner field and id ({ field, id }), or null when it names none or several. */
export function fileOwner(fields) {
  const set = FILE_OWNER_FIELDS.filter((f) => fields?.[f] !== null && fields?.[f] !== undefined && fields?.[f] !== '');
  return set.length === 1 ? { field: set[0], id: fields[set[0]] } : null;
}
