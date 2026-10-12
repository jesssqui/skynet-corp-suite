// The suite's side of Apple Calendar (C6b): CalDAV reads from iCloud with a person's Apple ID and an
// app-specific password (HTTP Basic). READ-ONLY BY CONSTRUCTION: `request()` is the module's one
// network call, and it allows exactly two methods — PROPFIND and REPORT, which only read — with
// bodies built here from fixed templates (no PUT, DELETE, POST, MKCALENDAR, PROPPATCH, MOVE, COPY:
// anything else throws before a request). Hosts: https only, `caldav.icloud.com` and iCloud's
// partition hosts (`p<NN>-caldav.icloud.com`) — any `*.icloud.com` name — and nothing else; for tests,
// the local port the client was made with (http://127.0.0.1:<port> or localhost:<port> — never in
// production: config.calendar.apple.baseUrl is only changed by tests). Redirects are not followed blindly: iCloud sends
// people to their partition host, so a 301/302/307/308 to an allowed https host is retried there (same
// method and body, at most 3 hops); a redirect anywhere else is an error, and the password never
// leaves for a host that isn't allowed. No query strings; `..` in a path is refused.
//
// The reads (RFC 4791 / 6578, as iCloud answers them):
//   discover()             PROPFIND / (Depth 0) current-user-principal → PROPFIND <principal> calendar-home-set
//   listCalendars(home)    PROPFIND <home> (Depth 1): each calendar's href, name, colour, CTag, components
//   eventEtags(cal, range) REPORT calendar-query (Depth 1): the href and ETag of each event object with an
//                          instance in the range (no data)
//   fetchEvents(cal, hrefs) REPORT calendar-multiget: those objects' calendar-data, 50 at a time
// XML is read by the small parser below (namespaces by their local names; entities; CDATA).

export const ICLOUD_CALDAV = 'https://caldav.icloud.com';
export const READ_METHODS = Object.freeze(['PROPFIND', 'REPORT']);
const MAX_REDIRECTS = 3;
const MULTIGET_CHUNK = 50;
/** Answers bigger than this are refused (a calendar's events for ~10 weeks are far smaller). */
export const MAX_ANSWER_BYTES = 20 * 1024 * 1024;

/** A plain-English problem with a call; never holds the password. */
export class CaldavError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---- hosts ------------------------------------------------------------------------------------------

/** Is this an iCloud host the suite may call (https, `*.icloud.com`)? */
export function isIcloudUrl(u) {
  return u.protocol === 'https:' && /^([a-z0-9-]+\.)*icloud\.com$/i.test(u.hostname) && !u.username && !u.password;
}

/** The URL a call may go to, or throws: an iCloud https host, or the test origin given. */
export function allowedUrl(value, { testOrigin = null } = {}) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new CaldavError('bad_host', 'Not a web address');
  }
  // Tests only: the fake's own port on this machine, under either local name (it plays iCloud's partition host).
  const t = testOrigin ? new URL(testOrigin) : null;
  const local = t && u.protocol === t.protocol && u.port === t.port && ['127.0.0.1', 'localhost'].includes(u.hostname)
    && ['127.0.0.1', 'localhost'].includes(t.hostname);
  if (!isIcloudUrl(u) && !local) throw new CaldavError('bad_host', `Not an iCloud calendar address: ${u.protocol}//${u.host}`);
  if (u.search || u.hash) throw new CaldavError('bad_host', 'A calendar address has no query');
  if (/(^|\/)\.\.(\/|$)/.test(decodeURIComponent(u.pathname))) throw new CaldavError('bad_host', 'A calendar address can’t go up a folder');
  return u;
}

