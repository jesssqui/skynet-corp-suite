// Reading an email (D14), pure: the headers a ticket needs and the body as PLAIN TEXT. HTML is turned into text here
// (tags, scripts, styles and images dropped; links kept as their words only), so nothing remote is ever loaded and no
// HTML ever reaches a page. Attachments are never kept: only their names are listed. No dependency.
//
// parseMessage(buffer, { maxChars }) → { messageId, inReplyTo, references, subject, from: { name, email }, to: [emails],
//   date, auto (an auto-reply, bounce or list mail: never a ticket), text, truncated, attachments: [names] }

/** At most this much of a body is kept (characters); the rest is cut with a note. */
export const MAX_BODY_CHARS = 20_000;
const MAX_ATTACHMENTS = 30;
const MAX_DEPTH = 8;
// Review fix (D14): every input is capped before any regex or loop sees it, and every step below is linear, so a hostile
// email (256 KB of "<a", a million spaces, thousands of header lines) can't hold the server up.
/** A text part is read up to this many characters (plain) — HTML gets more room, being wordier. */
export const MAX_PART_CHARS = 64 * 1024;
export const MAX_HTML_CHARS = 256 * 1024;
/** Headers: at most this many lines and bytes; one (unfolded) value at most VALUE_MAX characters. */
export const MAX_HEADER_LINES = 400;
export const MAX_HEADER_BYTES = 64 * 1024;
const VALUE_MAX = 8 * 1024;
const MAX_PARTS = 100;

