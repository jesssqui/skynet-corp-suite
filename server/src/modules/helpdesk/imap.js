// The suite's side of a support mailbox (D14): a small IMAP client that can only READ.
//
// READ-ONLY BY CONSTRUCTION. The only commands this file can send are on COMMANDS (CAPABILITY, LOGIN, LIST, EXAMINE,
// UID SEARCH, UID FETCH, NOOP, LOGOUT): `send()` refuses anything else before a byte is written, and every argument is
// built here — never passed through from a caller:
//   - folders are opened with EXAMINE (read-only), never SELECT, so the server can't change anything in them;
//   - messages are read with BODY.PEEK[…] only (FETCH_ITEM), never BODY[…] or RFC822, so nothing is marked read;
//   - there is no STORE (flags), COPY, MOVE, EXPUNGE, APPEND, DELETE, CREATE, RENAME, SUBSCRIBE or IDLE, and no SMTP:
//     the suite never sends an email.
// server/test/helpdesk-imap.test.js proves it against a fake IMAP server that records every command it receives.
// No dependency: one file, node:tls (TLS on port 993 — implicit TLS only; plain TCP only for this machine in tests).
//
// The password goes only into LOGIN, over TLS, and never into an error message or a log line.
import net from 'node:net';
import tls from 'node:tls';

export const COMMANDS = Object.freeze(['CAPABILITY', 'LOGIN', 'LIST', 'EXAMINE', 'UID SEARCH', 'UID FETCH', 'NOOP', 'LOGOUT']);
/** The FETCH data items this client asks for: UID, INTERNALDATE, RFC822.SIZE and BODY.PEEK[…] (never BODY[…]). */
const FETCH_ITEM = /^(UID|INTERNALDATE|RFC822\.SIZE|BODY\.PEEK\[(HEADER\.FIELDS \([A-Z0-9 -]+\))?\](<0\.\d{1,9}>)?)$/;
export const IMAP_PORT = 993;
/** Review fix (D14) — what one server may send: a literal at most `maxLiteral` bytes (what was asked for + slack), one
 * line at most MAX_LINE, one command's answers at most MAX_UNTAGGED responses and MAX_COMMAND_BYTES bytes. Past any of
 * these the connection is closed: a broken or hostile server can't fill the memory or keep a pull going for ever. */
export const MAX_LINE = 1024 * 1024;
export const MAX_UNTAGGED = 20_000;
export const MAX_COMMAND_BYTES = 48 * 1024 * 1024;
const DEFAULT_MAX_LITERAL = 1024 * 1024;

/** A plain-English problem with a mailbox or a call; `code` for the code. Never carries the password. */
export class ImapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImapError';
    this.code = code;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
/** A mail server's name: letters, digits, dots and dashes (or an IP address). → lowercase, or throws. */
export function cleanHost(value) {
  const h = String(value ?? '').trim().toLowerCase().replace(/^imaps?:\/\//, '').replace(/\/.*$/, '');
  if (!h || h.length > 253 || !(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h) || net.isIP(h))) {
    throw new ImapError('bad_host', 'The mail server’s name isn’t right (like imap.gmail.com or mail.yourstore.com)');
  }
  return h;
}
export const isLocalHost = (h) => LOCAL_HOSTS.has(h);