// ---- XML ----------------------------------------------------------------------------------------------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export const xmlUnescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
  if (e[0] === '#') {
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : all;
  }
  return ENTITIES[e.toLowerCase()] ?? all;
});
export const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A small XML reader for WebDAV answers: → the root element { name (local, lower case), attrs, children, text }.
 * Namespace prefixes are dropped (DAV:, CalDAV and CalendarServer names don't collide in what is read).
 */
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<\s*([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack.at(-1);
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      const name = m[2].replace(/^.*:/, '').toLowerCase();
      // Close back to the matching element (tolerates stray tags).
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else if (m[3]) {
      const attrs = {};
      for (const a of (m[4] ?? '').matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].replace(/^.*:/, '').toLowerCase()] = xmlUnescape(a[2] ?? a[3] ?? '');
      const el = { name: m[3].replace(/^.*:/, '').toLowerCase(), attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.text += xmlUnescape(m[6]);
  }
  return root;
}
/** Child elements with this local name (any depth when `deep`). */
export function findAll(el, name, deep = false, out = []) {
  for (const c of el?.children ?? []) {
    if (c.name === name) out.push(c);
    if (deep) findAll(c, name, true, out);
  }
  return out;
}
export const find = (el, name, deep = false) => findAll(el, name, deep)[0] ?? null;
const textOf = (el) => (el ? el.text.trim() : null);

/**
 * A 207 multistatus → [{ href, props: { name → element }, status }] — the props of the 200 propstat
 * only (a 404 propstat lists what the server doesn't have).
 */
export function multistatus(text) {
  const root = parseXml(text);
  const ms = find(root, 'multistatus', true);
  if (!ms) throw new CaldavError('bad_answer', 'iCloud’s answer wasn’t a WebDAV list');
  return findAll(ms, 'response').map((r) => {
    const props = {};
    for (const ps of findAll(r, 'propstat')) {
      const status = textOf(find(ps, 'status')) ?? '';
      if (!/\s2\d\d\s/.test(` ${status} `) && status) continue;
      for (const p of find(ps, 'prop')?.children ?? []) props[p.name] = p;
    }
    return { href: decodeHref(textOf(find(r, 'href'))), props, status: textOf(find(r, 'status')) };
  });
}
const decodeHref = (h) => (h ? h.trim() : h);

// ---- request bodies (fixed templates) -------------------------------------------------------------

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:x="http://apple.com/ns/ical/"';
export const BODIES = Object.freeze({
  principal: `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
  home: `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
  calendars: `<?xml version="1.0" encoding="utf-8"?><d:propfind ${NS}><d:prop><d:resourcetype/><d:displayname/><cs:getctag/>`
    + '<d:sync-token/><c:supported-calendar-component-set/><x:calendar-color/></d:prop></d:propfind>',
});
/** "20261005T040000Z" from ms. */
export const utcText = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
export function queryBody(fromMs, toMs) {
  return `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}><d:prop><d:getetag/></d:prop><c:filter>`
    + '<c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
    + `<c:time-range start="${utcText(fromMs)}" end="${utcText(toMs)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
}
export function multigetBody(hrefs) {
  return `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget ${NS}><d:prop><d:getetag/><c:calendar-data/></d:prop>`
    + hrefs.map((h) => `<d:href>${xmlEscape(h)}</d:href>`).join('') + '</c:calendar-multiget>';
}

// ---- the client ---------------------------------------------------------------------------------------

/**
 * The read client for one person's Apple ID. `baseUrl` = https://caldav.icloud.com (tests: the fake's
 * http://127.0.0.1:<port>, which then is the one non-iCloud origin allowed). `fetchImpl` is replaceable.
 */
export function createCaldavClient({ appleId, password, baseUrl = ICLOUD_CALDAV, timeoutMs = 20_000, fetchImpl = globalThis.fetch }) {
  const base = new URL(baseUrl);
  const testOrigin = base.protocol === 'https:' && isIcloudUrl(base) ? null : base.origin;
  allowedUrl(base.toString(), { testOrigin });
  const auth = `Basic ${Buffer.from(`${appleId}:${password}`, 'utf8').toString('base64')}`;

  /** The module's one network call: PROPFIND or REPORT, a fixed body, redirects only to allowed hosts. */
  async function request(method, url, { depth, body }) {
    if (!READ_METHODS.includes(method)) throw new CaldavError('bad_method', `Only reads are made: ${method} isn’t one`);
    let target = allowedUrl(url, { testOrigin });
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let res;
      try {
        res = await fetchImpl(target.toString(), {
          method,
          headers: { authorization: auth, depth: String(depth), 'content-type': 'application/xml; charset=utf-8', accept: 'application/xml, text/xml' },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        throw new CaldavError(timeout ? 'timeout' : 'network',
          timeout ? `iCloud didn’t answer within ${Math.round(timeoutMs / 1000)} s` : `Can’t reach iCloud (${err?.cause?.code ?? err?.message ?? 'network error'})`);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.arrayBuffer().catch(() => null);
        const loc = res.headers.get('location');
        if (!loc) throw new CaldavError('http', `iCloud answered ${res.status} with nowhere to go`, { status: res.status });
        target = allowedUrl(new URL(loc, target).toString(), { testOrigin }); // throws for any other host
        continue;
      }
      if (res.status === 401) {
        await res.arrayBuffer().catch(() => null);
        throw new CaldavError('unauthorized', 'Apple refused the Apple ID or the app-specific password (made at appleid.apple.com → Sign-In and Security → App-Specific Passwords)', { status: res.status });
      }
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > MAX_ANSWER_BYTES) throw new CaldavError('too_big', 'iCloud’s answer was too big', { status: res.status });
      const text = await res.text();
      if (text.length > MAX_ANSWER_BYTES) throw new CaldavError('too_big', 'iCloud’s answer was too big', { status: res.status });
      if (res.status !== 207 && res.status !== 200) {
        throw new CaldavError('http', `iCloud answered ${res.status}`, { status: res.status });
      }
      return { status: res.status, text, url: target.toString() };
    }
    throw new CaldavError('too_many_redirects', 'iCloud sent the request on too many times');
  }

  const resolve = (href, against) => allowedUrl(new URL(href, against).toString(), { testOrigin }).toString();

  /** The person's calendar home: { principalUrl, homeUrl }. */
  async function discover() {
    const p = await request('PROPFIND', base.toString(), { depth: 0, body: BODIES.principal });
    const principalHref = multistatus(p.text).map((r) => textOf(find(r.props['current-user-principal'], 'href'))).find(Boolean);
    if (!principalHref) throw new CaldavError('bad_answer', 'iCloud didn’t say where this Apple ID’s calendars are');
    const principalUrl = resolve(principalHref, p.url);
    const h = await request('PROPFIND', principalUrl, { depth: 0, body: BODIES.home });
    const homeHref = multistatus(h.text).map((r) => textOf(find(r.props['calendar-home-set'], 'href'))).find(Boolean);
    if (!homeHref) throw new CaldavError('bad_answer', 'iCloud didn’t give this Apple ID’s calendar home');
    return { principalUrl, homeUrl: resolve(homeHref, h.url) };
  }

  /** The calendars in a home that hold events: [{ url, name, color, ctag, syncToken }]. */
  async function listCalendars(homeUrl) {
    const r = await request('PROPFIND', homeUrl, { depth: 1, body: BODIES.calendars });
    const out = [];
    for (const item of multistatus(r.text)) {
      const rt = item.props.resourcetype;
      if (!rt || !find(rt, 'calendar')) continue; // the home itself, inbox, outbox, notifications
      // <comp name="VEVENT"/>: a calendar of reminders only (VTODO) is left out; none listed = any.
      const comps = findAll(item.props['supported-calendar-component-set'], 'comp').map((c) => String(c.attrs.name ?? '').toUpperCase());
      if (comps.length && !comps.includes('VEVENT')) continue;
      out.push({
        url: resolve(item.href, r.url),
        name: (textOf(item.props.displayname) || 'Calendar').slice(0, 200),
        color: /^#[0-9a-f]{6}/i.exec(textOf(item.props['calendar-color']) ?? '')?.[0]?.toLowerCase() ?? null,
        ctag: textOf(item.props.getctag) || null,
        syncToken: textOf(item.props['sync-token']) || null,
      });
    }
    return out;
  }

  /** href + ETag of each event object with an instance in [fromMs, toMs). */
  async function eventEtags(calendarUrl, { fromMs, toMs }) {
    const r = await request('REPORT', calendarUrl, { depth: 1, body: queryBody(fromMs, toMs) });
    return multistatus(r.text)
      .filter((x) => x.props.getetag && x.href)
      .map((x) => ({ url: resolve(x.href, r.url), etag: textOf(x.props.getetag) }));
  }

  /** The objects' iCalendar text: [{ url, etag, data }] (50 a request). */
  async function fetchEvents(calendarUrl, urls) {
    const out = [];
    for (let i = 0; i < urls.length; i += MULTIGET_CHUNK) {
      const chunk = urls.slice(i, i + MULTIGET_CHUNK).map((u) => new URL(u).pathname);
      const r = await request('REPORT', calendarUrl, { depth: 1, body: multigetBody(chunk) });
      for (const x of multistatus(r.text)) {
        const data = x.props['calendar-data']?.text;
        if (!data || !x.href) continue;
        out.push({ url: resolve(x.href, r.url), etag: textOf(x.props.getetag), data });
      }
    }
    return out;
  }

  return { request, discover, listCalendars, eventEtags, fetchEvents, origin: base.origin };
}
