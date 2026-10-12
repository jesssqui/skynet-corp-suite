// A fake IMAP server for D14's tests: the parts of IMAP4rev1 the suite's read-only client uses, on a local port —
// plain TCP, or TLS with the test certificate (fixtures/imap-test-cert.pem). It speaks the rest badly on purpose: any
// command it doesn't know gets BAD. It records every command it receives (name and arguments; LOGIN's password is
// never recorded), so tests can prove the suite only reads, and it keeps per-message flags so a test can show nothing
// was marked read. Commands that change a mailbox (SELECT, STORE, COPY, MOVE, EXPUNGE, APPEND, …) are understood —
// and recorded — only so a test would catch the suite sending one.
//
//   const imap = await startFakeImap({ users: { 'support@tins.ca': 'app-pass' }, folders: ['INBOX', 'Sent'] });
//   imap.add('INBOX', rawEmail, { at: '2026-10-12T14:00:00Z' })  → its uid
//   imap.commands  [{ name, args }]   imap.flagsOf('INBOX', uid)   imap.setUidValidity('INBOX', n)
//   imap.failLogin = true / imap.hang = true / imap.close()
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const internalDate = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};
export const TEST_CERT = fileURLToPath(new URL('./imap-test-cert.pem', import.meta.url));
export const TEST_KEY = fileURLToPath(new URL('./imap-test-key.pem', import.meta.url));