// ---- modified UTF-7 (RFC 3501 5.1.3): folder names on the wire ------------------------------------------
export function encodeFolder(name) {
  let out = '';
  let run = '';
  const flush = () => {
    if (!run) return;
    const b = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i += 1) b.writeUInt16BE(run.charCodeAt(i), i * 2);
    out += `&${b.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    run = '';
  };
  for (const ch of String(name)) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += ch === '&' ? '&-' : ch;
    } else run += ch; // UTF-16 code units (surrogate pairs stay pairs)
  }
  flush();
  return out;
}
export function decodeFolder(name) {
  return String(name).replace(/&([^-]*)-/g, (_m, b64) => {
    if (!b64) return '&';
    const b = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
    return s;
  });
}

// ---- dates ------------------------------------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** SEARCH SINCE's date: "7-Oct-2026" (a calendar day; the server reads it in its own zone). */
export const searchDate = (d) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
/** INTERNALDATE "17-Jul-1996 02:44:25 -0700" → an ISO time (UTC), or null. */
export function parseInternalDate(s) {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(String(s ?? ''));
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (mon < 0) return null;
  const off = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const ms = Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - off * 60_000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---- reading responses -------------------------------------------------------------------------------------
/**
 * Responses from a stream of chunks, linear in the bytes received (review fix: no re-concatenating and re-scanning
 * the whole buffer for every chunk). A literal's bytes are joined once, when they have all arrived. Throws ImapError
 * 'protocol' for a literal over `maxLiteral` or a line over MAX_LINE.
 */
export class ResponseReader {
  constructor({ maxLiteral = DEFAULT_MAX_LITERAL } = {}) {
    this.maxLiteral = maxLiteral;
    this.buf = Buffer.alloc(0); // unconsumed bytes
    this.pending = []; // chunks not joined yet
    this.pendingLen = 0;
    this.need = 0; // bytes needed in buf before trying again
    this.scan = 0; // where to look for the next CRLF in buf
    this.parts = []; // the response being read
  }

  /** Feed a chunk; → the whole responses it completed (each a list of parts). */
  push(chunk) {
    this.pending.push(chunk);
    this.pendingLen += chunk.length;
    if (this.buf.length + this.pendingLen < this.need) return [];
    this.buf = this.pending.length === 1 && !this.buf.length ? this.pending[0] : Buffer.concat([this.buf, ...this.pending]);
    this.pending = [];
    this.pendingLen = 0;
    const out = [];
    for (;;) {
      const nl = this.buf.indexOf('\r\n', this.scan, 'latin1');
      if (nl < 0) {
        if (this.buf.length > MAX_LINE) throw new ImapError('protocol', 'The mail server sent a line that never ends');
        this.scan = Math.max(0, this.buf.length - 1);
        this.need = this.buf.length + 1;
        return out;
      }
      const line = this.buf.toString('latin1', 0, nl);
      const m = /\{(\d{1,10})\+?\}$/.exec(line);
      if (m) {
        const n = Number(m[1]);
        if (n > this.maxLiteral) throw new ImapError('protocol', `The mail server sent a ${n}-byte piece where at most ${this.maxLiteral} were asked for`);
        if (this.buf.length < nl + 2 + n) {
          this.scan = nl; // the line is known; wait for the literal's bytes
          this.need = nl + 2 + n;
          return out;
        }
        this.parts.push({ text: line.slice(0, m.index) }, { literal: Buffer.from(this.buf.subarray(nl + 2, nl + 2 + n)) });
        this.buf = this.buf.subarray(nl + 2 + n);
        this.scan = 0;
        this.need = 0;
        continue;
      }
      this.parts.push({ text: line });
      out.push(this.parts);
      this.parts = [];
      this.buf = this.buf.subarray(nl + 2);
      this.scan = 0;
      this.need = 0;
    }
  }
}

/** A response's tokens: '(' ')' / { atom } / { str: Buffer } / { nil }. Brackets ([…]) stay inside their atom. */
export function tokenize(parts) {
  const out = [];
  for (const p of parts) {
    if (p.literal) {
      out.push({ str: p.literal });
      continue;
    }
    const s = p.text;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ') i += 1;
      else if (c === '(' || c === ')') {
        out.push(c);
        i += 1;
      } else if (c === '"') {
        let v = '';
        i += 1;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length) i += 1;
          v += s[i];
          i += 1;
        }
        i += 1;
        out.push({ str: Buffer.from(v, 'latin1') });
      } else {
        let v = '';
        while (i < s.length && s[i] !== ' ' && s[i] !== '(' && s[i] !== ')') {
          if (s[i] === '[') {
            const j = s.indexOf(']', i);
            const end = j < 0 ? s.length : j + 1;
            v += s.slice(i, end);
            i = end;
          } else {
            v += s[i];
            i += 1;
          }
        }
        out.push(v.toUpperCase() === 'NIL' ? { nil: true } : { atom: v });
      }
    }
  }
  return out;
}

/** Tokens → nested arrays (lists) of tokens. */
export function nest(tokens) {
  const root = [];
  const stack = [root];
  for (const t of tokens) {
    if (t === '(') {
      const list = [];
      stack.at(-1).push(list);
      stack.push(list);
    } else if (t === ')') {
      if (stack.length > 1) stack.pop();
    } else stack.at(-1).push(t);
  }
  return root;
}
const textOf = (t) => (t?.str ? t.str.toString('latin1') : t?.atom ?? null);

/** A FETCH response's list → { uid, internalDate, size, body (Buffer: the BODY[…] literal), } */
export function fetchItems(list) {
  const out = {};
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = String(list[i]?.atom ?? '').toUpperCase();
    const val = list[i + 1];
    if (key === 'UID') out.uid = Number(val.atom);
    else if (key === 'INTERNALDATE') out.internalDate = parseInternalDate(textOf(val));
    else if (key === 'RFC822.SIZE') out.size = Number(val.atom);
    else if (key.startsWith('BODY[')) out.body = val?.str ?? (val?.nil ? Buffer.alloc(0) : Buffer.from(textOf(val) ?? '', 'latin1'));
  }
  return out;
}

// ---- writing commands ---------------------------------------------------------------------------------------
/** A string argument: quoted when it is plain printable ASCII, else a synchronizing literal (UTF-8 bytes). */
export function astring(s) {
  const v = String(s ?? '');
  if (/^[\x20-\x7e]*$/.test(v)) return `"${v.replace(/[\\"]/g, '\\$&')}"`;
  return { literal: Buffer.from(v, 'utf8') };
}

