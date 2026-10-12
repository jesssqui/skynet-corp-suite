// A fake iCloud CalDAV server for C6b's tests, answering the way iCloud does where the suite depends on it:
//   - HTTP Basic with the Apple ID and an app-specific password (401 otherwise, or once `revoked`);
//   - PROPFIND / (Depth 0) → current-user-principal "/1234567/principal/";
//   - PROPFIND <principal> → calendar-home-set as an ABSOLUTE address on another host name — iCloud gives
//     "https://p42-caldav.icloud.com:443/1234567/calendars/"; here "http://localhost:<port>/…" (the base is
//     http://127.0.0.1:<port>), so the client follows the partition host the way it must with iCloud;
//   - PROPFIND <home> (Depth 1): the home itself, the scheduling inbox and outbox (not calendars), each
//     calendar (displayname, CalendarServer getctag, sync-token, supported components, Apple's colour) and a
//     reminders-only list (VTODO);
//   - REPORT calendar-query → each object's ETag (with a time-range filter: objects with no instance in the
//     range are left out roughly — by their DTSTART year unless they repeat — so the client never relies on it);
//     REPORT calendar-multiget → calendar-data;
//   - default-namespace XML (xmlns="DAV:" on each element), as iCloud writes it;
//   - every other method → 405. Every request is recorded (method, host, path, depth, whether auth was right).
// Options: redirectRoot (PROPFIND / answers 301 to the localhost host), status overrides per path.
import http from 'node:http';

export const APPLE_ID = 'jessy@icloud.com';
export const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
const PRINCIPAL = '/1234567/principal/';
const HOME = '/1234567/calendars/';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ms = (inner) => `<?xml version="1.0" encoding="UTF-8"?>\n<multistatus xmlns="DAV:">${inner}</multistatus>`;
const ok = (href, props) => `<response xmlns="DAV:"><href>${esc(href)}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`;