/** Modified UTF-7 → text (the fake stores folder names as typed). */
function decodeFolder(name) {
  return String(name).replace(/&([^-]*)-/g, (_m, b64) => {
    if (!b64) return '&';
    const b = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
    return s;
  });
}
function encodeFolder(name) {
  let out = '';
  let run = '';
  const flush = () => {
    if (!run) return;
    const b = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i += 1) b.writeUInt16BE(run.charCodeAt(i), i * 2);
    out += `&${b.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    run = '';
  };
  for (const ch of name) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += ch === '&' ? '&-' : ch;
    } else run += ch;
  }
  flush();
  return out;
}

/** Simple argument reader: quoted strings, atoms, literals already substituted (as { lit: Buffer }). */
function readArgs(pieces) {
  const out = [];
  for (const p of pieces) {
    if (p.lit) {
      out.push(p.lit.toString('utf8'));
      continue;
    }
    const s = p.text;
    let i = 0;
    while (i < s.length) {
      if (s[i] === ' ') {
        i += 1;
      } else if (s[i] === '"') {
        let v = '';
        i += 1;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\') i += 1;
          v += s[i];
          i += 1;
        }
        i += 1;
        out.push(v);
      } else if (s[i] === '(') {
        const j = s.lastIndexOf(')');
        out.push(s.slice(i, j + 1));
        i = j + 1;
      } else {
        let v = '';
        while (i < s.length && s[i] !== ' ') {
          if (s[i] === '[') {
            const j = s.indexOf(']', i);
            v += s.slice(i, j + 1);
            i = j + 1;
          } else {
            v += s[i];
            i += 1;
          }
        }
        out.push(v);
      }
    }
  }
  return out;
}

function headerFields(raw, names) {
  const bin = raw.toString('latin1');
  const end = bin.search(/\r?\n\r?\n/);
  const head = end < 0 ? bin : bin.slice(0, end);
  const lines = head.split(/\r?\n/);
  const want = new Set(names.map((n) => n.toLowerCase()));
  const out = [];
  let keep = false;
  for (const l of lines) {
    if (/^[ \t]/.test(l)) {
      if (keep) out.push(l);
      continue;
    }
    keep = want.has(l.slice(0, l.indexOf(':')).trim().toLowerCase());
    if (keep) out.push(l);
  }
  return Buffer.from(`${out.join('\r\n')}${out.length ? '\r\n' : ''}\r\n`, 'latin1');
}

export async function startFakeImap({ users = {}, folders = ['INBOX', 'Sent'], tls: useTls = false, greeting = '* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Fake IMAP ready' } = {}) {
  const box = new Map(folders.map((f, i) => [f, { uidValidity: 1000 + i, uidNext: 1, messages: [] }]));
  const state = {
    commands: [],
    sessions: 0,
    failLogin: false,
    hang: false,
    byeOnLogin: false,
    capabilities: 'IMAP4rev1 AUTH=PLAIN',
    specialUse: {}, // folder → '\\Sent'
  };

  function handle(socket) {
    state.sessions += 1;
    let buf = Buffer.alloc(0);
    let pending = null; // { tag, name, pieces, want } while a literal is coming
    let selected = null;
    let authed = false;
    const send = (s) => {
      if (!socket.destroyed) socket.write(s);
    };
    send(`${greeting}\r\n`);

    function run(tag, name, args) {
      state.commands.push({ name, args: name === 'LOGIN' ? [args[0], '[password]'] : args });
      if (state.hang) return; // never answers
      const ok = (t = 'done') => send(`${tag} OK ${t}\r\n`);
      switch (name) {
        case 'CAPABILITY':
          send(`* CAPABILITY ${state.capabilities}\r\n`);
          return ok();
        case 'NOOP':
          return ok();
        case 'LOGOUT':
          send('* BYE logging out\r\n');
          ok();
          return socket.end();
        case 'LOGIN': {
          const [u, p] = args;
          if (state.byeOnLogin) {
            send('* BYE going away\r\n');
            return socket.end();
          }
          if (state.failLogin || users[u] === undefined || users[u] !== p) return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
          authed = true;
          return ok('LOGIN completed');
        }
        default:
      }
      if (!authed) return send(`${tag} BAD not authenticated\r\n`);
      switch (name) {
        case 'LIST':
          for (const f of box.keys()) send(`* LIST (\\HasNoChildren${state.specialUse[f] ? ` ${state.specialUse[f]}` : ''}) "/" "${encodeFolder(f)}"\r\n`);
          return ok();
        case 'EXAMINE':
        case 'SELECT': {
          const f = box.get(decodeFolder(args[0]));
          if (!f) return send(`${tag} NO [NONEXISTENT] no such mailbox\r\n`);
          selected = { name: decodeFolder(args[0]), readOnly: name === 'EXAMINE' };
          send(`* ${f.messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${f.uidValidity}] UIDs valid\r\n* OK [UIDNEXT ${f.uidNext}] next\r\n`);
          return ok(`[${name === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] opened`);
        }
        case 'UID': {
          const f = selected && box.get(selected.name);
          if (!f) return send(`${tag} BAD no mailbox open\r\n`);
          const sub = String(args[0]).toUpperCase();
          if (sub === 'SEARCH') {
            let list = f.messages;
            const key = String(args[1]).toUpperCase();
            if (key === 'SINCE') {
              const [d, m, y] = args[2].split('-');
              const since = Date.UTC(Number(y), MONTHS.indexOf(m), Number(d));
              list = list.filter((x) => x.at.getTime() >= since);
            } else if (key === 'UID') {
              const [a, b] = args[2].split(':');
              const from = Number(a);
              list = list.filter((x) => x.uid >= from);
              if (b === '*' && !list.length && f.messages.length) list = [f.messages.at(-1)]; // as real servers do
            } else return send(`${tag} BAD unknown search\r\n`);
            send(`* SEARCH${list.map((x) => ` ${x.uid}`).join('')}\r\n`);
            return ok();
          }
          if (sub === 'FETCH') {
            const uids = new Set();
            for (const r of String(args[1]).split(',')) {
              const [a, b] = r.split(':');
              const lo = Number(a);
              const hi = b === undefined ? lo : b === '*' ? Infinity : Number(b);
              for (const m of f.messages) if (m.uid >= lo && m.uid <= hi) uids.add(m.uid);
            }
            const items = String(args[2]).slice(1, -1);
            const peek = /BODY\.PEEK\[/i.test(items);
            const touches = /(^|\s)(BODY\[|RFC822(\s|\)|$)|RFC822\.TEXT)/i.test(items);
            for (const [i, m] of f.messages.entries()) {
              if (!uids.has(m.uid)) continue;
              if (touches && !selected.readOnly) m.flags.add('\\Seen');
              let out = `* ${i + 1} FETCH (UID ${m.uid}`;
              const chunks = [];
              if (/INTERNALDATE/i.test(items)) out += ` INTERNALDATE "${internalDate(m.at)}"`;
              if (/RFC822\.SIZE/i.test(items)) out += ` RFC822.SIZE ${m.raw.length}`;
              const hf = /BODY(?:\.PEEK)?\[HEADER\.FIELDS \(([^)]*)\)\]/i.exec(items);
              const whole = /BODY(?:\.PEEK)?\[\](?:<(\d+)\.(\d+)>)?/i.exec(items);
              if (hf) {
                const data = headerFields(m.raw, hf[1].split(/\s+/));
                chunks.push([`${out} BODY[HEADER.FIELDS (${hf[1].toUpperCase()})] {${data.length}}\r\n`, data]);
                out = '';
              } else if (whole) {
                const start = whole[1] ? Number(whole[1]) : 0;
                const data = whole[2] ? m.raw.subarray(start, start + Number(whole[2])) : m.raw;
                chunks.push([`${out} BODY[]${whole[1] ? `<${start}>` : ''} {${data.length}}\r\n`, data]);
                out = '';
              }
              for (const [head, data] of chunks) {
                send(head);
                send(data);
              }
              send(`${out})\r\n`);
            }
            return ok();
          }
          return send(`${tag} BAD unknown UID command\r\n`);
        }
        default:
          // STORE, COPY, MOVE, EXPUNGE, APPEND, DELETE, … — the suite never sends them (recorded above).
          return send(`${tag} BAD not supported here\r\n`);
      }
    }

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (pending?.want) {
          if (buf.length < pending.want) return;
          pending.pieces.push({ lit: buf.subarray(0, pending.want) });
          buf = buf.subarray(pending.want);
          pending.want = 0;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.toString('latin1', 0, nl);
        buf = buf.subarray(nl + 2);
        const lit = /\{(\d+)\+?\}$/.exec(line);
        if (!pending) {
          const m = /^(\S+) (UID \S+|\S+) ?(.*)$/.exec(line);
          if (!m) continue;
          const [tag, name] = [m[1], m[2].toUpperCase().startsWith('UID ') ? 'UID' : m[2].toUpperCase()];
          const rest = m[2].toUpperCase().startsWith('UID ') ? `${m[2].slice(4)} ${m[3]}` : m[3];
          pending = { tag, name, pieces: [] };
          if (lit) {
            pending.pieces.push({ text: rest.slice(0, rest.length - lit[0].length) });
            pending.want = Number(lit[1]);
            send('+ go ahead\r\n');
            continue;
          }
          pending.pieces.push({ text: rest });
        } else if (lit) {
          pending.pieces.push({ text: line.slice(0, line.length - lit[0].length) });
          pending.want = Number(lit[1]);
          send('+ go ahead\r\n');
          continue;
        } else pending.pieces.push({ text: line });
        const { tag, name, pieces } = pending;
        pending = null;
        const args = readArgs(pieces);
        const full = name === 'UID' ? `UID ${String(args[0]).toUpperCase()}` : name;
        if (name === 'UID') run(tag, 'UID', args);
        else run(tag, name, args);
        if (name === 'UID') state.commands.at(-1).name = full;
      }
    });
    socket.on('error', () => {});
  }

  const server = useTls
    ? tls.createServer({ key: fs.readFileSync(TEST_KEY), cert: fs.readFileSync(TEST_CERT) }, handle)
    : net.createServer(handle);
  const sockets = new Set();
  server.on(useTls ? 'secureConnection' : 'connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return Object.assign(state, {
    port: server.address().port,
    host: '127.0.0.1',
    /** Put a message in a folder (as delivered at `at`). → its uid */
    add(folder, raw, { at = new Date() } = {}) {
      const f = box.get(folder);
      if (!f) throw new Error(`no folder ${folder}`);
      const uid = f.uidNext;
      f.uidNext += 1;
      f.messages.push({ uid, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8'), at: new Date(at), flags: new Set() });
      return uid;
    },
    flagsOf: (folder, uid) => [...(box.get(folder)?.messages.find((m) => m.uid === uid)?.flags ?? [])],
    count: (folder) => box.get(folder)?.messages.length ?? 0,
    /** A new UIDVALIDITY (the server renumbered the folder): every message gets a new uid. */
    setUidValidity(folder, n) {
      const f = box.get(folder);
      f.uidValidity = n;
      f.uidNext = 1;
      for (const m of f.messages) {
        m.uid = f.uidNext;
        f.uidNext += 1;
      }
    },
    addFolder(name) {
      box.set(name, { uidValidity: 5000 + box.size, uidNext: 1, messages: [] });
    },
    /** Names of the commands received, in order (UID FETCH, EXAMINE, …). */
    names: () => state.commands.map((c) => c.name),
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  });
}

/** A customer's email, as a mail app sends it. */
export function email({ from = 'Pat Smith <pat@example.com>', to = 'support@tins.ca', subject = 'Where is my order?', id, inReplyTo = null, references = null,
  date = 'Mon, 12 Oct 2026 10:00:00 -0400', text = 'Hello', html = null, attachments = [], headers = {} } = {}) {
  const lines = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${date}`, `Message-ID: <${id}>`];
  if (inReplyTo) lines.push(`In-Reply-To: <${inReplyTo}>`);
  if (references) lines.push(`References: ${references.map((r) => `<${r}>`).join(' ')}`);
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push('MIME-Version: 1.0');
  if (!html && !attachments.length) {
    lines.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text, '');
    return lines.join('\r\n');
  }
  lines.push('Content-Type: multipart/mixed; boundary="mix"', '', '--mix');
  if (html) {
    lines.push('Content-Type: multipart/alternative; boundary="alt"', '', '--alt', 'Content-Type: text/plain; charset=utf-8', '', text, '--alt',
      'Content-Type: text/html; charset=utf-8', '', html, '--alt--');
  } else lines.push('Content-Type: text/plain; charset=utf-8', '', text);
  for (const a of attachments) {
    lines.push('--mix', `Content-Type: application/octet-stream; name="${a}"`, `Content-Disposition: attachment; filename="${a}"`, 'Content-Transfer-Encoding: base64', '',
      Buffer.from(`secret contents of ${a}`).toString('base64'));
  }
  lines.push('--mix--', '');
  return lines.join('\r\n');
}