/** The checks every command passes before it is written (read-only by construction). */
export function checkCommand(name, args) {
  if (!COMMANDS.includes(name)) throw new ImapError('not_allowed', `The suite only reads mailboxes: “${name}” isn’t a command it sends`);
  const text = args.map((a) => (typeof a === 'string' ? a : '{literal}')).join(' ');
  if (name === 'UID FETCH') {
    const m = /^([\d,:]+) \((.+)\)$/.exec(text);
    if (!m) throw new ImapError('not_allowed', 'Malformed FETCH');
    const items = m[2].match(/BODY\.PEEK\[[^\]]*\](<[^>]*>)?|\S+/g) ?? [];
    if (!items.length || !items.every((it) => FETCH_ITEM.test(it))) throw new ImapError('not_allowed', 'The suite only reads messages with BODY.PEEK (nothing is marked read)');
  }
  if (name === 'UID SEARCH' && !/^(UID \d{1,10}:\*|SINCE \d{1,2}-[A-Z][a-z]{2}-\d{4})$/.test(text)) throw new ImapError('not_allowed', 'Malformed SEARCH');
  if (name === 'LIST' && text !== '"" "*"') throw new ImapError('not_allowed', 'Malformed LIST');
  return text;
}

const oneLine = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Open a connection, read the greeting and the capabilities, and log in. → a session (below). Throws ImapError:
 * bad_host, network, timeout, tls, protocol, login_disabled, auth.
 *   secure  true = TLS from the first byte (port 993). false only for this machine (tests), and only with allowPlain.
 */