// ---- bytes and charsets ----------------------------------------------------------------------------------------
const CHARSET_ALIASES = { 'us-ascii': 'utf-8', ascii: 'utf-8', utf8: 'utf-8', latin1: 'iso-8859-1', 'x-unknown': 'utf-8', unknown: 'utf-8' };
function decoder(charset, fatal = false) {
  const c = String(charset ?? 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
  try {
    return new TextDecoder(CHARSET_ALIASES[c] ?? c, { fatal });
  } catch {
    return new TextDecoder('utf-8', { fatal });
  }
}
// Windows-1252's 0x80–0x9F (Node 22's TextDecoder reads windows-1252 / ISO-8859-1 as Latin-1: C1 controls instead).
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const LATIN = new Set(['windows-1252', 'cp1252', 'x-cp1252', 'iso-8859-1', 'iso8859-1', 'latin1', 'l1', 'iso_8859-1', 'cp819', 'ibm819', 'iso-ir-100', 'ascii', 'us-ascii-latin']);
function decodeCp1252(bytes) {
  let s = '';
  for (const b of bytes) s += b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80] : String.fromCharCode(b);
  return s;
}
/** Bytes → text in `charset` (unknown charsets as UTF-8). */
export function decodeBytes(bytes, charset) {
  const c = String(charset ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  return LATIN.has(c) ? decodeCp1252(bytes) : decoder(charset).decode(bytes);
}
/** Raw header bytes (8-bit headers): UTF-8 when they are valid UTF-8, else Windows-1252. */
function headerText(bin) {
  if (/^[\x00-\x7f]*$/.test(bin)) return bin;
  const bytes = Buffer.from(bin, 'latin1');
  try {
    return decoder('utf-8', true).decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
}

/** Quoted-printable → bytes. */
export function decodeQP(s) {
  const t = String(s).replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      out.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(t.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

/** RFC 2047 encoded words (=?utf-8?B?…?= / =?iso-8859-1?Q?…?=) → text. Adjacent words are joined (their bytes, so a
 * character split across two words survives). */
export function decodeWords(value) {
  const s = String(value ?? '').replace(/(\?=)[ \t\r\n]+(?==\?)/g, '$1');
  const re = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  let out = '';
  let last = 0;
  let pending = null;
  const flush = () => {
    if (pending) out += decodeBytes(Buffer.concat(pending.bytes), pending.charset);
    pending = null;
  };
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) {
      flush();
      out += s.slice(last, m.index);
    }
    const charset = m[1].split('*')[0].toLowerCase();
    const bytes = m[2].toUpperCase() === 'B' ? Buffer.from(m[3], 'base64') : decodeQP(m[3].replace(/_/g, ' '));
    if (pending && pending.charset === charset) pending.bytes.push(bytes);
    else {
      flush();
      pending = { charset, bytes: [bytes] };
    }
    last = re.lastIndex;
  }
  flush();
  return out + s.slice(last);
}

// ---- headers --------------------------------------------------------------------------------------------------
/** "binary" text (latin1, byte for byte) → { head, body } at the first blank line. */
export function splitMessage(bin) {
  const a = bin.indexOf('\r\n\r\n');
  const b = bin.indexOf('\n\n');
  if (a < 0 && b < 0) return { head: bin, body: '' };
  if (a >= 0 && (b < 0 || a <= b)) return { head: bin.slice(0, a), body: bin.slice(a + 4) };
  return { head: bin.slice(0, b), body: bin.slice(b + 2) };
}
/** Header block → Map(lowercase name → [values]) (unfolded, raw; capped: MAX_HEADER_LINES lines, VALUE_MAX per value). */
export function parseHeaders(head) {
  const map = new Map();
  let cur = null;
  const lines = String(head).slice(0, MAX_HEADER_BYTES).split('\n', MAX_HEADER_LINES);
  for (let line of lines) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const c = line.charCodeAt(0);
    if ((c === 32 || c === 9) && cur) {
      if (cur.value.length < VALUE_MAX) cur.value = `${cur.value} ${line.trim()}`.slice(0, VALUE_MAX);
      continue;
    }
    const i = line.indexOf(':');
    if (i <= 0) {
      cur = null;
      continue;
    }
    cur = { value: line.slice(i + 1).trim().slice(0, VALUE_MAX) };
    const name = line.slice(0, i).trim().toLowerCase();
    const list = map.get(name);
    if (list) list.push(cur);
    else map.set(name, [cur]);
  }
  const out = new Map();
  for (const [k, list] of map) out.set(k, list.map((x) => x.value));
  return out;
}
const first = (headers, name) => headers.get(name)?.[0] ?? null;

/** Split on `sep` outside quotes, <…> and (…). */
function splitOutside(s, sep) {
  const out = [];
  let cur = '';
  let q = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && q) {
      cur += c + (s[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (c === '"') q = !q;
    else if (!q && c === '<') angle += 1;
    else if (!q && c === '>') angle = Math.max(0, angle - 1);
    else if (!q && c === '(') paren += 1;
    else if (!q && c === ')') paren = Math.max(0, paren - 1);
    if (c === sep && !q && !angle && !paren) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const EMAIL_RE = /^[^\s@<>()",;:[\]]+@[^\s@<>()",;:[\]]+\.[^\s@<>()",;:[\]]+$/;
/** An address header → [{ name, email }] (emails lowercased; groups and entries without an address left out). */
export function parseAddresses(value) {
  const out = [];
  if (!value) return out;
  for (let part of splitOutside(headerText(value), ',')) {
    part = part.replace(/^[^"<]*:/, ''); // a group's name ("Undisclosed recipients:")
    part = part.replace(/;\s*$/, '').trim();
    if (!part) continue;
    let email = null;
    let name = '';
    const m = /<([^<>]*)>/.exec(part);
    if (m) {
      email = m[1].trim();
      name = (part.slice(0, m.index) + part.slice(m.index + m[0].length)).trim();
    } else {
      const comment = /\(([^)]*)\)/.exec(part);
      email = part.replace(/\([^)]*\)/g, '').trim();
      name = comment ? comment[1] : '';
    }
    email = email.replace(/^mailto:/i, '').toLowerCase();
    if (!EMAIL_RE.test(email)) continue;
    name = decodeWords(name).replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim();
    out.push({ name: name && name.toLowerCase() !== email ? name.slice(0, 200) : null, email: email.slice(0, 320) });
  }
  return out;
}

/** Every <message-id> in a header, in order (without the brackets). */
export function messageIds(value) {
  const out = [];
  for (const m of String(value ?? '').matchAll(/<([^<>\s]{1,400})>/g)) out.push(m[1]);
  return out;
}

/** "text/plain; charset=utf-8; name*=utf-8''r%C3%A9sum%C3%A9.pdf" → { value, params } (RFC 2231 included). */
export function parseParams(raw) {
  const [value, ...rest] = splitOutside(String(raw ?? ''), ';');
  const params = {};
  const ext = {}; // name → [{ i, v, enc }]
  for (const p of rest) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const key = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    const m = /^([^*]+)\*(?:(\d+)(\*)?)?$|^([^*]+)\*$/.exec(key);
    if (m) {
      const base = m[1] ?? m[4];
      const idx = m[2] === undefined ? 0 : Number(m[2]);
      const enc = m[2] === undefined ? true : m[3] === '*';
      (ext[base] ??= []).push({ i: idx, v, enc });
    } else if (key.includes('*')) {
      const [base, idx] = key.split('*');
      (ext[base] ??= []).push({ i: Number(idx) || 0, v, enc: false });
    } else params[key] = decodeWords(v);
  }
  for (const [base, parts] of Object.entries(ext)) {
    parts.sort((a, b) => a.i - b.i);
    let charset = 'utf-8';
    const bytes = [];
    for (const part of parts) {
      let v = part.v;
      if (part.enc) {
        if (part.i === 0) {
          const q = /^([^']*)'[^']*'(.*)$/.exec(v);
          if (q) {
            charset = q[1] || charset;
            v = q[2];
          }
        }
        bytes.push(Buffer.from(v.replace(/%([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1'));
      } else bytes.push(Buffer.from(v, 'latin1'));
    }
    params[base] = decodeBytes(Buffer.concat(bytes), charset);
  }
  return { value: value.trim().toLowerCase(), params };
}

// ---- HTML → text ------------------------------------------------------------------------------------------------
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', euro: '€', pound: '£', cent: '¢',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', ccedil: 'ç', icirc: 'î', iuml: 'ï',
  ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü', Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç', szlig: 'ß', ntilde: 'ñ', zwnj: '', zwj: '', shy: '',
};
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,15});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return Object.hasOwn(ENTITIES, e) ? ENTITIES[e] : m;
  });
}
const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'template', 'noscript', 'svg', 'object']);
const BLOCK_TAGS = new Set(['p', 'div', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'ul', 'ol', 'section', 'article', 'header', 'footer', 'hr']);
/**
 * HTML → plain text: no tags, no scripts or styles, no images; links as their words; blocks on their own lines.
 * One pass, linear (review fix: the regex version was quadratic on "<a<a<a…"): a "<" with no ">" after it is text,
 * and once no ">" is left, nothing more is looked for.
 */
export function htmlToText(html) {
  const s = String(html).slice(0, MAX_HTML_CHARS);
  const lower = s.toLowerCase();
  let out = '';
  let i = 0;
  let noClose = false;
  while (i < s.length) {
    const lt = noClose ? -1 : s.indexOf('<', i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end < 0) break; // an unclosed comment hides the rest
      i = end + 3;
      continue;
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) {
      noClose = true; // no tag can close any more: the rest is text
      out += s.slice(lt);
      break;
    }
    let j = lt + 1;
    const closing = s[j] === '/';
    if (closing) j += 1;
    let k = j;
    while (k < gt && /[a-zA-Z0-9]/.test(s[k])) k += 1;
    const name = lower.slice(j, k);
    i = gt + 1;
    if (!closing && SKIP_TAGS.has(name)) {
      const end = lower.indexOf(`</${name}`, i);
      if (end < 0) break; // the rest is inside it
      const endGt = s.indexOf('>', end);
      i = endGt < 0 ? s.length : endGt + 1;
      continue;
    }
    if (name === 'br') out += '\n';
    else if (name === 'li' && !closing) out += '\n• ';
    else if ((name === 'td' || name === 'th') && closing) out += ' ';
    else if (BLOCK_TAGS.has(name)) out += '\n';
  }
  return decodeEntities(out);
}

/**
 * Text as kept: line ends \n, no control characters (bar tabs), no trailing spaces, runs of spaces as one, at most one
 * blank line in a row. Line by line (review fix: no regex that rescans a long run of spaces).
 */
export function cleanText(s) {
  const lines = String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .split('\n');
  const out = [];
  let blank = 0;
  for (const raw of lines) {
    const line = raw.replace(/[ \t\u00a0]+/g, ' ').trimEnd();
    if (!line.trim()) {
      blank += 1;
      if (blank > 1) continue;
    } else blank = 0;
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * Leave out the earlier messages a reply quotes below it ("On … wrote:" and the "> " lines after it, or Outlook's
 * "-----Original Message-----" / "From: … Sent: …" block): the thread already has them, and keeping less is better.
 * One pass (review fix): counts of what follows each line are worked out once, from the end.
 */
export function trimQuoted(text) {
  const lines = text.split('\n');
  const n = lines.length;
  // After line i: how many non-blank lines, and how many of them quoted ("> ").
  const filled = new Int32Array(n + 1);
  const quoted = new Int32Array(n + 1);
  for (let i = n - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    filled[i] = filled[i + 1] + (t ? 1 : 0);
    quoted[i] = quoted[i + 1] + (t.startsWith('>') ? 1 : 0);
  }
  const head = (i) => (lines[i] ?? '').trim().slice(0, 400);
  for (let i = 1; i < n; i += 1) {
    const l = head(i);
    if (!l) continue;
    const wrote = /^(On|Le|Am|El) .{4,300}(wrote|a écrit|schrieb|escribió) ?:$/i.test(l)
      || (/^(On|Le) /i.test(l) && /(wrote|a écrit) ?:$/i.test(`${l} ${head(i + 1)}`) && head(i + 2).startsWith('>'));
    const outlook = /^-{2,}\s*(Original Message|Message d’origine|Message d'origine)\s*-{2,}$/i.test(l)
      || (/^(From|De) ?:/i.test(l) && /^(Sent|Envoyé|Date) ?:/i.test(head(i + 1)) && !lines[i - 1].trim());
    if (wrote || outlook) {
      const rest = filled[i + 1];
      if (outlook || !rest || quoted[i + 1] / rest >= 0.5) return lines.slice(0, i).join('\n').trimEnd();
    }
  }
  // A trailing block of "> " lines alone.
  let end = n;
  while (end > 0 && (/^\s*>/.test(lines[end - 1]) || !lines[end - 1].trim())) end -= 1;
  return end > 0 && end < n && quoted[end] > 0 ? lines.slice(0, end).join('\n').trimEnd() : text;
}

// ---- bodies ------------------------------------------------------------------------------------------------------
function decodePart(bin, headers) {
  const cte = String(first(headers, 'content-transfer-encoding') ?? '').trim().toLowerCase();
  if (cte === 'base64') return Buffer.from(bin.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (cte === 'quoted-printable') return decodeQP(bin);
  return Buffer.from(bin, 'latin1');
}
function splitMultipart(bin, boundary) {
  const parts = [];
  const delim = `--${boundary}`;
  let pos = bin.indexOf(delim);
  while (pos >= 0) {
    const after = pos + delim.length;
    if (bin.startsWith('--', after)) break; // the closing delimiter
    const lineEnd = bin.indexOf('\n', after);
    if (lineEnd < 0) break;
    const next = bin.indexOf(`\n${delim}`, lineEnd);
    const end = next < 0 ? bin.length : next;
    parts.push(bin.slice(lineEnd + 1, end).replace(/\r$/, ''));
    if (parts.length >= MAX_PARTS) break;
    pos = next < 0 ? -1 : next + 1;
  }
  return parts;
}

function walk(bin, headers, depth, acc, inAlternative = false) {
  const ct = parseParams(first(headers, 'content-type') ?? 'text/plain');
  const type = ct.value || 'text/plain';
  const disp = parseParams(first(headers, 'content-disposition') ?? '');
  const fileName = (disp.params.filename || ct.params.name || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 200) || null;
  if (type.startsWith('multipart/') && ct.params.boundary && depth < MAX_DEPTH) {
    const parts = splitMultipart(bin, ct.params.boundary).map((p) => {
      const { head, body } = splitMessage(p);
      return { body, headers: parseHeaders(head) };
    });
    if (type === 'multipart/alternative') {
      // One of them is the text: plain first; else HTML; anything else in it is walked for attachments.
      const textOfType = (want) => parts.find((p) => parseParams(first(p.headers, 'content-type') ?? 'text/plain').value === want);
      const plain = textOfType('text/plain');
      const html = textOfType('text/html');
      const chosen = plain ?? html;
      for (const p of parts) {
        if (p === chosen) walk(p.body, p.headers, depth + 1, acc, true);
        else if (p !== plain && p !== html) walk(p.body, p.headers, depth + 1, acc, true);
      }
      return;
    }
    for (const p of parts) walk(p.body, p.headers, depth + 1, acc, inAlternative);
    return;
  }
  if (type === 'message/rfc822') {
    acc.attachments.push(fileName ?? 'Forwarded email (attached)');
    return;
  }
  const isText = type === 'text/plain' || type === 'text/html';
  const attachment = disp.value === 'attachment' || (fileName && !isText && !(disp.value === 'inline' && type.startsWith('image/')));
  if (attachment || (fileName && isText && disp.value !== 'inline')) {
    acc.attachments.push(fileName ?? `Unnamed ${type} file`);
    return;
  }
  if (isText) {
    const max = type === 'text/plain' ? MAX_PART_CHARS : MAX_HTML_CHARS;
    // Bytes first cut to a few times the characters kept (a character is at most 4 bytes; base64/QP at most ~3×).
    const text = decodeBytes(decodePart(bin.slice(0, max * 4), headers), ct.params.charset).slice(0, max);
    (type === 'text/plain' ? acc.plain : acc.html).push(text);
    return;
  }
  // Inline images (logos, signatures) and other inline parts are left out; other parts are listed.
  if (!(type.startsWith('image/') && (disp.value === 'inline' || first(headers, 'content-id')))) acc.attachments.push(fileName ?? `Unnamed ${type} file`);
}

const NOREPLY_RE = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply|bounces?)([+.-].*)?@/i;
/** What says an email was sent by a machine: { autoSubmitted, autoreply, bulk (Precedence / list headers) }. */
export function automaticSignals(headers) {
  const auto = String(first(headers, 'auto-submitted') ?? '').trim().toLowerCase();
  return {
    autoSubmitted: Boolean(auto && auto !== 'no'),
    autoreply: Boolean(first(headers, 'x-autoreply') || first(headers, 'x-autorespond') || /^auto_reply$/i.test(String(first(headers, 'precedence') ?? '').trim())),
    bulk: /^(bulk|junk|list)$/i.test(String(first(headers, 'precedence') ?? '').trim()) || Boolean(first(headers, 'list-id') || first(headers, 'list-unsubscribe')),
  };
}
/** Is it an auto-reply, a bounce or a mailing list's mail (never a ticket)? — for an email with no Reply-To of its own. */
export function isAutomatic(headers, fromEmail) {
  const s = automaticSignals(headers);
  return s.autoSubmitted || s.autoreply || s.bulk || NOREPLY_RE.test(fromEmail ?? '');
}
/**
 * The same, for a parsed email and our own address (review fix: contact forms). When a Reply-To names someone other
 * than the sender and us — a contact form, or a store's form sent through SendGrid / Mailgun — the email is judged by
 * that Reply-To: a noreply@ From and a relay's List-Unsubscribe / Precedence don't make it a machine's mail; an
 * Auto-Submitted header, an auto-reply header or a noreply Reply-To still do.
 */
export function isAutomaticFor(p, ownAddress = null) {
  const s = p.signals ?? {};
  const reply = p.replyTo && p.replyTo.email !== p.from?.email && p.replyTo.email !== ownAddress ? p.replyTo : null;
  if (reply) return Boolean(s.autoSubmitted || s.autoreply || NOREPLY_RE.test(reply.email));
  return Boolean(s.autoSubmitted || s.autoreply || s.bulk || NOREPLY_RE.test(p.from?.email ?? ''));
}

/**
 * One email (bytes, possibly cut at the fetch limit) → what a ticket keeps. The body is plain text, quoted replies left
 * out, at most `maxChars`; attachments are names only.
 */
export function parseMessage(raw, { maxChars = MAX_BODY_CHARS, cut = false } = {}) {
  const bin = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  const { head, body } = splitMessage(bin);
  const headers = parseHeaders(head);
  const h = (name) => {
    const v = first(headers, name);
    return v === null ? null : decodeWords(headerText(v));
  };
  const from = parseAddresses(first(headers, 'from'))[0] ?? { name: null, email: null };
  const replyTo = parseAddresses(first(headers, 'reply-to'))[0] ?? null;
  const to = parseAddresses([first(headers, 'to'), first(headers, 'cc')].filter(Boolean).join(', ')).map((a) => a.email);
  const acc = { plain: [], html: [], attachments: [] };
  walk(body, headers, 0, acc);
  let text = (acc.plain.length ? acc.plain.join('\n\n') : acc.html.map(htmlToText).join('\n\n')).slice(0, MAX_HTML_CHARS);
  text = trimQuoted(cleanText(text));
  let truncated = cut;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).trimEnd()}…`;
    truncated = true;
  }
  const date = Date.parse(String(first(headers, 'date') ?? '').slice(0, 200).replace(/\s*\([^)]*\)\s*$/, ''));
  const attachments = [...new Set(acc.attachments.map((a) => decodeWords(a)))];
  return {
    messageId: messageIds(first(headers, 'message-id'))[0] ?? null,
    inReplyTo: messageIds(first(headers, 'in-reply-to')),
    references: messageIds(first(headers, 'references')).slice(-30),
    subject: (h('subject') ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    from,
    replyTo,
    to,
    date: Number.isFinite(date) ? new Date(date).toISOString() : null,
    signals: automaticSignals(headers),
    auto: isAutomatic(headers, from.email),
    /** Review fix (D14): an id for an email with no Message-ID, from its own headers (never from where it was read). */
    headerKey: [first(headers, 'from'), first(headers, 'to'), first(headers, 'date'), first(headers, 'subject'), first(headers, 'reply-to')].map((v) => v ?? '').join('\n'),
    text,
    truncated,
    attachments: attachments.slice(0, MAX_ATTACHMENTS),
    moreAttachments: Math.max(0, attachments.length - MAX_ATTACHMENTS),
  };
}