/** An .ics with these VEVENT bodies (lines without CRLF; joined here). */
export function ics(...events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.0//EN', 'CALSCALE:GREGORIAN'];
  for (const e of events) lines.push('BEGIN:VEVENT', ...e, 'END:VEVENT');
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

export async function startFakeCaldav(t, { appleId = APPLE_ID, password = APP_PASSWORD, redirectRoot = false } = {}) {
  const dav = {
    appleId,
    password,
    revoked: false,
    requests: [],
    /** path → { status, times } */
    fail: {},
    calendars: new Map(), // id -> { name, color, comps, ctag, objects: Map(name -> { etag, data }) }
    redirectRoot,
    seq: 1,
  };
  dav.addCalendar = (id, { name = id, color = '#1badf8', comps = ['VEVENT'] } = {}) => {
    dav.calendars.set(id, { name, color, comps, ctag: `ctag-${dav.seq++}`, objects: new Map() });
    return dav;
  };
  dav.put = (calId, name, data) => {
    const cal = dav.calendars.get(calId);
    cal.objects.set(`${name}.ics`, { etag: `"e${dav.seq++}"`, data });
    cal.ctag = `ctag-${dav.seq++}`;
  };
  dav.remove = (calId, name) => {
    const cal = dav.calendars.get(calId);
    cal.objects.delete(`${name}.ics`);
    cal.ctag = `ctag-${dav.seq++}`;
  };
  dav.rename = (calId, name) => {
    dav.calendars.get(calId).name = name;
  };
  dav.addCalendar('home', { name: 'Home' }).addCalendar('work', { name: 'Work', color: '#ff2968' });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const auth = req.headers.authorization ?? '';
      const authOk = !dav.revoked && auth === `Basic ${Buffer.from(`${dav.appleId}:${dav.password}`).toString('base64')}`;
      dav.requests.push({ method: req.method, host: req.headers.host, path: url.pathname, search: url.search, depth: req.headers.depth ?? null, authOk, bodyLength: body.length, body });
      const send = (status, text = '', headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8', ...headers });
        res.end(text);
      };
      if (!['PROPFIND', 'REPORT'].includes(req.method)) return send(405, '', { allow: 'PROPFIND, REPORT, GET, PUT, DELETE' });
      if (!authOk) return send(401, '', { 'www-authenticate': 'Basic realm="iCloud"' });
      const f = dav.fail[url.pathname] ?? dav.fail['*'];
      if (f && f.times > 0) {
        f.times -= 1;
        if (f.location) return send(f.status, '', { location: f.location });
        return send(f.status, '');
      }
      const port = server.address().port;
      if (req.method === 'PROPFIND' && (url.pathname === '/' || url.pathname === '/.well-known/caldav')) {
        if (dav.redirectRoot && req.headers.host.startsWith('127.0.0.1')) return send(301, '', { location: `http://localhost:${port}/` });
        return send(207, ms(ok('/', `<current-user-principal><href>${PRINCIPAL}</href></current-user-principal>`)));
      }
      if (req.method === 'PROPFIND' && url.pathname === PRINCIPAL) {
        return send(207, ms(ok(PRINCIPAL, `<calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">http://localhost:${port}${HOME}</href></calendar-home-set>`)));
      }
      if (req.method === 'PROPFIND' && url.pathname === HOME) {
        const parts = [
          ok(HOME, '<resourcetype><collection/></resourcetype>'),
          ok(`${HOME}inbox/`, '<resourcetype><collection/><schedule-inbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>'),
          ok(`${HOME}outbox/`, '<resourcetype><collection/><schedule-outbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>'),
          ok(`${HOME}tasks/`, '<resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname>Reminders</displayname>'
            + '<supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name="VTODO"/></supported-calendar-component-set>'),
        ];
        for (const [id, c] of dav.calendars) {
          parts.push(ok(`${HOME}${id}/`, '<resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>'
            + `<displayname>${esc(c.name)}</displayname><getctag xmlns="http://calendarserver.org/ns/">${c.ctag}</getctag>`
            + `<sync-token>https://example/sync/${c.ctag}</sync-token>`
            + `<supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav">${c.comps.map((n) => `<comp name="${n}"/>`).join('')}</supported-calendar-component-set>`
            + `<calendar-color xmlns="http://apple.com/ns/ical/" symbolic-color="custom">${c.color}FF</calendar-color>`));
        }
        return send(207, ms(parts.join('')));
      }
      const calMatch = /^\/1234567\/calendars\/([^/]+)\/$/.exec(url.pathname);
      if (req.method === 'REPORT' && calMatch && dav.calendars.has(calMatch[1])) {
        const id = calMatch[1];
        const cal = dav.calendars.get(id);
        if (body.includes('calendar-multiget')) {
          const hrefs = [...body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
          const parts = hrefs.map((h) => {
            const o = cal.objects.get(h.split('/').pop());
            if (!o) return `<response><href>${esc(h)}</href><status>HTTP/1.1 404 Not Found</status></response>`;
            return ok(h, `<getetag>${esc(o.etag)}</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">${esc(o.data)}</calendar-data>`);
          });
          return send(207, ms(parts.join('')));
        }
        if (body.includes('calendar-query')) {
          const range = /start="(\d{4})/.exec(body);
          const parts = [];
          for (const [name, o] of cal.objects) {
            // A rough time-range filter (an old one-off event is left out); repeating ones always listed.
            const year = /DTSTART[^:]*:(\d{4})/.exec(o.data)?.[1];
            if (range && year && !o.data.includes('RRULE') && Number(year) < Number(range[1]) - 1) continue;
            parts.push(ok(`${url.pathname}${name}`, `<getetag>${esc(o.etag)}</getetag>`));
          }
          return send(207, ms(parts.join('')));
        }
      }
      return send(404, '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  dav.url = `http://127.0.0.1:${server.address().port}`;
  dav.close = () => new Promise((resolve) => server.close(resolve));
  t.after(() => dav.close());
  return dav;
}