export async function openImap({ host, port = IMAP_PORT, secure = true, allowPlain = false, username, password, timeoutMs = 20_000, commandMs = null, maxLiteral = DEFAULT_MAX_LITERAL, ca = null, onCommand = null, signal = null }) {
  const h = cleanHost(host);
  if (!secure && !(allowPlain && isLocalHost(h))) throw new ImapError('tls', 'The suite only connects to mail servers over TLS (port 993)');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ImapError('bad_host', 'Port: 993');

  const socket = await new Promise((resolve, reject) => {
    const s = secure
      // Only a CA can be added (tests' own certificate); certificate checking can't be turned off from here.
      ? tls.connect({ host: h, port, servername: net.isIP(h) ? undefined : h, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}), rejectUnauthorized: true })
      : net.connect({ host: h, port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new ImapError('timeout', `${h} didn’t answer in time`));
    }, timeoutMs);
    s.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once('error', (err) => {
      clearTimeout(timer);
      const tlsProblem = /certificate|self[- ]signed|SSL|TLS|unable to verify|ERR_TLS/i.test(`${err.code ?? ''} ${err.message}`);
      reject(new ImapError(tlsProblem ? 'tls' : 'network', tlsProblem
        ? `${h} didn’t offer a valid TLS connection on port ${port} (${oneLine(err.code ?? err.message)})`
        : `Can’t reach ${h} on port ${port} (${oneLine(err.code ?? err.message)})`));
    });
  });

  // The caller's deadline (a whole pull): aborting closes the connection, which ends every wait at once.
  if (signal) {
    if (signal.aborted) socket.destroy();
    else signal.addEventListener('abort', () => socket.destroy(), { once: true });
  }
  const reader = new ResponseReader({ maxLiteral });
  const queue = [];
  let waiter = null;
  let failure = null;
  const fail = (err) => {
    if (!failure) failure = err;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(failure);
    }
  };
  socket.on('data', (chunk) => {
    let got;
    try {
      got = reader.push(chunk);
    } catch (err) {
      socket.destroy();
      fail(err);
      return;
    }
    for (const parts of got) queue.push(parts);
    if (waiter && queue.length) {
      const w = waiter;
      waiter = null;
      w.resolve(queue.shift());
    }
  });
  socket.on('error', (err) => fail(new ImapError('network', `The connection to ${h} failed (${oneLine(err.code ?? err.message)})`)));
  socket.on('close', () => fail(new ImapError('network', `${h} closed the connection`)));

  const next = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter = null;
        socket.destroy();
        reject(new ImapError('timeout', `${h} stopped answering`));
      }, timeoutMs);
      waiter = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  };
  const write = (data) => new Promise((resolve, reject) => socket.write(data, (err) => (err ? reject(new ImapError('network', `Writing to ${h} failed`)) : resolve())));

  let tagN = 0;
  /**
   * Send one command (checked first) and read until its tagged answer. → { untagged: [parts…], text }.
   * NO/BAD → ImapError('refused' | 'protocol').
   */
  async function send(name, args = []) {
    checkCommand(name, args);
    onCommand?.(name);
    tagN += 1;
    const tag = `S${tagN}`;
    // Pieces: text up to each literal; a literal waits for the server's "+" before its bytes go.
    let line = `${tag} ${name}`;
    for (const a of args) {
      if (typeof a === 'string') line += ` ${a}`;
      else {
        await write(`${line} {${a.literal.length}}\r\n`);
        for (;;) {
          const r = await next();
          const t = r[0]?.text ?? '';
          if (t.startsWith('+')) break;
          if (t.startsWith(`${tag} `)) throw new ImapError('protocol', `${h} refused the command: ${oneLine(t.slice(tag.length + 4))}`);
        }
        await write(a.literal);
        line = '';
      }
    }
    await write(`${line}\r\n`);
    const untagged = [];
    let bytes = 0;
    // Each command has its own deadline too (review fix): a server trickling answers can't keep it going for ever.
    const deadline = Date.now() + (commandMs ?? timeoutMs * 3);
    for (;;) {
      if (Date.now() > deadline) {
        socket.destroy();
        throw new ImapError('timeout', `${h} took too long to answer`);
      }
      const r = await next();
      for (const p of r) bytes += p.literal ? p.literal.length : p.text.length;
      if (untagged.length >= MAX_UNTAGGED || bytes > MAX_COMMAND_BYTES) {
        socket.destroy();
        throw new ImapError('protocol', `${h} sent far more than was asked for`);
      }
      const t = r[0]?.text ?? '';
      if (t.startsWith(`${tag} `)) {
        const m = /^\S+ (OK|NO|BAD)\b ?(.*)$/i.exec(t);
        const status = m?.[1]?.toUpperCase();
        if (status === 'OK') return { untagged, text: m[2] };
        throw new ImapError(status === 'NO' ? 'refused' : 'protocol', oneLine(m?.[2] ?? t));
      }
      if (t.startsWith('* BYE')) fail(new ImapError('network', `${h} ended the connection: ${oneLine(t.slice(6))}`));
      untagged.push(r);
    }
  }

  const close = () => socket.destroy();
  try {
    const greeting = (await next())[0]?.text ?? '';
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) throw new ImapError('protocol', `${h} didn’t greet like an IMAP server${greeting.startsWith('* BYE') ? `: ${oneLine(greeting.slice(6))}` : ''}`);
    let caps = /\[CAPABILITY ([^\]]*)\]/i.exec(greeting)?.[1]?.toUpperCase().split(/\s+/) ?? null;
    if (!caps) {
      const r = await send('CAPABILITY');
      const line = r.untagged.map((p) => p[0]?.text ?? '').find((t) => /^\* CAPABILITY /i.test(t)) ?? '';
      caps = line.replace(/^\* CAPABILITY /i, '').toUpperCase().split(/\s+/);
    }
    if (!caps.includes('IMAP4REV1') && !caps.includes('IMAP4REV2')) throw new ImapError('protocol', `${h} doesn’t speak IMAP4rev1`);
    if (caps.includes('LOGINDISABLED')) throw new ImapError('login_disabled', `${h} doesn’t allow a password login here`);
    if (!/^\* PREAUTH/i.test(greeting)) {
      try {
        await send('LOGIN', [astring(username), astring(password)]);
      } catch (err) {
        if (err.code === 'refused' || err.code === 'protocol') {
          throw new ImapError('auth', `The mail server refused the username or app password${err.message ? ` (${oneLine(err.message)})` : ''}`);
        }
        throw err;
      }
    }
  } catch (err) {
    close();
    throw err;
  }

  return {
    /** Every folder: [{ name, attributes: ['\\Sent', …] }] (names decoded from modified UTF-7). */
    async list() {
      const r = await send('LIST', ['""', '"*"']);
      const out = [];
      for (const parts of r.untagged) {
        const t = nest(tokenize(parts));
        if (String(t[1]?.atom).toUpperCase() !== 'LIST') continue;
        const attrs = Array.isArray(t[2]) ? t[2].map((a) => a.atom).filter(Boolean) : [];
        const name = textOf(t[4]);
        if (name !== null && !attrs.some((a) => /^\\noselect$/i.test(a) || /^\\nonexistent$/i.test(a))) out.push({ name: decodeFolder(name), attributes: attrs });
      }
      return out;
    },
    /** Open a folder read-only. → { exists, uidValidity, uidNext } */
    async examine(folder) {
      let r;
      try {
        r = await send('EXAMINE', [astring(encodeFolder(folder))]);
      } catch (err) {
        if (err.code === 'refused') throw new ImapError('no_folder', `There is no folder “${folder}” in this mailbox`);
        throw err;
      }
      const out = { exists: 0, uidValidity: null, uidNext: null };
      for (const parts of r.untagged) {
        const t = parts[0]?.text ?? '';
        let m = /^\* (\d+) EXISTS/i.exec(t);
        if (m) out.exists = Number(m[1]);
        m = /\[UIDVALIDITY (\d+)\]/i.exec(t);
        if (m) out.uidValidity = Number(m[1]);
        m = /\[UIDNEXT (\d+)\]/i.exec(t);
        if (m) out.uidNext = Number(m[1]);
      }
      return out;
    },
    /** UIDs of the open folder's messages that arrived on or after this day. */
    async searchSince(date) {
      return uidsOf(await send('UID SEARCH', [`SINCE ${searchDate(date)}`]));
    },
    /** UIDs from `uid` on (a server answers `n:*` with the last message even when it is below n: those are dropped). */
    async searchFrom(uid) {
      return uidsOf(await send('UID SEARCH', [`UID ${uid}:*`])).filter((u) => u >= uid);
    },
    /** The first `maxBytes` of each whole message. → [{ uid, internalDate, size, body }] */
    async fetchMessages(uids, maxBytes) {
      if (!uids.length) return [];
      return fetchesOf(await send('UID FETCH', [`${uids.join(',')} (UID INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.${maxBytes}>)`]));
    },
    /** Some header fields of each message. → [{ uid, internalDate, body }] */
    async fetchHeaders(uids, fields) {
      if (!uids.length) return [];
      return fetchesOf(await send('UID FETCH', [`${uids.join(',')} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (${fields.join(' ')})])`]));
    },
    async noop() {
      await send('NOOP');
    },
    async logout() {
      try {
        await send('LOGOUT');
      } catch { /* closing anyway */ }
      close();
    },
    close,
  };
}

function uidsOf(r) {
  const out = [];
  for (const parts of r.untagged) {
    const t = parts[0]?.text ?? '';
    if (/^\* SEARCH\b/i.test(t)) for (const n of t.slice(8).trim().split(/\s+/)) if (/^\d+$/.test(n)) out.push(Number(n));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
function fetchesOf(r) {
  const out = [];
  for (const parts of r.untagged) {
    const t = nest(tokenize(parts));
    if (String(t[2]?.atom).toUpperCase() !== 'FETCH' || !Array.isArray(t[3])) continue;
    const item = fetchItems(t[3]);
    if (Number.isInteger(item.uid)) out.push(item);
  }
  return out.sort((a, b) => a.uid - b.uid);
}
