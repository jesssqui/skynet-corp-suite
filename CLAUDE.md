# Skynet Corp Suite

Private business and life management suite (Skynet Corp Suite; `suite` is the short name used in code, packages and file names) for two people. Runs in Docker on the Mac mini at
home beside the Wholesale Order Manager, reachable only over Tailscale (Tailscale Serve gives it HTTPS). The CRM is its
core (later packages); this repo currently holds the skeleton from package **C0** (server, client shell, one example
module `health`, tests, Docker, nightly backups), the server half of offline sync from **C2a** (module `sync`),
sign-in from **C1** (module `auth`: two accounts, password + authenticator code, sessions, devices), the browser half
of offline sync from **C2b** (the on-device copy and outbox in IndexedDB, a service worker so the app opens with no
signal, the sync bar and the Needs attention page), the CRM's core records from **C3a** (module `crm`: our businesses,
clients, accounts, contacts, consent, relationships, services, activities, links — all synced) and its screens from
**C3b** (client list and search, the client page with its timeline, quick notes and call logs — all offline), and the
planner from **C4a** (module `planner`: tasks, the shared list, the capture inbox, each person's Today with the morning
plan, and the "No next step" flag on relationships — all synced and offline), and planning from **C4b** (same module:
week goals and month priorities, the Monday and monthly plans, the Friday review, Focus, the overbooked-day warning),
and client intake from **C7** (Quick add — a one-line-per-client brain dump saved offline — and the accounting CSV
import, which runs on the server and never overwrites or creates anything twice), and from **C8** the Connections
screen (module `connections`: every connection's last success, queue and last error, with an off switch) and the
automation framework (module `automations`: trigger, on/off, silent/alert, runs, the minute scheduler, synced in-app
alerts) with the first two automations (the planner's Friday review list and relationships with no next step), and
from **D1** the wholesale connection (module `wholesale`: the signed receiver for the Order Manager's outbox, a
holding area for everything it sends, linking its customers to accounts, and their orders, payments, returns and
refunds on the client timeline with spend and last order), and from **D3** the wholesale automations (same module:
check-ins for quiet regulars, balance reminders over 30 days with a drafted email, ready-to-ship tasks on packed
orders, and the "Quiet regular" flag on the client list and page), and from **D5** notes from the Order Manager (same
module: its CRM notes on the linked client's timeline, and its follow-up dates as tasks).

## Stack
- **Server**: Node 22+ (ESM), Express 5, SQLite via better-sqlite3 (WAL, foreign keys, busy_timeout), helmet. Port **3100**.
- **Client**: React 18 + Vite 6, react-router-dom 7 (same API as the v6 the Order Manager uses), inline styles + theme tokens.
- **Shared**: `shared/` (`@suite/shared`) holds code that runs in both Node and the browser (IDs, time helpers).
- npm workspaces: one `npm ci` at the root installs everything; one `package-lock.json`.
- Dependencies are kept few and mainstream; ask before adding one. `qrcode-generator` (MIT, no dependencies) draws the
  authenticator QR code: in the terminal for `users.js add/reset-2fa` (server) and on the Account page (client).
  Dev only: `fake-indexeddb` (client tests: IndexedDB in Node) and `playwright-core` (pinned to 1.56.0 to match the
  Chromium build in this environment's `PLAYWRIGHT_BROWSERS_PATH`; `npm run test:e2e`). No IndexedDB or service-worker
  library: `client/src/sync/idb.js` and the small Vite plugin in `client/vite.config.js` do what is needed.

## Commands (repo root)
```bash
npm ci                 # install everything
npm test               # shared + server + client tests (node --test) and a client build — must pass before every commit
npm run test:e2e       # client build + Playwright (Chromium, iPhone emulation) against a real server; separate (needs a
                       # browser: PLAYWRIGHT_BROWSERS_PATH here, `npx playwright-core install chromium` on a Mac)
npm run dev:server     # API on http://127.0.0.1:3100 (data in ./data, git-ignored)
npm run dev:client     # Vite on http://localhost:5173, proxies /api to :3100
npm run build && npm start   # production-style: server also serves client/dist
npm run backup         # one backup now (same code as the nightly one)
npm run restore -- --list | <file> [--to <path>] [--force]
npm run user:add -- --actor owner|partner --username <name> --name "Display"   # the only way to make an account (sets up 2FA)
npm run user:list | user:password -- <username> | user:reset-2fa -- <username> | user:unlock -- <username>
```
Deploying, Tailscale Serve, backup scheduling and the restore drill: **DEPLOY.md**.

## Layout
```
shared/                    @suite/shared — ids.js (UUIDv7), time.js, hlc.js (sync clock stamps), actors.js (+ OWNERS),
                           fields.js (synced field types + value checks, used by the server and devices),
                           normalize.js (clean emails/phones/postal codes/tags), crm.js (CRM value lists, our
                           businesses' fixed ids, the consent rule), planner.js (task/inbox value lists, "HH:MM"
                           times, automatedTaskOwner, the "no next step" rule; C4b: GOAL_KINDS, goal periods,
                           addDays/weekStart/monthStart, WORKDAY_IDS + dayMinutesOf, isUnplannedTask);
                           C7: csv.js (CSV reader: quotes, BOM, ; and tab, line ends), intake.js (rows from a brain dump
                           or a CSV: cleanRow, nameKey/similarNames, buildMatchIndex/findMatch/flagRows, planRow,
                           fingerprintText/rowKey, detectMapping/rowFromCells); tests in shared/test
server/src/
  index.js                 start: open db, createApp, listen, heartbeat, backup schedule, shutdown
  app.js                   createApp({config, db, log}) — migrations, services, routes, static client, errors
  config.js                every setting, from env (see .env.example)
  db/open.js               openDb(): the only way to open SQLite (pragmas)
  db/migrate.js            per-module migrations, schema_migrations table
  modules/index.js         server module registration list (order = migration order)
  modules/<name>/          index.js (shape), routes.js, service.js, migrations/NNN_name.sql|js
  modules/auth/            sign-in: crypto.js (scrypt, TOTP, codes), accounts.js + throttle.js (shared with the CLI),
                           service.js (sessions, devices, the request guard, restore check), routes.js, deviceName.js
  modules/sync/            offline sync: registry.js, service.js, routes.js, identity.js (session -> actor + device)
  modules/crm/             CRM core records: entities.js (the record types), service.js (registration, seeds, reads),
                           routes.js (read API + C7's import routes), import.js (C7: the CSV import — preview, commit
                           in chunks through applyLocal, remembered rows, batches), migrations/001_create_crm.sql,
                           002_import.sql (crm_import_batches, crm_import_rows: not synced)
  modules/planner/         tasks + inbox (C4a), goals + workdays (C4b): entities.js, service.js (registration,
                           checkTask/checkGoal/checkWorkday, automatedOwnerFor, goals(), seedWorkdays; C8 reads for
                           its automations), migrations/001_create_planner.sql, 002_goals.sql; no routes.
                           C8: automations.js (friday-review, no-next-step: reviewNumbers, relationshipsToChase)
  modules/connections/     C8: service.js (the registry: register/placeholder/setPaused/list, the backup row,
                           PLACEHOLDERS), routes.js (GET /, PUT /:id), migrations/001 (connections_switches, _changes)
  modules/automations/     C8: service.js (registry, execute/runNow/tick/emit, startScheduler, alerts + onAlert),
                           schedule.js (triggers, triggerText, periodOf, isoWeekKey — local time, DST-safe),
                           routes.js (GET /, PUT /:id, POST /:id/run), migrations/001 (settings, changes, runs, made,
                           the synced automations_alerts)
  modules/wholesale/        D1: index.js (signedRoutes, keepOnRestore), service.js (receive, hold, reconcile/attach,
                           project, link/create/unlink, lists, the 'wom' connection), events.js (A10 envelope + data
                           checks, pure), figures.js (spend/paid/credit rules, pure), secret.js (secret, AES-GCM with
                           the key file, HMAC check), entities.js (synced wholesale_customer/_order/_entry, server-only
                           check), routes.js (POST /api/wom/events + /api/wholesale/*), migrations/001..003.
                           D3: automations.js (wholesale-check-in, wholesale-balances, wholesale-ready-to-ship), figures.js
                           also holds orderRhythm / owingByOrder / overdueOrders (pure). D5: followUps.js
                           (wholesale-follow-ups: followUpPlan, followUpKey), migrations/004_notes.sql (held notes,
                           follow-up columns, the synced wholesale_notes)
  backup/                  backup.js, restore.js (D5: runs this version's migrations on the restored copy, then
                           carryKeptTables: modules' keepOnRestore), schedule.js
  lib/                     log.js, httpError.js, serverLock.js (heartbeat file)
server/scripts/            backup.js, restore.js, users.js (CLIs)
scripts/wom-e2e.mjs        D1: the real Order Manager (a checkout) against a real suite: `npm run test:wom -- <path>`
server/test/               node --test; helpers.js: tmpDir/testConfig/startApp/testClock/ensureTestUsers/sessionFor/dumpDb;
                           fixtures/syncdemo = test-only synced module; fixtures/conndemo = test-only connection (C8);
                           fixtures/wom.js = A10 event builders + signed POST (D1; D5: note, noteAdded, noteDeleted,
                           followUpChanged), wom-captured-events.json = a real Order Manager's events and (D5)
                           wom-captured-notes.json its A11 events (scripts/wom-e2e.mjs --capture)
client/src/
  main.jsx, App.jsx        providers + router built from the module list, behind AuthGate and SyncProvider;
                           main.jsx registers the service worker (production builds)
  auth/                    session.jsx (AuthProvider, useAuth), SignInScreen.jsx (+ AuthGate), TwoFactorParts.jsx,
                           Qr.jsx, device.js (device id, remembered session, clearLocalData)
  sync/                    offline sync, browser side (C2b): engine.js (the engine), overlay.js (what is shown),
                           localdb.js + idb.js (IndexedDB), index.js (store + the app's engine), hooks.js, SyncProvider.jsx,
                           components.jsx (SyncBar, ClashPanel, SyncBadges, FieldInput/FieldsForm)
  sw/                      service-worker.js (built to dist/sw.js), register.js (registration + update flow)
  shell/                   AppShell (sidebar on desktop, bottom tab bar on phones), shell.css, SyncBar slot,
                           UpdateBanner ("new version ready · Reload"), BackupBanner
  ui/                      the shared look: theme.css (tokens, light/dark), theme.jsx, components.jsx (incl. Sheet, SelectField,
                           TextAreaField, CheckboxField, Switch), ui.css (the Sheet's media queries), icons.jsx; import from ui/index.js.
                           ui/format.js: formatDate/formatDateTime/formatDay (local time), toDateTimeInput/fromDateTimeInput
  modules/index.js         client module registration list -> nav + routes (a module's `nav` may be a list; `Badge`)
  modules/<name>/          index.jsx ({ id, nav, routes }) + pages
  api/client.js            fetch wrapper (api.get/post/put/del, ApiError); sends X-Suite-Device; 401 session codes
                           fire SESSION_LOST_EVENT
  api/useServerData.js     C8: pages of server settings (not synced): load, re-check on foreground/online/30 s, `offline`
  modules/health/          SystemPage (/system), SystemTabs.jsx (System · Connections · Automations)
  modules/connections/     C8: ConnectionsPage (/system/connections; /connections redirects)
  modules/automations/     C8: AutomationsPage (/system/automations; /automations redirects), AlertsPage (/alerts),
                           AlertsBell.jsx (sidebar "Alerts" + count, the phone strip, useUnreadAlerts), alerts.js +
                           logic.js (no React; client/test/automations.test.js)
  modules/sync/            /sync (Offline data), /sync/attention (Needs attention), /sync/data/:entity (plain records view)
  modules/wholesale/       D1: WholesalePage (/wholesale: waiting for a client / linked; lazy), ConnectionPanel.jsx (the
                           wom card's address + secret, via connections/panels.js; lazy), parts.jsx (timeline rows,
                           account and client figures on the client page; D3: QuietRegularBadge; D5: note rows, the
                           next follow-up), logic.js (no React; D3: isQuietRegular, quietRegularText, quietFromByClient;
                           D5: noteItem, NOTE_LABELS, NOTE_FILTER_TYPES, nextFollowUp; client/test/wholesale.test.js)
  modules/crm/             C3b screens: ClientListPage (/crm), ClientPage (/crm/clients/:id), BusinessesPage
                           (/crm/businesses), forms.jsx (add/edit sheets), parts.jsx (chips, RecordSync, FormSheet),
                           data.js (cached offline reads), formFields.js (form values -> changed fields), logic.js (search, timeline filters, money, consent, errors — no
                           React, tested in client/test/clients.test.js), crm.css (layout media queries).
                           C7: QuickAddPage (/crm/quick-add) + quickAdd.js (the line parser, rows, no React;
                           client/test/quickadd.test.js), ImportPage (/crm/import); both lazy-loaded (React.lazy in crm/index.jsx; the
                           service worker caches their chunks, so they open offline)
  modules/planner/         C4a screens: TodayPage (/), InboxPage (/inbox), TasksPage (/tasks), PlanSheet (Plan my day),
                           ClientTasksCard.jsx (the client page's Tasks card + "No next step · Add"), forms.jsx
                           (TaskSheet, InboxNoteSheet, newTaskInitial), parts.jsx (TaskRow, tick, CaptureBar, useToday),
                           data.js (cached reads via crm/data.js), prefs.js (last business per person on this device,
                           ticks kept this session, the review's ticks), logic.js + taskForm.js (no React;
                           client/test/planner*.test.js), planner.css.
                           C4b: WeekPlanPage (/plan/week), MonthPlanPage (/plan/month), ReviewPage (/plan/review),
                           FocusPage (/focus), goals.jsx (GoalSheet, GoalItem, GoalTick, CarryOver), planParts.jsx
                           (PlanTabs, Meter, DayLoadPanel, SortList), plan.js + goalForm.js (no React;
                           client/test/plan.test.js, planning-forms.test.js)
client/public/             manifest.webmanifest, icons (placeholders)
client/test/               node --test: the engine against a real server with syncdemo + fixtures/chk (a UNIQUE column),
                           overlay, the CRM screens' logic (clients.test.js) and forms with two devices
                           (clients-forms.test.js), the planner's logic (planner.test.js, plan.test.js) and two
                           devices (planner-forms.test.js, planning-forms.test.js), automations on devices
                           (automations.test.js); fake-indexeddb
test/e2e/                  Playwright end-to-end tests (npm run test:e2e); proxy.js cuts the server off for real outages
```

## Modules
One folder per module on each side, same name on both (`server/src/modules/health`, `client/src/modules/health`).
- **Server shape** (`modules/<name>/index.js`): `{ name, migrationsDir, createService(ctx), createRouter(ctx, service),
  createPublicRouter?, start?, bodyLimits?, keepOnRestore?, signedRoutes? }`. `signedRoutes: [{ method, path, handlers }]`
  (D1): exact POST/PUT `/api/...` routes that authenticate each request themselves (a signature over the raw body),
  mounted **before** the Origin/JSON guard and the JSON parser; any other method or path still goes through the guard.
  Only for server-to-server calls (the Order Manager's outbox); never for anything a browser calls. `keepOnRestore: ['table', …]` (C8): those tables keep the
  current rows across a restore (`restore.js` copies them into the restored copy) — for switches, never for data. **One
  exception (D1)**: the wholesale module's holding area, event keys and receiver status are kept too — they mirror
  another app (the Order Manager), which never re-sends what it already delivered, so rolling them back would lose its
  changes (deletes above all) for good; the synced records are rebuilt from them at start (D5: its held notes and
  follow-up dates too). `bodyLimits: { '/import': '8mb' }` lets a path take JSON bodies bigger
  than the app's 1 MB (signed in only; crm's CSV import). `start(ctx, service)` runs once every service exists (auth uses it to notice a
  restore). Routes mount at `/api/<name>`. **Every `createRouter` route requires a signed-in session**
  (app.js puts `auth.requireSession` in front; `req.auth = { user: { id, actor, username, displayName }, device: { id,
  name }, session }`). `createPublicRouter` is only for routes that must work signed out (sign-in, the minimal health
  check) — don't add one without a reason. `ctx = { db, config, log, services, now }` (`now()` = ms clock, tests move it);
  `ctx.services.<other>` is how a module uses another one. **A module reads and writes only its own tables** — never
  another module's.
- **Client shape** (`modules/<name>/index.jsx`): `{ id, nav: { label, icon, order, path? }, routes: [{ path, element }] }`.
  `nav` may be a list of entries (each with its own `id`; the planner has Today, Inbox and Tasks) and an entry may
  have `Badge`, a component shown beside its label (the inbox's count).
  Add it to `client/src/modules/index.js`; the shell's nav and router pick it up. Icons are named (`ui/icons.jsx`).
- To add a module: create both folders, register in both lists, add tests in `server/test/<name>.test.js`.

## Database rules
- Open connections only with `openDb()` (WAL, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`).
- Migrations: `modules/<name>/migrations/NNN_snake_name.sql` (or `.js` exporting a **synchronous** `up(db)`), applied once
  each, in registration order then file order, each in a transaction, recorded in `schema_migrations(module, name)`.
  Never edit a shipped migration; add a new one. Table names start with the module name (`health_meta`, `crm_clients`).
  `PRAGMA foreign_keys` can't change inside a transaction — a table rebuild needs SQLite's 12-step recipe.
- **IDs**: every record's primary key is a UUIDv7 string from `newId()` (`@suite/shared/ids`), `TEXT PRIMARY KEY`.
  Never INTEGER AUTOINCREMENT — records will be created on devices while offline (C2). `isId()` validates input.
- **Times**: `nowIso()` → `"2026-10-06T14:03:22.120Z"` (UTC, made in JS, sorts as text). Not `datetime('now')`.
  Calendar dates are `"YYYY-MM-DD"` (`localDate`, `parseLocalDate`); never `new Date('YYYY-MM-DD')` (UTC shift).
- Store emails lowercase and phones digits-only (plan: matching across businesses): give such synced fields a `format`
  (below) and both sides keep to it.

## Security posture
- **Network**: the server binds `127.0.0.1` by default; in Docker it listens on 0.0.0.0 inside the container but
  compose publishes it on the Mac's `127.0.0.1:3100` only, and Tailscale Serve is the only way in from other devices
  (tailnet members only). Keep it that way even with sign-in: don't publish the port on other interfaces, and don't
  enable Tailscale Funnel.
- **Sign-in on everything**: every API route needs a session except `POST /api/auth/login|login/code`,
  `POST /api/wom/events` (D1: no session, authenticated by its HMAC signature only — see "Wholesale") and
  `GET /api/health` (which answers anonymous callers with `{ ok, name, version, time }` only; details, backup paths
  and errors need a session). Unknown `/api` paths answer 401 to anonymous callers. The built client (HTML/JS) is public;
  it shows nothing until `GET /api/auth/session` succeeds — except on a device where someone was signed in before:
  there it opens at once from the remembered session and shows that device's own offline copy (IndexedDB) while the
  check runs (offline: until the server can be reached). Nothing is fetched from the server without a session; a
  session that ended or a device signed out elsewhere is found out at the first request that reaches the server.
- The service worker caches only the built app (same files the server gives anyone); it never caches `/api`. Signing
  out keeps that cache (no personal data in it) so the app still opens offline afterwards.
- helmet sets a strict CSP (`script-src 'self'`): no inline scripts, no third-party script/style hosts. The service
  worker is a same-origin script (`worker-src` falls back to `script-src 'self'`); the cached `index.html` keeps its
  CSP header, so pages served offline have the same policy (the e2e test checks for violations).
- **No HSTS** (helmet's is off): browsers apply it to the whole ts.net hostname on every port, which would force the
  Order Manager's plain-http port on the same Mac to https. Tailscale Serve already makes the suite HTTPS-only.

## Sign-in (auth module, C1)
Code `server/src/modules/auth/`, client `client/src/auth/` + `client/src/modules/auth/`, tests `server/test/auth.test.js`.
- **Accounts**: exactly two, one per actor (`owner`, `partner` — `@suite/shared/actors`, also what sync records as
  "who"). Made only by `server/scripts/users.js` (`npm run user:add`), never over HTTP; usernames lowercase.
  **Two-factor is set up by the CLI, with the account**: `add` validates, asks for the password, shows a terminal QR
  code + key + otpauth link, asks for one code from the app, and only then saves the account, its TOTP secret and 10
  recovery codes in one transaction (then prints the codes once). There is no web enrolment: an account without
  `auth_totp` can't sign in (it gets the same `bad_credentials` as a wrong password; the server log says why).
  `reset-2fa` (lost phone *and* lost codes) works the same way and replaces the authenticator and codes only after the
  new code is confirmed; `password` sets a new password. Both sign the person out everywhere and unlock the account;
  `unlock <username>` only clears rate-limit locks (the account's, and those of addresses that failed on it);
  `unlock --all` clears every lock.
- **Factors**: password (scrypt N=2^16 r=8 p=1, parameters stored in each hash, at most 2 hashes at once) **and**
  an authenticator code (TOTP RFC 6238: SHA-1, 6 digits, 30 s, ±1 step, each step usable once — `auth_totp.last_step`)
  or one of 10 one-time recovery codes (60 bits, stored as SHA-256). All secret comparisons are constant-time.
  In-app: change password (current password; other sessions end), new recovery codes and "move to a new
  authenticator" (password + a current code, which may be a recovery code; the new app's first code confirms it;
  other sessions end).
- **Passkey seam** (not built): a passkey is both factors at once. Add `auth_passkeys` (credential id, public key,
  counter, user), `POST /login/passkey/options` + `/login/passkey` in the public router, verify, then call
  `service.startSession({ user, deviceHint, installed, userAgent, ip, secondFactor: 'passkey' })` — the same function the
  code steps use, so devices and cookies work unchanged. `second_factor`, `end_reason` and challenge `kind` have no
  CHECK lists so this needs no table rebuild. Registering a passkey belongs on the Account page behind `recheck()`.
- **Sign-in endpoints** (public): `POST /api/auth/login {username, password, deviceId?, installed?}` →
  `{ next: 'code', challenge, expiresAt }`; `POST /login/code {challenge, code}` (TOTP or recovery code) → session
  cookie + `{ user, device, session, deviceReplaced, usedRecoveryCode, recoveryCodesLeft }`. A challenge is a random
  token (hashed in `auth_challenges`), 5 min, 5 tries. Wrong username and wrong password give the identical 401 `bad_credentials`.
- **Signed-in endpoints**: `GET /session`, `POST /logout` (signs this device out), `GET /devices` (both people's),
  `PUT /devices/:id {name}`, `POST /devices/:id/sign-out` (any device, either person), `GET /account`,
  `POST /account/password {currentPassword, newPassword}`, `POST /account/recovery-codes {password, code}`,
  `POST /account/two-factor/reset {password, code}` → `{ challenge, enroll }`, `POST /account/two-factor/confirm
  {challenge, code}`. Re-check failures are 403 (not 401: the session is fine).
- **Sessions**: 32 random bytes (base64url) in cookie `suite_session` — `HttpOnly; SameSite=Strict; Path=/`, `Secure`
  when the request is HTTPS (`req.secure`, via trust proxy), `Max-Age` 90 days. Only SHA-256(token) is stored
  (`auth_sessions`). Ends after `SESSION_IDLE_DAYS` (30) unused or `SESSION_MAX_DAYS` (90) after sign-in, whichever
  first; last-seen is written at most once a minute. One session per device.
- **Trust proxy**: `TRUST_PROXY` (default `loopback`; compose sets `loopback, uniquelocal` because Docker Desktop's port
  forwarder delivers Serve's connections from the container network's gateway). Tailscale Serve keeps `Host` and sets
  `X-Forwarded-Proto: https`, `X-Forwarded-Host` and `X-Forwarded-For` (its own values, not the client's), so
  `req.secure`, `req.host` and `req.ip` (the device's 100.x address) are right.
- **CSRF**: (1) the cookie is SameSite=Strict, so no other site's request carries it; (2) every POST/PUT/PATCH/DELETE
  under `/api` — sign-in included — must send `Origin` equal to this server's own origin as the browser saw it
  (`req.protocol://req.host`) or one in `ALLOWED_ORIGINS`, and `Sec-Fetch-Site`, when sent, must be `same-origin`;
  (3) request bodies must be `application/json` (415 otherwise), which a cross-site form can't send and a cross-site
  fetch can only send after a CORS preflight that the server never approves. GET routes must not change anything.
  No token is needed on top: all three would have to fail at once. (The Vite dev proxy keeps `changeOrigin: false` so
  Host matches the page's origin.)
- **Rate limiting** (`throttle.js`, table `auth_throttle`, survives restarts): every password or code attempt — sign-in
  and re-checks — is charged *before* checking (refunded if right, including any lock it set, so parallel guesses can't
  slip past) to three keys, all keyed by the username as typed (unknown usernames too: no enumeration):
  `acct-ip:<user>@<ip>` (the strict limit is per account **+ address**, not per device id) — 5 failures lock it 1 min,
  doubling to 1 h; `acct:<user>` — 30 failures within an hour lock the account 15 min; `ip:<ip>` — 20 failures (any
  usernames) lock that address 1 min, doubling to 1 h. Each tailnet device has its own address, so someone guessing
  from their device locks only that address out of the account (one guess an hour keeps *them* at the 1-hour cap,
  never the account's owner at other addresses), and one address can't reach the account-wide limit (~5 the first
  hour, ~1 an hour after). 429 `too_many_attempts` + `Retry-After`. A full sign-in clears that address's keys for the
  account; counts start again once a key's window (24 h / 1 h) has passed. `users.js unlock|password|reset-2fa`
  clear the account's keys from every address plus the `ip:` keys of each address that failed on it; `unlock --all`
  clears everything. Relies on `req.ip` being the device's tailnet address (trust proxy, below); if it weren't, every
  device would share one address and these limits would apply to all of them together.
- **Devices** (`auth_devices`): one per browser / home-screen install; its id **is** its sync device id. Default name
  from the User-Agent (+ "Home screen app" when standalone); either person can rename. At sign-in the browser sends the
  id it has: kept if it is this person's and not signed out (an expired session continues as the same device, with
  its outbox), or if neither auth nor sync knows it (e.g. the database was restored from an older backup); otherwise a
  new id is made and `deviceReplaced: true` tells the browser to drop what it holds for the old one.
- **Signing a device out** (Devices page, either person; or Sign out on the device itself): sets
  `auth_devices.signed_out_at/by` and ends its sessions. Its next request — with the old cookie, or with no cookie but
  `X-Suite-Device: <its id>` — gets **401 `device_signed_out`**, and the cookie is cleared. A signed-out device never
  gets a session again; signing in there makes a new device. Device rows are never pruned (so the answer keeps
  coming); ended sessions are pruned after 180 days.
- **401 codes** (all requests): `not_signed_in` (show sign-in), `session_expired` (sign in again, **keep** local data:
  same person, same device), `device_signed_out` (**clear** local data, then sign in). The client's
  `api/client.js` fires `SESSION_LOST_EVENT`; `auth/session.jsx` calls `clearLocalData()` for `device_signed_out` and
  shows the sign-in screen with the reason. The session is re-checked when the app returns to the foreground, comes
  back online, and every 5 minutes. Requests that get no answer in 30 s count as no connection (status 0).
- **Backups** contain the auth tables (scrypt hashes, TOTP secrets, hashed tokens). **A restore ends every session**:
  at start (`start` hook) auth compares the sync generation with `auth_meta.sync_generation`; a different one means
  the database was restored, so all open sessions end (`end_reason = 'restored'`). Every device then gets
  `session_expired` (sign in again, keep local data) — including a lost phone that was signed out after the backup and
  never reconnected, which would otherwise have its old session back. Its device row is not signed out in the restored
  copy, so sign it out again on the Devices page (it can't sign back in without the password and a code). Restores by
  hand (not `npm run restore`) aren't detected (same limit as sync).

## Backups
Design (code in `server/src/backup/`, tests in `server/test/backup.test.js`):
- Snapshot with better-sqlite3's **backup API** (consistent: committed data only, WAL included; safe while running),
  converted to a single self-contained file (`journal_mode=DELETE`), `integrity_check` must pass, then fsync + rename.
- Local copy in `BACKUP_DIR` (`data/backups`), then copied to `BACKUP_OFFSITE_DIR`, SHA-256 verified, renamed into place.
  The off-machine folder must contain a `.suite-backup-target` marker file, so an unmounted drive/share (an empty stand-in
  folder) fails loudly instead of silently "backing up" to the same disk.
- Names `suite-YYYY-MM-DDTHHMMSS.mmmZ.db` (UTC). Retention `BACKUP_KEEP_DAYS` in both folders; the newest is always
  kept; only files matching that pattern are ever deleted.
- `data/backups/status.json` records the last attempt/success/error; `GET /api/health` → `backup.ok` is false when the
  last good backup is older than 26 h or the off-machine copy failed. The System page shows it.
- **Scheduling: inside the server process** (`schedule.js`), daily at `BACKUP_TIME` in the container's `TZ`, plus a
  catch-up run 2 min after start if the last success is over 25 h old. A failed run is retried hourly until one succeeds.
  While `backup.ok` is false (and the schedule is on), `shell/BackupBanner.jsx` shows a red banner on every page. Chosen over launchd because it needs no host
  setup, no Node on the Mac and no `docker exec` from a plist; it ships with the image and moves with it (e.g. to Fly.io).
  Trade-off: no backups while the app is down — but then nothing changes either; the catch-up covers restarts.
- **Restore** (`restore.js`) refuses while the server's heartbeat file (`<db>.server-lock`, refreshed every 15 s, removed
  on clean shutdown) is fresh, verifies the file, (D5) runs this version's migrations on the restored copy — so a backup
  from before a kept table or column existed still receives the current rows (`keepOnRestore`; best effort, the next
  start runs a migration that failed) — carries the kept tables, saves the current database as
  `backups/pre-restore-*.db`, removes `-wal/-shm`, swaps the file in. The heartbeat works across containers sharing the volume (a port check would not).

## Offline sync (C2a: server half)
Devices (iPhone, Mac) keep working with no connection: they make records with their own IDs and save every change as
a small **step** in an outbox, push the steps when connected, and pull what changed since their bookmark. Code:
`server/src/modules/sync/`, tests `server/test/sync.test.js` (with the test-only module in `server/test/fixtures/syncdemo`).

**Tables** (all `sync_*`): `sync_steps` (the log: one row per step key, ever), `sync_records` (per record: created,
deleted, flagged, `changed_seq` for pulls), `sync_field_versions` (per field: stamp, seq, device, actor, step — for
last-writer-wins), `sync_clashes` (the review list: both values, both actors/devices/times, resolved yes/no),
`sync_devices` (device → actor, bookmark `last_pull_cursor`, newest stamp, clock skew), `sync_meta` (generation, seq,
server clock, server device id).

**A step** (made on the device, JSON):
`{ key, entity, recordId, op: 'create'|'update'|'delete', fields?, hlc, seen? }`
- `key`: `newId()` made when the change is made — the idempotency key. Resent steps answer `duplicate`.
- `recordId`: the record's UUIDv7, made on the device for a create.
- `fields`: only synced fields; a create may omit optional ones (null); an update sends just what changed; a delete none.
- `hlc`: a stamp from `createHlc(deviceId)` (`@suite/shared/hlc`) — `clock.now()` per change.
- `seen`: the device's cursor from its last **complete** pull (the page with `hasMore: false`) when the change was made.
  It is how the server tells "edited after seeing the other change" (no clash) from "edited at the same time" (clash).
  From a generation a restore replaced = "saw up to min(its seq, the restored copy's last seq)". Missing or from an
  unknown generation = "saw nothing" (safest: more clashes to review, nothing silently lost).

**Endpoints** (`/api/sync`; signed in — the actor and device come from the session, see `identity.js`; a request that
names a different device (`X-Suite-Device` / `deviceId`) is refused 409, a different actor 403; a signed-out device
gets 401 `device_signed_out`):
- `POST /push {steps:[…], deviceTime?}` → `{ generation, seq, hlc, serverTime, clockWarning?, results:[…] }`, one result
  per step in order: `applied` | `duplicate` | `clash` (applied in part or kept for review; `applied`/`lost`/`stale`
  field lists, `clashes` ids, `kept`) | `rejected` (`code` + `reason`; nothing written — show it in "needs attention", never
  drop it). Each step is its own transaction. Max 500 steps/push, 64 KB/step, 1 MB/body (413 beyond).
- `GET /pull?since=<cursor>&limit=<1–1000, default 200>` → `{ generation, reset, cursor, hasMore, hlc, changes }`;
  a change is `{ entity, id, seq, deleted:false, flagged, fields, meta?, clashes:[open clashes] }` or `{ entity, id, seq,
  deleted:true }`. `meta` = `{ createdAt, createdBy, updatedAt, updatedBy }` (the table's standard columns that exist;
  not synced fields — "who logged it"). Keep calling with the returned cursor until `hasMore` is false. Cursors are opaque (`<generation>.<seq>`).
- `GET /clashes?status=open|all&entity=&recordId=&limit=<1–1000>` (each at most once, else 400), `POST /clashes/:id/resolve {resolution: keep_winner|keep_loser}`
  (keep_loser applies the other value, or the delete, as a new change; 409 if the detail changed again since).
- `GET /info` → generation, current cursor, server clock, registered entities with their fields (for client-side checks).

**Rules**
- **Exactly once, in order**: steps apply in the order sent; the key makes repeats `duplicate`. Every applied step
  gets the next server `seq`. Per field, an *older* stamp from the same device never overwrites that device's newer
  value (it comes back in `stale`, not a clash; compared by the device's original stamps, not clamped ones), so late or re-sent steps can't undo newer work. Rejected steps are
  not recorded and can be retried unchanged later (e.g. `not_found` until the create arrives after a restore).
- **Clock: hybrid logical clock (HLC)**, compared as text (`<ms>-<counter>-<deviceId>`). Chosen over plain device
  timestamps (a wrong clock would decide clashes; ties possible) and over server arrival order (a phone offline for days
  would overwrite newer edits just by arriving last). An HLC is the device's wall clock, but it never goes backwards and
  always moves past every stamp the device has pulled (`clock.receive(response.hlc)` after each push/pull), so a change
  made after seeing another sorts after it even on a slow clock. Stamps more than 5 min ahead of the server are
  clamped to server time on arrival (a clock set to next year can't win everything); `deviceTime` on push lets the
  server warn about a skewed clock. Known limit: a device with a clock far *behind* loses concurrent clashes — the
  losing value is kept for review, so nothing is lost.
- **Different fields** of one record from two devices: both apply. **Same field**, concurrent (other device, and the
  version is newer than the step's `seen`): the later stamp wins, the other value goes to `sync_clashes`, either arrival
  order gives the same result. Not concurrent (same device, or already seen): it just applies. Same value: no clash.
- **Delete vs edit** (concurrent): the record is kept (un-deleted if the delete arrived first), `flagged`, and a
  `delete` clash records the delete as the loser. "Concurrent" for a delete = any create/update **step** in the log by
  another device after the deleter's `seen` — including edits that lost a field clash. Settle it by keeping the record
  or deleting after all. A delete of something you had fully seen just deletes; it settles as `superseded` every open
  `delete` clash on the record (moot once it is deleted) and the field clashes whose steps the deleting device had
  seen. An edit of something you knew was deleted is rejected (`deleted`).
- **Deletes are soft**: the row stays with `deleted_at` set; pulls send a tombstone.
- **Belonging** (`parent` refs; code "belonging" in `sync/service.js`): a record's parents, their parents… are its
  ancestors; every live record under it is its subtree. **Deletes never cascade**: reads treat a record as gone when
  it or any ancestor is deleted. The delete-vs-edit rule follows the chain, in either arrival order: a create/update
  under an ancestor that another device deleted after this one's `seen` keeps that ancestor (un-deleted, flagged, a
  `delete` clash; the step itself is `applied` and its result lists `revived: [{entity, id}]`); a delete of a record
  whose subtree has a create/update by another device after the deleter's `seen` is kept and flagged. Such a clash's
  `winner.value` is `{ _child: { entity, id } }` (what kept it). An ancestor the device knew was deleted → the step is
  refused `deleted`. Non-parent refs only have to exist (they may name a deleted record: read it as none).
  Devices hide such records the same way (engine `list`/`get`, see C2b "Hidden under a deleted parent").
- **Restore generation**: `restore.js` marks the restored file; on the next start sync gives the database a new
  `generation` and remembers the replaced one with its last seq (`sync_meta.previous_generations`). A pull with a cursor
  from another generation (or ahead of the server) gets `reset: true` and starts from the beginning (the device may
  hold records the restored copy never had); a step's `seen` from a replaced generation counts up to the restored point.

**How a module syncs a record type** (C3a):
1. Its migration makes the table: `id TEXT PRIMARY KEY`, `deleted_at TEXT`, the synced columns, and optionally
   `created_at`, `created_by`, `updated_at`, `updated_by`, `flagged INTEGER NOT NULL DEFAULT 0` — sync fills those
   (times from the step's stamp, i.e. when it was done on the device; actor = who). Use nullable columns or `required`
   fields; foreign-key failures come back as `rejected` / `constraint`.
2. In `createService(ctx)`: `ctx.services.sync.registerEntity({ module, entity, table, fields, ops | appendOnly })`.
   Field types: `text` (`max`, default 10 000), `integer`, `number`, `boolean` (stored 0/1, sent true/false), `date`
   (YYYY-MM-DD), `datetime` (nowIso format), `id` (UUIDv7), `enum` (`values`); `required: true`. `appendOnly: true` =
   create only (notes, activities, call logs: they simply add up); `ops: ['create', 'delete']` = no edits (links).
   The table must start with the module's name; entity names are global, short and singular (`client`, `task`, `note`).
   Options (all in `/info`, so devices know them):
   - `format` (text): `email` | `phone` | `postal` | `tags` (`@suite/shared/normalize`). The value is stored in one
     clean form: devices (the engine) and `applyLocal` normalise before the step; the server refuses anything not
     already normalised (`invalid_value`).
   - `ref: '<entity>'` (id): a soft reference — no SQL foreign key. A step naming a record that isn't there is
     refused `not_found`, which devices park and retry after each pull (it may still be on its way: made on the other
     device, re-sent after a restore). With SQL FKs it would be `constraint` → Needs attention instead.
   - `parent: true` (with `ref`): what the record **belongs to**. See "Belonging" below.
   A `not_found` rejection says what is missing: `missing: { field, entity, id }` (`field` null = the record itself).
   `readOnly: true` (D1): written by server code only — `/info` says so (devices get no ops: the store refuses with
   `op_not_allowed`, `/sync/data` offers no add/edit/delete) and the server refuses every device step.
   Also on registerEntity: `check({ op, recordId, fields, current, actor, server })` — the module's own rule (since D1
   it runs for deletes too, with `fields` null; every earlier hook lets deletes by)
   (`actor`: who made the step, from the session or `system`; `server`: true for `applyLocal`, false for a device's
   push — C8's alerts use both; hooks that ignore them are unaffected), run inside the step's
   transaction after the field and reference checks (reads only); return `{ code, reason }` to refuse the step
   (devices show it in Needs attention). The CRM uses it for "one live link per outside record". It also gets
   `actor` (who made the step: from the session, or `system`) and `server` (true for `applyLocal`, false for a
   device's push) — C8's alerts use them (made by the server only; a device marks only its own read flag). Two limits: it sees
   the **step's** fields (for an update: only what that step changes, plus `current`, the row before it) — not what
   the update ends up writing (a field that loses a clash isn't written), so a rule over the final row must be
   written for that; and its answer depends on **arrival order** — the same step can be refused where it first
   applied, e.g. re-sent after a restore when the other device's conflicting change got in first: it then lands in
   Needs attention (fix or discard), which is safe but needs a person. Use it for rules where refusing is right in
   any order, never for something that must always apply.
   **Column types must match field types** or registration fails: `text`/`date`/`datetime`/`id`/`enum` → `TEXT`,
   `integer`/`boolean` → `INTEGER`, `number` → `REAL` (`id`, `deleted_at`, `created_*`/`updated_*` TEXT, `flagged`
   INTEGER). A boolean in a TEXT column would come back as '1.0'; "0123" in an INTEGER column as 123.
3. The module comes **after `sync`** in `modules/index.js`.
4. **All writes go through sync**: devices push steps; server code calls `ctx.services.sync.applyLocal({ actor, entity,
   op, recordId?, fields, stampMs? })` (imports, automations — same rules and log, server's own device id; `stampMs` =
   stamp it at a fixed past time, for seeds: any real edit is later and wins a clash). TEMP triggers make
   any other write to a registered table fail on the app's connection. Reads are the module's own SQL — always filter
   `deleted_at IS NULL`; `sync.recordState(entity, id)` gives flag + open clashes for a record page.
5. Plan new fields as nullable or with defaults; renaming/removing a synced field breaks old outbox steps (`unknown_field`).
6. **Migrations never change rows of a synced table.** Schema changes (add a column) are fine; data changes
   (backfills, clean-ups, imports) run *after* start-up through `applyLocal` — migrations run before the guard exists,
   so SQL there would bypass the log, field versions and clash rules, and devices would never receive the change.
7. A newly added field reaches devices only on records changed afterwards (pulls are by record change). To push a
   backfilled value out, write it with `applyLocal`; to show a new field everywhere at once, devices must re-pull from
   scratch (Offline data → "Download everything again", `engine.refetchAll()`).

**Browser side**: built in C2b — see "Offline sync (C2b: browser side)" below for how each of these rules is met.
**Plan pruning**: `sync_steps`, `sync_field_versions`, tombstones in `sync_records`/module tables, resolved clashes and
`sync_devices` rows all grow forever. Before it matters, add pruning (e.g. steps and tombstones older than the
device-retention window, devices unseen for 90 days, forcing those devices to reset).
**After a restore** every session has ended (see "Sign-in"): devices get `session_expired`, keep their outbox and kept
steps, sign in again (keeping their device id), then see the new generation and re-push (kept steps first), then pull
from scratch.

**Not done in C2a / open**: clash resolution needs a connection (no offline "resolve" step yet); pulls send every
synced record (no "active clients only" scope yet — the device has a hook for it, `pullScope` in
`client/src/sync/engine.js`; still open after C3a, see "CRM"); nothing is pruned on the server
yet (see "Plan pruning"); after a restore, an edit re-sent before its record is re-created and then retried may show
as a clash against the re-created record's values (safe: kept for review); restores done by copying a file by hand (not `npm run restore`) are not
detected — always restore with the script.

## Offline sync (C2b: browser side)
Code `client/src/sync/`, pages `client/src/modules/sync/`, service worker `client/src/sw/`; tests `client/test/`
(the engine in Node with fake-indexeddb against a real server with the test-only `syncdemo` module) and `test/e2e/`.
The engine is entity-agnostic: what can be saved comes from `GET /api/sync/info`, so a module that registers an entity
on the server (C3a: "How a module syncs a record type") needs nothing on the client to make it work offline.

**The API for C3a/C4a** — client code reads and writes synced records **only** through this (never its own API calls):
```js
import { store, useRecords, useRecord, useSyncStatus, SyncError } from '../../sync/index.js';
import { ClashPanel, SyncBadges } from '../../sync/components.jsx';
const id = await store.create('task', { title: 'Call Lefty’s', done: false }); // new UUIDv7, made here; works offline
await store.update('task', id, { done: true });     // sends only fields that changed; false when nothing did
await store.remove('task', id);
await store.list('task', { where: { done: false } /* or (rec) => bool */, sort: 'due' /* '-due', or (a, b) => n */ });
await store.get('task', id);                         // null when this device doesn't have it
await store.listMany(['client', 'account']);         // { client: [...], account: [...] }: each type and its parents read once
await store.liveCounts(['client', 'contact']);       // { client: n, … } as people see them
const { records, loading } = useRecords('task', { where, sort }, deps);   // live; `deps` = state where/sort depend on
const { record } = useRecord('client', clientId);
```
**Hidden under a deleted parent**: `list`, `get`, `liveCounts` and the hooks leave out records whose `parent` chain
isn't on the device (deleted — deletes don't cascade — or a create that was refused): a contact of a deleted client,
a service of a relationship of a deleted account. `{ orphans: true }` (list/get, `useRecords`) includes them (what the
device holds; `counts()` is raw too). Such a record can't be updated or removed (`not_found`). `engine.ancestorsOf(entity)`
names the types it belongs to; the hooks re-read on changes to those too. Every CRM list (C3b) gets this for free;
custom `useSyncData` reads should pass `entities: () => [entity, ...engine.ancestorsOf(entity)]`.
A record is `{ id, ...fields, _sync: { entity, pending, local, flagged, clashes, createdBy, createdAt, updatedBy, updatedAt } }`
(`pending`: a change is waiting to be sent; `local`: made here, not in the pulled copy yet — so by this device's person;
the who/when come from the pull's `meta`: null for local records, and for records pulled before C3b until they change
or are downloaded again — **after deploying C3b, use Offline data → "Download everything again" once on each device**;
there is no automatic refetch). Record pages show `<SyncBadges record={r} />` and
`<ClashPanel record={r} definition={engine.definition(entity)} />` (both cheap per row: ClashPanel subscribes to
nothing unless the record has clashes). Every write is checked first against the entity's definition with
`@suite/shared/fields` (the server's own rules); everything the store throws is a `SyncError` with a `code`:
Fields with a `format` are normalised first (`' Bob@X.com'` → `'bob@x.com'`, `'+1 (519) 555-0100'` → `'5195550100'`, spaces
only → null), so a value typed another way is no change. Errors:
`not_ready` (this device never connected), `unknown_entity`, `unknown_field`, `invalid_value`, `invalid_step` (fields
not an object, an id that isn't a UUIDv7, a fix that changes nothing), `op_not_allowed`, `not_found`,
`already_exists`, `too_large` (step over 64 KB), `stopped` (signed out / closed), and IndexedDB failures wrapped as
`storage_full` (the browser's quota — on an iPhone, the phone is out of space) or `storage_error` (`cause` holds the
browser's error). A write stores **only the step**, in the outbox (one transaction with the clock); the pulled copy
(`records`) is never written by local changes — reads replay the outbox over it, so the change shows at once, and the
engine sends it when it can.

**Long lists (C3a/C4a)**: don't render thousands of rows — page them (the plain records view shows 50 at a time with
"Show more") or virtualise, and subscribe per list, not per row. Data events name the record types that changed
(`{ type: 'data', entities: ['task'] }`, `null` = anything), and `useRecords`/`useRecord` re-read only for their own
type (`useSyncData(load, deps, { entities })` for custom reads). Measured with 5,000 records on the plain view (e2e
`scale` test, desktop Chromium): ~700 elements, ~130 ms from a tick to the bar counting it.

**Storage** (IndexedDB database `suite-offline`; it belongs to `meta.deviceId`, and one left by another device id is
deleted before use): `records` (pulled copy, key `[entity, id]`), `staging` (a pull from scratch in progress), `outbox`
(key `[lane, n]`: lane 0 = kept steps re-sent after a restore, lane 1 = normal; `parked` = waiting for its record),
`sent` (accepted steps with server seq/generation/applied fields, kept 30 days), `attention` (refused steps), `meta`
(deviceId, hlc, generation, `pull` bookmark, `seen` = cursor of the last complete pull, pulls, nextN, info, lastSyncAt).
localStorage: `suite.deviceId`, `suite.session` (the remembered session), `suite.signOutPending` (a sign-out not yet
sent), `suite.theme`.

**How the rules are met**
- **Stamping**: a write is one readwrite transaction over `meta` + `outbox`: HLC from `meta.hlc` (`createHlc(id, { last })`),
  `now()`, save `peek()`, `seen` = `meta.seen`, put the step. Readwrite transactions over the same stores run one at a
  time across tabs, so stamps stay unique without a lock. `clock.receive()` runs after `/info`, every push and every
  pull page, in the transaction that records it.
- **One cycle at a time per device** (Web Lock `suite-sync`; an in-page queue where Web Locks are missing):
  `GET /info` (definitions; a new generation = reset) → push the outbox in key order (≤ 500 steps / ~900 KB per push;
  a 413 halves the batch) → pull pages until `hasMore` is false → push the parked steps once more → drop sent steps
  older than 30 days. Tabs tell each other about changes over a BroadcastChannel (`suite-sync`).
- **Results**: `applied`/`duplicate`/`clash` → out of the outbox into `sent`; `stale` fields are just done; rejected
  `not_found` → parked in the outbox and retried after every pull (and after a reset) — `parked: { code, reason,
  missing, at, triedAt }`, `at` = when it started waiting (kept across retries), `missing` = what it waits for (shown as
  "Waiting for its client “Lefty’s”"); any other rejection →
  `attention`: **Try again** re-sends the same step (same key — the server never recorded it), **Fix…** makes a new
  step (new key and stamp) with corrected fields, **Discard** drops it (a refused create also drops later changes to
  that record, and every waiting change that points to it moves to Needs attention as `parent_discarded` — it could
  never be sent; fix it to point elsewhere or discard it, which cascades the same way; discarding a waiting create
  does the same). The Fix form starts from the latest values (the refused step with the record's later waiting edits on
  top); fixing a refused create **folds those later edits into the new create** and takes them out of the outbox in
  the same transaction — left alone they would be older than the fix and the server would drop them as stale.
  Parked steps are listed there too ("Waiting for their record") and can be discarded.
- **What is shown**: the pulled copy, then (in HLC order) accepted steps that the last complete pull hasn't covered yet
  (their `applied` fields only, so a change that lost a clash isn't shown as if it won; a kept delete isn't applied),
  then the outbox (`pending`). A refused change disappears from view and appears in Needs attention.
- **Pulls**: from the bookmark; without one (first sign-in, after a reset, "Download everything again" on /sync) the
  pages go to `staging` and replace `records` in one transaction when the last page is in, so the old copy stays
  readable offline until the new one is complete. A pull that brings nothing redraws nothing.
- **Reset** (new generation on `/info`, a push or a pull, or `reset: true` for a cursor we sent): kept sent steps from
  other generations move to outbox lane 0 in their original order, ahead of the outbox; the bookmark is cleared; then
  push, then pull from scratch. Steps whose record isn't back yet are parked (P3) and apply once it is.
- **When it syncs**: app open, back to the foreground (and `pageshow` from the page cache), the `online` event, 1.5 s after
  each local change, every 60 s while visible. `navigator.onLine === false` → no request is tried (phase `offline`).
  Network errors and timeouts (status 0) → `offline`, 5xx/other → `error`; both retry the same steps with backoff
  (2 s doubling to 5 min, ±20 %). 401 session codes and 409 `device_mismatch` stop the engine (no retries).
- **Signed out / session ended** (`api/client.js` sends `X-Suite-Device` on every request, so a device whose cookie is
  gone still hears it): `device_signed_out` → `clearLocalData()` (`auth/device.js`): deletes the IndexedDB
  database (records, outbox with unsent changes, kept steps, attention, HLC, cursors — other tabs close it on
  `versionchange`), `suite.deviceId` and `suite.session`, and every Cache Storage cache **except** `suite-shell-*`
  (the public app shell, including a version waiting to take over: deleting it would leave the app unable to open
  offline). Also on Sign out (which warns about unsent changes first) and when sign-in returns a different device id.
  `session_expired` → everything is kept; signing in again (same device id) resumes.
- **Other tabs** (same device): when the database is deleted from another tab their engine stops (`stoppedBy:
  'closed'`), the hooks drop what they show at once, and SyncProvider re-checks the session (as does a `storage`
  event on `suite.deviceId`): they land on the sign-in screen, or on the new person's session.
- **Signing out offline**: the server can't be told and the HttpOnly cookie stays, so `suite.signOutPending` remembers
  the device id; the next check sends `POST /api/auth/logout` before anything else (until it gets through, nobody is
  signed in here — the old session never quietly resumes), and a sign-in meanwhile signs that device out from the new
  session. If that session ended in the meantime (401 `session_expired`/`not_signed_in`), only a session can sign the
  device out, so it stays pending for the next sign-in; the screen says "Signed out", not "your session ended". The Account page offers Sign out without a connection too.
- **Switching person**: the sign-in screen warns when the last person's unsent changes would be deleted (another
  username typed while the remembered session's outbox isn't empty).
- **Clashes** come with the pulled record (`_sync.clashes`); ClashPanel settles them with
  `POST /api/sync/clashes/:id/resolve` (online only), then syncs.
- **Opening offline**: AuthProvider remembers the last confirmed session (`suite.session`, only while the device id
  matches) and opens the app from it at once; `GET /api/auth/session` confirms it or ends it once the server answers.

**Service worker** (`client/src/sw/service-worker.js`; the `suite-service-worker` plugin in `client/vite.config.js`
writes `dist/sw.js` with the list of every built file and a version hashed from them and the worker): cache
`suite-shell-<version>`; navigations get the cached `index.html` (every route is the same shell), built files come from
the cache, `/api` is never intercepted. A file missing from the cache (the browser evicted it, someone cleared it) is
fetched and put back on the next request, and a version refills anything missing when it activates. The first install takes over at once (`clients.claim`). A new version installs
in the background and **waits** (no `skipWaiting`): the open app keeps its own files (offline too) and UpdateBanner
offers **Reload** → `SKIP_WAITING` → `controllerchange` → reload; the old cache is deleted when the new version
activates. The app looks for a new version on coming to the foreground (≥ 10 min apart) and hourly. Registered in
production builds only (none under `npm run dev:client`). Service workers need a secure context: the ts.net HTTPS
address from Tailscale Serve (or localhost) — a plain `http://100.x…:3100` address gets no offline app.

**iPhone limits**: a home-screen web app **can't sync in the background** (iOS has no Background Sync for web apps), so
changes made offline go out the next time the app is open and online (it syncs on open, on coming to the foreground
and on `online`). Web Locks and BroadcastChannel need iOS 15.4+. The app asks for persistent storage
(`navigator.storage.persist()`); home-screen apps aren't subject to Safari's 7-day storage limit, but iOS can still
clear website data under storage pressure — a change is only safe once it has been sent.

**UI**: the sync bar at the top of every page — "Offline · N changes waiting", "Syncing…" (only when there is something
to send or nothing was downloaded yet, so the routine check doesn't flicker), "N changes waiting · can't sync right now ·
Retry", "N changes waiting for records not here yet", "All changes saved" (not before the first sync), "N need
attention ›" → `/sync/attention`, and "This device's clock is off ›" when the server says so (stamps are clamped; the
date and time settings need fixing).
`/sync` (Offline data, linked from the bar and System): status, records per entity, Sync now, Download everything again.
`/sync/data/:entity`: a plain view of any synced entity (list, add, edit, tick, delete, clashes) — the CRM's pages
replace it for daily use; it stays as the view of what a device holds and backs the e2e test. Its id pickers list the
records of the field's `ref` entity; `format` fields get the email / phone keyboard.

**Scope (TODO, still open after C3a)**: pulls send every record. The device-side hook is `pullScope` in `engine.js`
(extra pull parameters, `null` today). When the server can filter ("active clients only", open tasks, Today and this
month's plans), return its parameters there; records that leave the scope need a "left scope" change from the server
(or a pull from scratch), or they linger on devices. C3a left it out on purpose: two people's CRM is hundreds to a few
thousand records (the e2e test shows 5,000 is fine), and a scope must also follow the belonging chain (a closed
client's contacts, consents…). Do it when the numbers call for it (activities will grow first).

**Verified**: `client/test/engine.test.js` (offline create+edit then push, reopen, two devices merging, a clash
surfaced and settled, delete vs edit kept and flagged, pending/accepted overlay, paging and pull from scratch, two tabs
never pushing at once, retries with backoff applying once, refused → needs attention (fix / retry / discard), fixing a
refused create keeps its later edits, restore → kept steps first then outbox, parked edits applying later,
`device_signed_out` → clearLocalData deletes everything but the app shell, `session_expired` keeps everything, another
device id's database dropped, quota errors as `storage_full`, events naming entities, clock warnings) and `test/e2e/`
(Chromium; "offline" is a real outage — a proxy in front of the server is cut, since `setOffline` doesn't stop the
service worker's own requests — plus `setOffline` for airplane mode): iPhone 13 emulation signs in, airplane mode,
reload served by the service worker, tick an item and add a note, reload still offline, back online → saved, seen on a
second "Mac" context, no CSP violations; the update flow; sign-out with an update waiting, the other person signs in
and reloads into it, then it opens in an outage (and an emptied shell cache refills); a sign-out in one tab sends the
other to sign-in at once and reaches the server later; the switching-person warning; the clock warning in the bar;
5,000 records (`scale.e2e.test.js`).
**Owner's step after C3a/C4a**: on an iPhone in airplane mode, open the suite from the Home Screen, add a note and tick
a task, turn airplane mode off with the app open, and check both on the Mac.

**Not done / open**: settling a clash needs a connection; no background sync on iPhone (above); the pull scope
(above); device-side pruning is only the 30-day kept steps (nothing else grows on the device except the copy itself);
a record type's own pages (C3a/C4a) should use `useRecords`/`ClashPanel` rather than the generic view.

## CRM (crm module, C3a)
Code `server/src/modules/crm/` (record types in `entities.js`), shared facts `shared/crm.js` + `shared/normalize.js`,
client `client/src/modules/crm/`; tests `server/test/crm.test.js`, `client/test/crm.test.js`, `test/e2e/crm.e2e.test.js`. The plan's model: a
**client** (the owner or group) has **accounts** (their businesses) and **contacts**; a **relationship** is one of our
**businesses** working with one of their accounts; **services** hang off a relationship; **activities** are the timeline;
**consent** is per contact and our business; **links** tie another app's record to an account or contact (D2).

**Record types** (entity → table `crm_<plural>`; every one synced, UUIDv7 id, `created_*`/`updated_*` who and when,
`flagged`; ⇧ = `parent` ref, → = plain ref, * = required; text lengths in `entities.js`):
- `business` (create/update only — never deleted: relationships, consent and code via `BUSINESS_IDS` depend on it;
  `archived` hides one from pickers and lists): name*, color ("#rrggbb"), logo (URL/path; a file id once files exist),
  default_owner* (`owner|partner|shared`), position, archived (boolean).
- `client`: name*, status* (`active|closed`), tags (format tags), notes.
- `account`: client_id*⇧, name*, street, city, region, postal_code (format postal), country, website, tags, notes,
  age_restricted (boolean).
- `contact`: client_id*⇧, account_id→ (optional: which of their businesses), name*, role, email (format email),
  phone (format phone), preferred_channel (`email|call|text|social|in_person`), notes.
- `consent` (append-only): contact_id*⇧, business_id*⇧, withdrawn* (boolean), date* (given / withdrawn), kind
  (`express|implied_purchase|implied_inquiry`, CASL; none = implied, lapses like an inquiry), expires_on (date it
  lapses), source (how it was given).
- `relationship`: account_id*⇧, business_id*⇧, kind* (`wholesale|website|social|consulting`), status* (`active|paused|ended`),
  start_date, notes.
- `service`: relationship_id*⇧, name*, status* (`active|paused|done|cancelled`), stage (free text until Projects),
  billing (`flat|hourly`), amount_cents (flat fee or retainer per period), rate_cents (hourly), period
  (`once|monthly|quarterly|yearly`), sessions, start_date, renewal_date, scope, notes. Money is integer cents.
- `activity` (append-only): client_id*⇧, account_id→, business_id→ (ours), type* (`note|call|email|meeting|order|milestone`),
  body*, at* (datetime it happened; `created_by` = who logged it). A correction is a new activity.
- `link` (create/delete only; undo = delete): account_id⇧ **or** contact_id⇧ (exactly one: SQL CHECK → `constraint`),
  app* (`wom`; add values as apps join), external_id*, matched_by* (`auto|approved`). **One live link per (app,
  external_id) and kind of target**, checked in code (the `check` hook; refused `already_linked`), counting only links
  whose account/contact **and its client** are live — not a UNIQUE index: deletes don't cascade, so a link under a
  deleted account stays in the table (an orphan), and an index would refuse re-linking that Order Manager customer
  forever, invisibly. An Order Manager customer can be an account and its contact person (one link of each kind).
  **For D2**: read links with `crm.liveLinks(app, externalId)` (live ones only); if a deleted record comes back through
  a clash, its old link is live again — more than one live link of a kind means "review", never pick one silently.
Value lists live in `@suite/shared/crm` (use them for labels/pickers). New fields: nullable, never renamed (rule 5).

**Rules for C3b, C4a and the D packages**
- **Writes**: devices `store.create/update/remove` (C2b engine), server code `sync.applyLocal`. No write routes
  except C7's CSV import (`POST /api/crm/import/commit`, which writes through applyLocal — see "Client intake");
  synced `crm_*` tables refuse any other write (guard triggers, tested per table).
- **Our businesses** are seeded at first start through `applyLocal` (actor `system`) with **fixed ids**
  (`OUR_BUSINESSES` / `BUSINESS_IDS` in `@suite/shared/crm`: wholesale, agency = Great White North Design, consulting,
  save_point, retail, personal), only when that id has never existed — no duplicates on restart or restore, and a
  rename/archive in the app sticks. They are stamped at an old fixed time (`SEED_STAMP_MS`, 2026-01-01): after a
  restore from before C3a they come back with the same ids, and edits re-sent from devices (a rename) are later than
  the re-made seed, so they win (a field clash is kept for review with the seed value as the loser). Default owners: owner for wholesale/agency/consulting, partner for Save Point Shop, shared for
  the retail stores **and Personal** (proposal: household renewals and bills land on the shared list; a task made by
  hand should default to its maker — C4a).
- **"Shared"** is `SHARED = 'shared'` in `@suite/shared/actors` (`OWNERS = ['owner', 'partner', 'shared']`): a list
  either person picks from, never an actor (never signs in, never in `created_by`). C4a's task owner uses `OWNERS`.
- **Clean contact details**: `normalize.js` is the one definition (email trimmed + lowercase; phone digits only, North
  American numbers as 10 digits — "+1 519…" = "519…", an extension is dropped → put it in notes; postal "N3Y 4K3";
  tags "a, b" without repeats). Matching (D2) compares stored values with `=`. The Order Manager's phase-2 groundwork
  should copy `normalizePhone`/`normalizeEmail` exactly. `formatPhone` shows a stored phone as "(519) 555-0100"
  (the generic views' `formatValue` uses it).
  **Stored formats (settled — changing them later needs a backfill and strands outbox steps)**: email = NFC, invisible
  characters (zero-width, BOM, soft hyphen) removed, trimmed, lowercase. Phone = exactly one of two shapes:
  North American `[2-9]XX[2-9]XXXXXX` (10 digits, no +1; typed with or without +1/1) or `+<country code><number>`
  (7–15 digits, country code not 1; typed with +, 00 or 011). Nothing is guessed: a 7-digit local number is refused
  (it exists in every area code — D2 would link strangers), and so is a foreign number without its country code
  ("138 0013 8000"), so "(431) 234-5678" and "+43 1 2345678" stay different. After a country code a "(0)" trunk
  prefix is dropped ("+44 (0)20 …" = "+44 20 …"). D2 matches phones with `=` on this form.
- **Consent** is append-only; withdrawing adds a row with `withdrawn: true`. **Only what was given after the last
  withdrawal counts** (a give dated the same day as a withdrawal doesn't: the unsubscribe wins). Of those rows: any
  `express` one → given, never lapses (a later implied row doesn't end it); otherwise given until the
  **latest-lapsing** implied one lapses (a later inquiry doesn't cut a purchase's 2 years short). CASL implied consent
  **lapses**: `implied_purchase` 2 years after `date`, `implied_inquiry` — and a row with **no kind** — 6 months after
  (`consentExpiresOn({ kind, date })`; writers store it in `expires_on`, editable for other implied grounds; readers
  fall back to it when a row has none; it counts on the days before `expires_on`). `consentStatus(rows, businessId,
  today)` → `{ given, withdrawn, expired, expiresOn, row }` (row = the one that decides) and `hasConsent()` in
  `@suite/shared/crm` — used by the read API (server's local date); use the same on devices with the device's local
  date. `latestConsents()` is only "the most recent row" (for display). No consent row = no consent.
- **Age-restricted**: `account.age_restricted` (not contact): purchases are made by a business (the Order Manager
  customer links to an account; order activities carry account_id), and one flag per buyer doesn't drift as people
  change roles. Set by hand now, by the wholesale connection later (D). Rule for any marketing list (D packages): an
  age-restricted account, its contacts and its activities/orders may be used only by our businesses that have a
  relationship with that account — never to select, segment or target for another brand — and every email still
  needs that business's own consent.
- **References** are soft `ref`s checked by sync (not SQL FKs; see "Belonging" under Offline sync): SQL FKs would
  answer `constraint` when a child arrives before its parent (two devices, or kept steps re-sent after a restore in
  another order), which devices send to Needs attention; `not_found` is parked and retried after each pull, so
  offline order sorts itself out. FKs would also need SQLite's 12-step rebuild for any later parent-table change.
  Same-client consistency (contact.account_id's client = contact.client_id) is not enforced: screens and D2 merges
  move them together.
- **Deleting**: delete only the record itself (e.g. a client) — never its children; they are hidden with it and come
  back if the delete is undone through a clash. Prefer `status: closed` / `ended` for normal use; delete is for mistakes.
  Reads show a record only while its whole parent chain is live — server SQL joins up the chain; devices get it from
  the engine (`list`/`get`/`liveCounts`, "Hidden under a deleted parent"; `/crm` counts and `/sync/data` lists use
  it, with "N hidden · Show them" there) — and treat a non-parent ref to a deleted record (contact.account_id,
  activity.account_id/business_id) as none. Orphans stay in the tables (links included — see `link`).
- **Read API** (`/api/crm`, signed in, GET only): `/businesses`; `/clients?q=&business=&status=&limit=&offset=` (q:
  part of a client/account/contact name or an email, or a phone typed any way; business: clients with a live
  relationship with it; `{ clients: [{ …client, accountCount, contactCount, businessIds, lastActivityAt }], total }`;
  each filter is one `c.id IN (…)` set and only the page's rows get counts — keep it that way: a per-client subquery
  took 5–7 s at 5,000 clients, now ~10 ms; `crm.test.js` times it);
  `/clients/:id` → `{ client, accounts: [{ …, relationships: [{ …, services }], links }], contacts: [{ …, consent:
  { [businessId]: { given, withdrawn, expired, expiresOn, date, kind, source, id, recordedAt, recordedBy } }, links }], activities (latest 20),
  activityCount }`; the client, accounts, relationships, services, contacts and links carry `_sync: { flagged, clashes }`
  (from `sync.recordState`; append-only activities and consent can't clash);
  `/clients/:id/activities?business=&account=&type=&limit=&offset=` (newest first). Screens can read the device's offline copy
  (`useRecords`) instead; the API is for search across everything, records a device may not hold once the pull scope
  exists, and server-side consumers.
- **Not in C3a/C3b**: tasks (C4a), lead stages (D8), the matching itself (D2: the link record exists; C3b only shows
  links), the pull scope (see Offline sync C2b, "Scope"). **Open**: the server's search (`?q=`) doesn't find a
  partial phone typed with a leading +1 ("1-519-555"); the devices' search does (`parseQuery` also tries it without
  the 1) — make `listClients` do the same if the API search is used by a screen.

## CRM screens (C3b)
Code `client/src/modules/crm/`; tests `client/test/clients.test.js` (logic) and `test/e2e/clients.e2e.test.js` (the plan's
one-owner, three-business example entered and filtered on iPhone and desktop, phone search, a note made in an outage).
- **Offline only**: pages read through `data.js` and write with `store.create/update/remove` — never `/api/crm`.
  `data.js` keeps each CRM type's list per engine (`cachedLists`: types not cached are read together with
  `engine.listMany`) until a data event names that type or one it belongs to; lookups by field (`entry.where('client_id',
  id)`) and derived maps (last activity per client) are built once per such change. So saving a note re-reads only
  activities, and the list reads the client page's types in the background, so opening a client is quick. Pages build
  their own structures with `useMemo` (`buildClientIndex`, the client page's maps); filtering is per keystroke; lists
  show 50 at a time. Measured (`test/e2e/clients-scale.e2e.test.js`, 3,000 clients ≈ 33,000 records, iPhone emulation
  here): list cold ~0.9 s, search ~50 ms, client page ~0.8 s right after the list opens (~70 ms once its background read
  is done), saving a note until it shows ~0.3 s, back to the list ~0.2 s, client page after a reload ~1.5 s; the first
  download of 33,000 records takes ~37 s (engine, pull pages of 500).
- **`/crm` client list**: search (`parseQuery`/`matchesQuery`: every word must appear in the client's, an account's or a
  contact's name or an email — accents and apostrophes folded; a query of phone characters with 3+ digits is also
  normalised with `normalizePhone` and matched as part of a stored phone, the server's rule), business filter (any live
  relationship with it, any status — as `GET /api/crm/clients?business=`), status (Active default / Closed / All).
  Filters live in the URL (`?q=&business=&status=`) so Back restores them. Rows: name, account names, business chips
  (short names, `businessColor`), last activity day. Links to Our businesses and Offline data. A partial phone typed
  with the +1 ("1-519-555", "+1 519") is also tried without the 1.
- **`/crm/clients/:id`** (keyed by id: filters reset per client): header (status, tags, notes, Edit, Close/Reopen),
  Accounts → relationships (business chip, kind, status, since) → services (status, stage, `billingSummary`, renewal),
  Contacts (mailto/tel, `formatPhone`, prefers, consent per business: rows for the businesses with a relationship on
  this client plus any with a consent row, via `consentView` = `consentStatus` with the device's `localDate()`), links
  read-only under their account/contact, and the Timeline (newest first; filters our business / their account / type,
  each "All" or one value — an activity without that value shows only under All; 50 at a time). Wide screens
  (≥ 1100 px): records left, timeline right; phones: one column plus a fixed **capture bar** (Add note / Log call)
  above the tab bar. Quick capture pre-selects the timeline's current business/account filter; `at` defaults to now
  (datetime-local, local time) for back-dating; types note/call/email/meeting/milestone (`order` is for automations).
- **Edits send only what the person changed** since the sheet opened (`formFields.js`: `valuesFrom` snapshot,
  `editChanges` diff), never the whole form: a change by the other person that arrives while the sheet is open (a new
  phone, a client closed) must survive — sending every field would put the old values back as a normal later edit,
  with no clash. Tested with two devices in `client/test/clients-forms.test.js`. A sheet with unsaved input asks
  before Escape / a tap outside / ✕ discards it (Cancel discards). Quick capture's "When" left untouched means the
  moment of saving (`activityAt`). Timeline filters whose account/business is gone go back to All.
- **Forms** (`forms.jsx`, in a `Sheet`): business pickers hide archived businesses (`pickableBusinesses` keeps the
  record's own); relationship kind is pre-filled from the business (wholesale/consulting/agency → website); services
  take dollars (`parseDollars`) and store cents; consent is a new row each time (given: kind + date, `expires_on`
  pre-filled from `consentExpiresOn` and editable; withdrawn: date); store errors show inline via `errorText` (SyncError
  codes in plain English). **Delete** sits in each edit sheet behind a confirm that says children are hidden, not
  deleted; normal use is Close / Ended / Done. Activities and consent are append-only (no edit: a correction is a new one).
- **Sync state**: `RecordSync` (flagged banner + `ClashPanel`) and `SyncBadges` on client, accounts, relationships,
  services, contacts; activities show "Waiting to sync" and who logged them ("by you" / "by your partner").
- **Our businesses** (`/crm/businesses`): owner label from each person's side, a colour picker (`business.color`;
  seeded businesses have none, so `businessColor` falls back to a fixed colour per seeded id) and Archived.
- For **C4a** (done, see "Planner"): reuse `Sheet`, `FormSheet`, `useAction`/`errorText`, `BusinessChip`, `pickableBusinesses`, `actorLabel`
  and `ui/format.js`. The client page has room for a Tasks card in the left column (or above the timeline); the timeline
  filter state is the natural default for a new task's business/account, as quick capture does.

## Client intake (C7: Quick add and the CSV import)
Shared logic `shared/intake.js` + `shared/csv.js` (tests `shared/test/intake.test.js`); Quick add
`client/src/modules/crm/QuickAddPage.jsx` + `quickAdd.js` (tests `client/test/quickadd.test.js`); the import
`server/src/modules/crm/import.js` + `routes.js` + `ImportPage.jsx` (tests `server/test/import.test.js`); both in
`test/e2e/intake.e2e.test.js` (iPhone and Mac). Linked from the client list (Quick add button; links under the list).

**One row shape for both** (`intake.js`): `{ client: { name, tags, notes }, account: { name, street, city, region,
postal_code, country, website }, relationships: [{ business_id, kind, notes }], contact: { name, role, email, phone,
notes } }`. `cleanRow` gives stored forms (`normalize.js`) + `warnings` + `problems` (no client name = can't save).
The account is named like the client unless given; the contact's name defaults to the client's when only an email or
phone is given. **What can't be stored goes into notes, with a warning** — never guessed, never dropped: a phone the
normaliser refuses (7 digits, foreign without a country code) → the contact's notes "Phone as typed: …"; an extension
→ "Ext. 22"; a bad email → "Email as typed: …"; a bad postal code → the account's notes. Values are clipped to field lengths.
- **Matching** (the plan's rule, applied to new rows — nothing is linked or merged; that is D2):
  same clean email or phone as a live contact of a live client → `same` "Already here: <client>"; a similar client or
  **account** name → `similar` "Maybe the same as <client>" (`nameKey`: accents/apostrophes/punctuation/legal words
  like Inc, Ltd, Co, The dropped; `similarNames`: same key, the shorter's words side by side inside the longer, or the
  same letters without spaces; under 4 letters never); the same email/phone/name key as an **earlier row** of the batch
  → `duplicate`. Exact name ≠ "already here" (two "Mike"s). `buildMatchIndex` indexes names by word, so 10,000 rows
  against thousands of clients stays fast.
- **Choices** (`actionsFor`, first = default): new → create | skip; same/similar (and changed) → **skip** | add |
  create anyway; duplicate/imported → skip | create. A choice is stored with the state it was made for and counts only
  while the row is still in that state (anything that changed since the preview falls back to skip).
- **`planRow`** (create or "add only what's missing"): create = client (active) → account → a relationship per
  (business, kind) (status active; extra words like "retainer" in its notes) → contact. Add = on the existing client:
  the account with the same or a similar name, else its first account when the row named none of its own, else a new
  account; relationships the client doesn't have (on an existing account: none of its accounts has that business and
  kind); the contact unless one with the same email or phone (or, with neither, name) exists. **Nothing existing is
  ever updated**: imports and quick add only create (server test: no `update` step after an import).
- **Our businesses**: defaults are agency (GWND · Website) for both; Social, Consulting and Wholesale selectable per
  row / per import, or None. Wholesale customers proper come through the Order Manager connection (A10/D1).

**Quick add** (`/crm/quick-add`, offline): one client per line; separators ` - `, `—`, `–`, `;`, `|`, tab, and `,`
**only on a line with none of those** ("Smith, Jones & Associates - consulting" keeps its name; a keyword list like
"website, social retainer" still splits); a `:` after the client's name too ("Brantford Auto Body: website"); hyphens
inside words don't split; bullets/numbering dropped. Keywords (whole segments of keywords + fillers):
website/web/site/design/seo/agency → GWND website; social/social media/instagram/facebook → GWND social;
consulting/consult/coaching → consulting; wholesale → wholesale. Emails and phones anywhere (the words beside them are
the contact); phones only when they read as one (+/00/011/bracketed area code, 10 digits, 11 starting with 1, or a
7-digit "555-0100" kept as typed with a warning — never "15000 2026", never across a ` - `); `Client (Account)`,
`account:`, `contact:`/`owner:`/`manager:` (role), `role:`, "Name, owner" (a role word), `#tag`, `tags:` (to the next
separator other than a comma), `notes:` (rest of the line; separators before it are trimmed). Other leftovers: a
person's name (capitalised words, particles like "de"/"van", "&": "Pat", "Jan de Vries", "Amy & Tom Baker") → the
contact if there is none yet; **everything else → the client's notes** ("2 sessions", "net 30", a town) — only
`#word` and `tags:` make tags, and nothing typed is dropped (`cleanRow` also keeps contact notes on the client when
there is no contact). The preview shows role, client notes and contact notes per row. Lines without a keyword get the
page's default (marked "No business named"). The preview updates as you type: cards with an Edit sheet on phones,
an editable table on wide screens (≥ 1000 px; "More…" opens the sheet for notes/role). Matching uses the device's
copy (`useClientListData`). **Save** creates through `store.create` with ids **made once per line** (`session`, module
state keyed by line text + copy number): a double tap is ignored (ref guard) and a retry after a partial failure
re-uses the ids (`already_exists` = done), and a row's own records never flag it. Saving stops at the first failure
and says which line. Text, edits and choices survive navigating away (module state, this app session); "Start a new
list" forgets them, after which the same list again shows "Already here".

**CSV import** (`/crm/import`, **needs a connection**: says so offline and disables Preview/Import). The page reads the
file (UTF-8, else Windows-1252; `readTable` skips report title rows — up to 10 leading records with fewer than two
filled cells, when a real header follows — and a trailing date/time footer, as in QuickBooks Online reports; row
numbers stay those of the file), shows the detected mapping (`detectMapping`: QuickBooks Online/Desktop, Wave, Xero,
FreshBooks headers; `source` guessed) with a sample per column, and the business for the new clients. Then:
- `POST /api/crm/import/preview { text, fileName, mapping, business, kind }` → every row flagged
  (`invalid | imported | changed | same | similar | duplicate | new`), with `actions`, `match`, `previous` (the earlier
  import) and `adds` (what "add only what's missing" would make). Writes nothing.
- `POST /api/crm/import/commit { batchId, …, choices: { [row]: { action, status } } }` → **202** `{ batch }`, running in
  the background; the page polls `GET /import/batches/:id` and then calls `store.syncNow()`. The same `batchId` again
  with the same request → 200 with that batch (a retried request never imports twice); with a different request
  (`request_hash`: SHA-256 of the text, file name, mapping, business and choices, migration 003) → **409
  `batch_mismatch`**, so a lost reply can never be answered with another file's result. The page makes a new batch id
  whenever the file, mapping, business, choices or preview change. One import at a time (409 `import_running`).
  `GET /import/batches` lists the last 20 (who, when, file, source, counts, problems) on the page.
- Limits: text ≤ 5 MB (413 `too_big`; route body limit 8 MB), ≤ 10,000 data rows (413 `too_many_rows`), a name column
  (400 `no_name_column`), `business` one of ours with a `kind`.
- **Writes**: `sync.applyLocal` as the person (`actor`, also `created_by`), each record a sync step (devices pull them),
  plus one timeline **note** per row that made anything ("Imported from “file.csv” (accounting customer list).", or
  "Added from … : contact X, GWND (website). Nothing existing was changed."), with the import's business. Rows go in
  **chunks of 100** (one transaction per chunk, each row in its own savepoint: all its records + note + remembered row,
  or none — a refused step fails only that row), yielding to the event loop between chunks (2,500 rows ≈ 1.5 s here,
  health answered meanwhile). **Preview and the start of a commit are synchronous**: parsing, cleaning, matching and
  the fingerprint lookups for a 10,000-row file block the server briefly (on the order of a second or two), as does
  each 100-row chunk; fine for two people, but don't call them from anything that runs often.
- Several addresses in one email cell ("a@x.ca; b@x.ca", also in quick add): the first valid one is the email, the
  rest go in the contact's notes ("Also: …").
- **CSV exports (any future one)**: escape values starting with `=`, `+`, `-` or `@` (prefix a `'`, or a tab) so a
  spreadsheet doesn't run them as formulas — imported names and notes are typed by anyone. Nothing exports CSV yet.
- **Idempotent**: `crm_import_rows` remembers every committed row by **fingerprint** (SHA-256 of `fingerprintText`:
  every clean value except relationships — the business picked is a choice, not data) → client id, record ids, batch,
  row number. Same values again → `imported` (skipped; even for another business, typed differently or with `;`);
  same customer (`rowKey` = client name key) with other values → `changed` "Changed since last import — not applied";
  "add" there — and on an `imported` row — adds only what's missing to the client it made (e.g. the relationship for
  another business chosen this time). A row whose client was later deleted stays "imported"
  (shown "since deleted"; "Create anyway" is there). A restart mid-import marks the batch `interrupted`
  (`markInterrupted` at start); importing the same file again finishes it.
- These tables are not synced and not guarded (the module's own); backups carry them with the records.

**For D2 (matching and links)**: reuse `nameKey`/`similarNames`/`buildMatchIndex` for "similar business name"
suggestions and the normalised email/phone equality for auto-links; C7 only flags at entry time and links nothing.
`crm_import_rows` tells which clients came from the accounting list (client ids) if D2 wants a source per client.
Not built: address matching ("same street and postal code"), a review list, "not the same" memory, undo of links.

## Planner (planner module, C4a)
Code `server/src/modules/planner/` (record types in `entities.js`), shared facts `shared/planner.js`, client
`client/src/modules/planner/`; tests `server/test/planner.test.js`, `client/test/planner.test.js` (logic),
`client/test/planner-forms.test.js` (two devices), `test/e2e/planner.e2e.test.js` (iPhone and Mac).
Registered after `sync` and `crm` (its refs name CRM entities; the service refuses to start without crm). It reads
only its own tables and has **no HTTP routes**: devices use their offline copy, server code `sync.applyLocal`.

**Record types** (synced, UUIDv7 ids, `created_*`/`updated_*`, `flagged`; ⇧ parent, → plain ref, * required):
- `task` (`planner_tasks`; create/update/delete — delete is for mistakes, finishing sets `done_at`): title* (≤ 300),
  notes, owner* (`OWNERS`: owner | partner | shared), business_id*⇧ (one of ours, Personal included; businesses are
  never deleted), client_id→, account_id→, relationship_id→ (plain refs, **not** parents: deleting a client must not
  hide the person's tasks — they stay, shown with "Deleted client"), due_date (date), due_time (text "HH:MM", local,
  only with a date), estimate_minutes (integer), done_at (datetime; null = open), top_on_owner / top_on_partner
  (date: "one of that day's three most important" **for that person**, set by the morning plan; `TOP_FIELDS` /
  `topField(actor)` in `@suite/shared/planner`; a pick from another day is simply stale).
- `inbox_item` (`planner_inbox_items`; create/update/delete): text* (≤ 5000), source (`typed|phone|siri|share`;
  Siri and share arrive in C5), captured_at* (datetime), cleared_at (datetime; null = still in the inbox),
  became_entity (text: `task` | `activity`; null when dismissed — free text so D8 can add `lead`), became_id (id, no
  ref: what it became may be deleted later).

**Rules**
- **checkTask** (the sync `check`): "HH:MM" times; a create with a time and no date, or an update that sets a time and
  clears the date in the same step, is refused; estimates 1 minute – a week. Only the step's own values are looked at
  (right in any arrival order); a time left behind when the other device clears the date concurrently is possible,
  so **readers ignore a time without a date** (`dueTimeOf`), and the screens always clear both together.
- **"Today"** is the device's local date (`localDate()`, kept current by `useToday`: foreground + every minute).
  Dates are compared as text; date arithmetic is `addDays` on the calendar; weeks run Monday–Sunday (`weekBounds`).
- **Today** (`buildToday`): the signed-in person's own tasks and the shared list (marked "Shared"), never the other
  person's own. Overdue first (oldest first), then due today (timed ones in time order, then the rest with top picks
  first), then "Also in today's top 3" (picks with no date or due later). Each task shows once; a pick is starred
  where it is. Each section shows 50 at a time.
- **Top picks are per person**: a task holds each person's pick day in their own field, so a star on a shared task
  never fills the other person's three; counts, stars, Today and the plan's load show only your own picks, and
  moving a task clears only your own pick. Changes are worked out from the latest record (`store.get`), so a
  move right after a star clears it. Ticking sets `done_at`; the row stays (ticked, with undo) for the rest of the app session
  (`keepFinished`, in memory). Today's calendar (Apple Calendar) is a later package: **nothing is shown for it yet**.
- **Morning plan** (`PlanSheet`, "Plan my day"): proposes overdue + due today on my Today (mine and the shared list's)
  + **my** undated open tasks that belong to **this week's goals or this month's priorities** (C4b; before C4b it
  proposed every undated task of mine). Undated tasks with no goal are counted ("N with no day or goal to sort" →
  the Monday plan's To sort step) instead of being offered as today's. Star up to three
  (`TOP_LIMIT`; `top_on = today`), Move → Today (undated rows) / Tomorrow / another day (`due_date` changes, the time
  stays, a top pick stops being one unless moved to today; Undo puts both back). The load and overbooking warning are
  C4b's `DayLoadPanel` against the person's day length, changed here ("Your day: 8 h · Change"). Each tap is saved at
  once (one or two fields).
- **No next step** (`relationshipsWithoutNextStep`, shared): an **active** relationship whose account and client are
  live, with no **open** task naming it (`relationship_id`) that has a **due date** (overdue still counts: it shows as
  overdue instead). **Wholesale relationships are never flagged** (`NO_NEXT_STEP_EXEMPT_KINDS`, D1): every account
  linked to an Order Manager customer gets one, and they are followed by their orders and (D3) the wholesale
  check-ins and balance reminders instead; the client page, Today, the review and the C8 automation all use this one rule. Any owner's task counts. Shown on the client page's relationship rows ("No next step · Add" →
  task sheet with the relationship, its account, the client and its business) and on Today (count + list).
  Add note / Log call take an optional **Next step** (title + day) and create the task in the same save (two store
  writes, activity first; a retry after a failure doesn't repeat what was saved), owner = whoever logs it, for the
  relationship the call's account + business point at (`guessRelationship`; pickable). When the guess finds none and
  the client has active relationships, the sheet warns that the step won't clear a "No next step" flag
  (`nextStepWarning`); with no relationship it is filed under the call's business, else the last one used here,
  else **Personal**.
- **Defaults** for a task made by hand: owner = its maker; business = the one in context (client page timeline filter,
  a relationship, the tasks page's business filter), else the last one this person used on this device
  (`prefs.js`, localStorage `suite.planner.lastBusiness`, per actor; best effort), else Personal (`defaultBusinessId`).
  **Automated tasks** (D packages) use the business's `default_owner`: `automatedTaskOwner(business)` in
  `@suite/shared/planner`, or `ctx.services.planner.automatedOwnerFor(businessId)` on the server — then
  `sync.applyLocal({ entity: 'task', op: 'create', fields: { …, owner } })`.
- **The inbox is shared**: both people see and sort every item. Before a task or note is made from an item, its
  latest copy is read (`inboxItemGuard` → `alreadySorted`); one already sorted (by the other person, or on another
  device) is refused with who did it and a link to what it became (`/tasks?open=<id>` opens a task's sheet). Two
  devices sorting the same item offline still make two tasks: the item then has clashes on `cleared_at` /
  `became_id` and shows under **Sorted twice** with every outcome (`inboxOutcomes`) and its ClashPanel — delete
  the extra task, then settle. The capture field is cleared before the save and restored only if saving fails
  (`saveCapture`), so typing the next thought meanwhile is kept.
- **Inbox**: the capture field (`CaptureBar`) is on Today and Inbox, fixed above the tab bar on phones; one tap (Add)
  saves an `inbox_item` offline (source `phone` on a phone, else `typed`). Each item: **Task** (sheet pre-filled: title =
  its first line, the rest in notes; owner me; business per the defaults; no date) → **Save** = two taps; the item is
  cleared (`cleared_at`, `became_entity: 'task'`, `became_id`) right after the task is created. **Note on a client…**
  (pick a client → an `activity` of type note, `at` = when it was captured). **Dismiss** (with Undo). The nav shows
  the open count (`useInboxCount`; nav entries take a `Badge`).
- **Tasks page** (`/tasks`): whose (Mine / Partner's / Shared / All), business, client (those with tasks), due
  (all open / overdue / today / this week / no date / done) in the URL (read from `window.location` when changed, so two
  quick changes don't undo each other), 50 at a time. The sheet has every field; reassigning the owner (the handoff)
  is one field. The sheet shows a task's flag and clashes (`RecordSync`), rows their badges. **Edits send only what changed** (`taskForm.js` with the CRM's `editChanges`) — tested with two
  devices: the partner's reassignment or finish arriving while the Mac's sheet is open survives.
- **Reads**: `usePlannerData` / `useInboxCount` go through `crm/data.js`'s cached lists (`task` belongs to `business`;
  `inbox_item` to nothing), so Today, Tasks, Inbox and the client page share one read; indexes (`byId`, tasks by
  relationship) are built once per change, lists are paged. The client page reads `tasks` (by client) and
  `relationshipTasks` (by relationship) from `useClientPageData`.

**For C4b / C5 / D3**
- **C4b**: done — see "Planning (C4b)" (one `goal` entity for both kinds, `task.goal_id`, `workday`).
- **C5** (Siri, share sheet): create `inbox_item`s with `source: 'siri' | 'share'` — through a device (a Shortcut
  opening a capture URL that calls `store.create`) or, if a server route is added, `sync.applyLocal({ actor, … })`.
- **D3 / automations**: tasks from automations use `automatedOwnerFor` and `applyLocal`; a reminder or notification
  for "No next step" can reuse `relationshipsWithoutNextStep` on server reads (pass live rows only). Calendar feeds
  (tasks with a date/time) read `planner_tasks` with `deleted_at IS NULL AND done_at IS NULL`, ignoring a time without
  a date.
- Open: the pull scope (open tasks only) is still TODO (see C2b "Scope"); done tasks accumulate.

## Planning (planner module, C4b)
Same module as C4a. Logic `client/src/modules/planner/plan.js` + `goalForm.js` (no React), shared facts in
`shared/planner.js`; tests `server/test/planning.test.js`, `client/test/plan.test.js`, `client/test/planning-forms.test.js`
(two devices), `test/e2e/planning.e2e.test.js` (iPhone, Mac, and 3,000 tasks + 300 goals).

**Record types** (migration `002_goals.sql`: new tables + `ALTER TABLE planner_tasks ADD COLUMN goal_id`; no rows changed):
- `goal` (`planner_goals`; create/update/delete): kind* (`week|month`), period* (date: the week's **Monday** / the
  month's **1st**), business_id*⇧ (Personal included), title* (≤ 300), target (number > 0), progress (number ≥ 0, set
  by hand; +1 button), owner (`OWNERS`, optional — screens default it to the maker; null reads as shared), notes,
  done_at (datetime), position (integer, order within a business and period), carried_from (id, **no ref**: the goal
  it was copied from).
- `task.goal_id` → goal: a **plain ref** (deleting a goal never hides its tasks; they become unplanned again).
  Old devices' steps without it still apply (tested on a C4a database).
- `workday` (`planner_workdays`; create/update, never deleted): actor* (`owner|partner`), day_minutes (30–1440, null =
  `DEFAULT_DAY_MINUTES` 8 h). **One per person with a fixed id** (`WORKDAY_IDS`), made by the server at start
  (`seedWorkdays`, through `applyLocal`, stamped at an old fixed time, only if the id never existed) — devices only
  update it (two phones creating "my settings" offline would make two). `checkWorkday` refuses a create whose id
  isn't `WORKDAY_IDS[actor]`, any update of `actor`, and a day length outside 30–1440. Read with
  `dayMinutesFor(workdays, actor)`; Plan my day shows its RecordSync (flag + ClashPanel) beside "Your day".
  **Why synced, not device-local**: the Monday plan on the Mac and Today on the phone must agree on what overbooked
  means, and the Friday review is done together on one screen.

**Rules**
- **checkGoal**: period fits kind (`isGoalPeriod`); an update that changes `kind` or `period` must send **both** (so the
  later step wins the pair — one alone could pair with the other device's change); target > 0, progress ≥ 0. Readers
  still snap a period to its kind (`goalPeriodOf`) in case a clash settled field by field splits the pair. Screens
  don't edit kind/period: a goal is made in its week or month; carrying over makes a copy.
- **Month priorities**: one to three per business per month — more is **warned** (sheet and month page,
  `priorityOverflow`), never refused (two offline creates must both survive).
- **Weeks** run Monday–Sunday in the device's local calendar; all date maths is `addDays`/`weekStart`/`monthStart` on
  "YYYY-MM-DD" (Date.UTC, no time zone or DST), never `new Date('YYYY-MM-DD')`. **"This month" is one rule
  everywhere: `planMonth(day)` = the month that day's week's Thursday is in** (a week belongs to the month with most
  of its days; `weekMonth` is the same). Used by the morning plan (`isCurrentGoal`), the task sheet's choices
  (`goalChoices`), the Monday plan's "This month:" line, the monthly plan's default month and its week goals, and
  stale goals. So on Wed Sep 30 and Thu Oct 1 (the week of Sep 28) "this month" is October.
- **Unplanned** (`isUnplannedTask(task, goalsById, today)`): an open task with no due_date and no **current** goal —
  none, a deleted one, or a goal of an earlier period, **done or not** (`isStaleGoal`: before this week / this
  planning month — a goal ticked done can still leave unfinished tasks). Counted "N to sort" on Today and Tasks
  (mine + shared), the Tasks filter "To sort", and the Monday plan's **To sort** step (`SortList`; a stale goal's task
  says "Was part of (✓ when done) “goal”"): Today / Tomorrow / Monday (one tap), another day (pick or type it, then **Move there**:
  nothing is saved while typing) or a goal (`goalChoices` in a select: two). Capture stays two taps: nothing forces a
  day or goal at creation.
- **A goal never changes a task's business** (it may be a client's next step for another business): filing under a goal
  sets only `goal_id` (`goalChange`, `goalPick`); when the businesses differ the task sheet says "Different business from
  the goal (X) · Use X" (`goalBusinessNote`) and To sort's sorted line offers "Use X" (`businessMismatch`) — one tap,
  never silent. Changing a goal's business leaves its tasks alone. A task made from a goal's card starts with the
  goal's business (a default, not a change).
- **Task sheet** "Part of": this and next week's goals, this and next month's priorities, the week/month of its due
  date, and its current goal (`goalChoices`, `<optgroup>`s via `SelectField` options' `group`). A task made from a
  goal's card (or `/tasks?goal=`) starts with that goal and its business. "Focus on this task" opens Focus.
- **Load** (`taskDay`, `dayLoad`, `loadsByDay`): each open task of mine or the shared list counts on **one** day —
  overdue and today's top picks on today, others on their due date; done tasks and the other person's own never. No
  estimate = 0 minutes, listed as "no estimate". Overbooked = minutes > the person's day length.
- **What to push** (`pushSuggestions`): from the day's estimated tasks, in order **untimed before timed → not my top 3
  before a top pick → no goal or a week goal before a month priority → latest-created first** (UUIDv7 id), taken until
  the day fits; each to `nextDayWithRoom` (first later day whose load + it ≤ day length, counting earlier suggestions;
  a task longer than a day goes to the first empty day; every day of the week has the same length). **Shared tasks
  count on both people's day loads**; one the *other* person starred as a top pick today is never suggested (moving
  it would move their pick). One tap moves it
  (`pushChange` = C4a's `moveChange`, from the latest record); moved rows stay with Undo. Shown on Today (only when
  over), in Plan my day (always), and per day on the Monday plan ("Fix" on an overbooked day).
- **Carry-over** (`carryOverCandidates`/`carryFields`): last week's (month's) goals not done and not already carried
  (no goal in this period with `carried_from` = its id) are offered; the copy keeps business, title, target, progress
  so far, owner (or the carrier), notes, at the end of its business's list. The old goal is never changed; its open,
  **undated** tasks move to the copy (`carryTaskMoves`, goal_id only — dated ones keep their day, done ones stay).
  Carried on two devices at once → two copies with the same `carried_from`: the Monday and monthly plans show
  "carried over twice · Remove the extra" (`carriedTwice`/`CarriedTwice` → `removeExtraCopies` in `carryFix.js`: the
  extra's open tasks move to the first copy, the extra is deleted, that is synced, then each task's open `goal_id`
  clash between the two copies is settled `keep_winner` — the surviving goal — so no "Use this instead" points at the
  deleted copy). Needs a connection (settling clashes does); offline the button waits. Nothing bigger.
- **Monday plan** `/plan/week?week=` (`?sort=1` scrolls to To sort): carry-over, each non-archived business's goals
  (add, edit, tick, +1, up/down `reorderChanges`, tasks under each with "+ Task", "This month:" priorities as context),
  the week strip (`weekLoads`), To sort. Wide screens: goals left, week + To sort right.
- **Monthly plan** `/plan/month?month=YYYY-MM`: carry-over, per business "N of 3 priorities" with progress bars and tasks,
  and that month's week goals grouped by week (tick from here).
- **Friday review** `/plan/review` (this week): overdue (both people), this week's goals (one-tap done), renewals
  (services not done/cancelled with `renewal_date` today…+30, `renewalsDue`), active clients quiet for 60 days
  (`quietClients`: last activity — C3b's `lastActivityByClient`, shared via `lastActivityOf`, **and (D1) the client's
  latest Order Manager order, whichever is later** (`reviewLastActivity`; the server's review numbers read the same
  through `wholesale.lastOrderAtByClient()`) — or, with none, when the client was made, ≥ 60 days ago), hand work over (Yours / Partner's: open tasks due by the end of next week or
  undated; one tap gives/takes, Undo), relationships with no next step (C4a's rule), and two "Not connected yet"
  lines (duplicate matches → D2; this week's order entry → the Order Manager connection). Each step has a "reviewed"
  tick kept per week on this device (`prefs.js`, localStorage, last 8 weeks) — a convenience, not data.
- **Focus** `/focus?task=` (Today's Focus button; "Focus on this task" in the sheet): the queue is Today's order
  (`focusQueue` = buildToday's overdue + due today + picks; a task opened from elsewhere goes first), taken once.
  **Done** finishes and moves to the next still to do (wrapping, `nextInQueue`); **Skip** leaves it out for this
  session and moves on; **Next / Previous** just look. The client's contacts (tel/mailto), accounts and the last 4
  timeline items sit beside the task (below on phones) via `useClientPageData`. At the end: "Go back to the N skipped".
- **Reads**: `usePlannerData` adds `goals`, `goalsById`, `tasksByGoal`, `workdays` (cached lists: `goal` belongs to
  `business`); `useReviewData` adds services and the last-activity map. Measured (e2e, desktop Chromium here, 3,000 tasks + 300
  goals): Today ~0.5 s, Monday plan ~0.3 s, sorting a task ~0.3 s, month ~0.1 s, review ~0.1 s, Focus ~0.3 s. That
  test has **no CRM scale data** (C3b's 3,000-client set is `clients-scale.e2e.test.js`), so the review's renewals and
  quiet-client lists are measured empty there.
- **Nav**: "Plan" (`/plan` → `/plan/week`), with Week / Month / Friday review tabs (`PlanTabs`); seven tabs on phones.

**For C5 / C6 / C8 / D15**
- **C5** (Siri, share sheet): captured items still become tasks with no day or goal → they land in To sort, by design.
- **C6 / calendar**: a task's day is `taskDay`; the overbooked warning has no calendar meetings yet — when Apple Calendar
  events arrive, add their minutes to `dayLoad`/`loadsByDay` (timed events are never "suggested to push").
- **C8 overview** ("goals against targets"): `ctx.services.planner.goals(kind, period)` returns live goals of one period
  (server); devices use `goalsOf` + `goalProgress`. The last-Friday-of-the-month review of priorities can reuse
  `reviewLists` with `goalsOf(goals, 'month', monthStart(today))`.
- **D15 / automations** that create tasks for a goal: set `goal_id` (plain ref) and the goal's business; a goal made by
  an automation should use `goalPeriod(kind, day)` for its period and `position: null`.
- Open: per-weekday day lengths (weekends) and time off are not modelled; done goals and tasks accumulate (pull scope).

## Connections (connections module, C8)
Code `server/src/modules/connections/`, page `client/src/modules/connections/`, tests `server/test/connections.test.js`
(with the test-only `server/test/fixtures/conndemo`) and `test/e2e/automations.e2e.test.js`. The plan's rule: every
connection is visible and switchable; one screen shows each one's last success, queue size and last error, and an off
switch pauses it without breaking the app.
- **Registering** (in the module's `createService`; `connections` comes right after `sync` in `modules/index.js`):
  ```js
  const handle = ctx.services.connections.register({
    id: 'wom', name: 'Wholesale Order Manager', module: 'wom', description: '…',
    describe: ({ now }) => ({ lastSuccessAt, lastErrorAt, lastError, queueSize, queueLabel?, detail? }),
    pause() { … }, resume() { … },        // or pausable: false + alwaysOnReason (why it can't be paused)
  });
  handle.isPaused();                       // also ctx.services.connections.isPaused(id)
  ```
  A real `register` with a placeholder's id takes the placeholder's place and slot. `describe()` errors show as the
  row's last error (the page never breaks).
- **The contract** (conndemo proves it): paused → **no outside work and nothing logged as a failure**; jobs keep
  queueing in the module's own outbox (written in the same transaction as the change) and `describe()` keeps answering,
  so the page shows the queue growing; `resume()` catches up, in order. `pause()` is called at registration when the
  stored switch is off, before any work. A failing pause/resume is logged; the switch stays as asked.
- **Switches** are server settings (`connections_switches`; no row = on), **not synced**: changing one needs the
  server (the page says so offline and disables the switches). Either person may switch; every change is in
  `connections_changes` (actor, device, time) and the log. **They survive restores**: the module lists
  `keepOnRestore: ['connections_switches', 'connections_changes']`, and `restore.js` (`carryKeptTables`) copies those
  tables from the database being replaced into the restored copy — a restore never quietly switches a paused connection
  back on. (Since D5 the restored copy is migrated first, so a backup from before C8 gets the current switches too.
  Restores by hand aren't covered.)
- **Rows today**: the off-machine backup (from `backup/status.json`: last success, last error, "queue" = whole days
  behind once the last good backup is over 26 h old; `pausable: false` — backups are never pausable from the app), the
  Order Manager (`wom`, D1 — real, see "Wholesale") and placeholders "Not connected yet · comes with …": Apple
  Calendar (C6), Stockroom (D16). A connection's card can show extra settings: the client module registers a panel
  (`registerConnectionPanel(id, Component)` in `client/src/modules/connections/panels.js`; D1's address + secret).
- **API** (signed in; writes follow the JSON/Origin rules): `GET /api/connections` → `{ connections: [{ id, name,
  module, description, state: on|paused|always_on|not_connected, pausable, alwaysOnReason, comesWith, lastSuccessAt,
  lastErrorAt, lastError, queueSize, queueLabel, detail, changedAt, changedBy }] }`; `PUT /api/connections/:id
  { paused }` → `{ connection }` (404 unknown, 409 `not_pausable` / `not_connected`, 400 bad body).
- **Page**: System → Connections (`/system/connections`), desktop and phone; re-checks every 30 s while open.

## Automations (automations module, C8)
Framework `server/src/modules/automations/`, the first automations `server/src/modules/planner/automations.js`, page
and alerts `client/src/modules/automations/`; tests `server/test/automations.test.js` (TZ America/Toronto),
`client/test/automations.test.js`, `test/e2e/automations.e2e.test.js`. The plan's four rules: they prepare, you approve
(tasks and in-app alerts only — **never anything sent outside**); each business has a default owner
(`automatedOwnerFor`); each has an on/off switch and shows when it last ran; each arrives with the package whose data
it uses.
- **Registering** (`createService` of a module after `automations` in the list, or its `start`):
  ```js
  ctx.services.automations.register({
    id: 'friday-review', name, description, module: 'planner',
    trigger: { type: 'schedule', every: 'week', day: 'fri', at: '08:00' }   // or every: 'day', at: '07:30'
          // or { type: 'event', event: 'order.placed', key: (data) => data.orderId, label? }
          // or { type: 'event', events: ['order.packed', 'order.shipped'], key, accept: (data) => bool, label? } (D3)
    defaults: { enabled: true, alert: false }, alertLink?: '/plan/review',
    run(ctx, { now, nowMs, today, period, trigger, actor, data, made, create }) {
      if (made(period.key).length) return { summary: 'Already there' };
      create('task', { … }, { key: period.key });       // sync.applyLocal as 'system', remembered under key
      return { summary: 'Made 1 task', alert?: { title, body, link } };
    },
  });
  ```
  `run` is **synchronous** and the whole run is **one transaction** (`.immediate()`) with its bookkeeping: what it
  creates, `automations_made`, the run row and the alert commit together or not at all. A run that throws changes
  nothing and is recorded as an error. Writes go through sync (`create()` or `ctx.services.sync.applyLocal` as
  `system`), so devices pull them like anything else; reads through other modules' services.
- **Triggers** (`schedule.js`): times are the server's local time (the container's `TZ`, America/Toronto), built from
  the calendar day + "HH:MM" with the local Date constructor, so 8:00 stays 8:00 across DST (a time that doesn't exist
  on the spring-forward night runs an hour later that day). Plain English via `triggerText` ("Every Friday at 8:00 a.m.").
- **Idempotency rule**: a scheduled automation runs once per **period** (its day, or its Monday–Sunday week: period key
  `2026-10-08` / ISO week `2026-W41`). The run key `<id>:<period key>` is stored only on a successful run and is
  `UNIQUE` (`automations_runs.run_key`), checked inside the run's IMMEDIATE transaction — restarts, catch-ups and two
  servers on one database never run a period twice. The scheduler only looks at the **current** period: after
  downtime it catches up once (if the period's time has passed and it hasn't run), never once per missed tick, and
  earlier missed periods are not replayed. A weekly automation whose whole previous week went by without a run (the
  server off from Friday to Sunday, or every try failed) gets one **missed** run for that week (status `missed`, holding
  its run key) the first time the scheduler looks afterwards — the page shows it; no late task is made for a week
  that is over; nothing is noted for an automation that had never run before. A failed scheduled run is retried no sooner than 15 min later (`RETRY_MS`).
  `run` also gets `update(entity, id, fields)` (sync, as `system`) for records it made before; an alert is raised
  when a run created **or updated** something. (D5: `automations.madeLike(id, prefix)` for reads outside a run, as
  `made(id, key)`.) D3 added `madeLike(prefix)` (everything made under keys starting with
  it, with `key`: "every task for this customer" when keys are `<customer uid>:<…>`) and `remember(key, entity, id)`
  (file something made earlier under one more key), and `automations.made(id, key)` for reads outside a run.
  Every `run` must also be idempotent by content (`made(key)` = what it made before): **Run now** (`POST …/run`) relies
  on that. A successful Run now after the period's time claims the period (the scheduler won't run it again); one
  before the time doesn't. Event runs use `<id>:<trigger.key(data)>` (a re-delivered event is a no-op).
- **Scheduler**: `startScheduler()` (from `src/index.js` when `AUTOMATIONS_ENABLED`, on by default in production) —
  one look 15 s after start, then every minute; runs are synchronous so looks never overlap. Tests call `tick()` and
  move `ctx.now` (all run times use the module's clock). `emit(event, data)` is the event hook (D1's wholesale module
  emits the Order Manager's events, and (D5) two of its own: `wholesale.attachment` when a customer is linked, unlinked
  or moved, `wholesale.check` at start). An event trigger may list several `events` (D3) and an `accept(data)` filter: an
  event it doesn't accept runs nothing and leaves **no run row** (so a backfill of thousands of events, or events for
  unlinked customers, don't fill the run log); an `accept` that throws is logged and skipped.
- **Switches**: `automations_settings` (no row = the automation's defaults), changes logged in
  `automations_changes` (who, device); kept across restores like the connections' (`keepOnRestore`). Off = the
  scheduler and events skip it; Run now still works.
- **Alerts** (the C5 seam): an automation set to **alert** whose run created something makes one `alert` — a
  **synced record** (`automations_alerts`, ops create/update; fields source, title, body, link, at, `read_by_owner`,
  `read_by_partner`). Both people get every alert; each marks it read on their own boolean field (offline too; two of
  one person's devices agree, so no clash; there is no "unread"). `checkAlert` refuses device updates to anything else.
  Devices can't create alerts and may only set their own person's flag (`checkAlert`, using the hook's `actor` and
  `server`); the server clips title and body to the field limits so a long alert never fails its run.
  The shell shows "Alerts" with the unread count in the sidebar and, on phones, a strip at the top of the page while
  something is unread; `/alerts` lists them. **For C5**: `automations.onAlert(fn)` is called with each alert row after
  it is committed — phone notifications (quiet hours, the morning digest, silent vs alert) hang off it;
  `createAlert({ source, title, body, link })` is there for other modules' alerts.
- **API** (signed in): `GET /api/automations` → `{ automations: [{ id, name, description, module, trigger, when,
  enabled, alert, defaults, changedAt, changedBy, lastRun, nextRunAt, recent }], scheduled, timeZone }`;
  `PUT /api/automations/:id { enabled?, alert? }`; `POST /api/automations/:id/run` → `{ run, automation }` (200 also
  when the run failed: `run.status: 'error'`). Page: System → Automations (`/system/automations`): what it does, when,
  on/off, silent/alert, last run ("Never run" until it has), next run, Run now (then `store.syncNow()`).
- **Friday review list** (`friday-review`; Fri 08:00; **alert** by default): one task "Friday review" on the **shared
  list** (always: it is done together, whatever Personal's default owner becomes), business **Personal** (the review
  spans every business; Personal is the planner's catch-all), due that Friday, 15 minutes, notes with the review's
  numbers read on the server like `reviewLists`: overdue (both people + shared), renewals in 30 days, active clients
  quiet 60 days, relationships with no next step (C4a's rule), this week's goals done, and the path `/plan/review`.
  If this week's task (made by it, not deleted) exists: Run now does nothing; **Friday's scheduled run refreshes
  its notes** with that morning's numbers (a review made by Run now early in the week isn't stale) and still alerts
  when set to alert. A deleted one is made again only by Run now.
- **Relationships with no next step** (`no-next-step`; daily 07:30; **off** and **silent** by default — someone
  switches it on, so a database with thousands of imported clients isn't met all at once): for each relationship C4a's
  rule flags **whose client is active and whose business isn't archived** (closing a client means "no next steps";
  paused/ended relationships and anything under a deleted record are never flagged), a task "Set the next step for
  <account> (<business>)" with `relationship_id`, `account_id`, `client_id`, the business's default owner, due
  **today** — at most **10 a run** (`NEXT_STEP_CAP`), oldest relationships first; the rest are counted on **one summary
  task** on the shared list (Personal, due today: "N more relationships have no next step", pointing at Today's list
  and the review), kept up to date while open and finished by the suite when nothing is left over; the run says
  "N more waiting". Its alert lists 5 titles and "and N more". Never a second one while its earlier task for that
  relationship is open **and still names it** (even moved to no date; re-filed under another relationship it no longer
  counts); done or deleted and still flagged → a new one.
  **Decision**: being dated, the task *is* a dated next step and clears the flag while open. That is intended: the
  flag's job moves to the owner's Today (and turns overdue if ignored) instead of a passive flag; finishing it
  without setting a real next step brings the flag back, and the next run makes a new task.

## Wholesale (wholesale module, D1)
Code `server/src/modules/wholesale/`, client `client/src/modules/wholesale/` (+ the client page in crm), tests
`server/test/wholesale.test.js`, `client/test/wholesale.test.js`, `test/e2e/wholesale.e2e.test.js`, and the cross-app
run `scripts/wom-e2e.mjs`. The sender's spec is the Order Manager's CLAUDE.md "CRM outbox (A10)" (+ A6/A7/A8, A9).
Registered last (after crm, planner, connections, automations); reads/writes only its own tables, uses the CRM through
`ctx.services.crm` (reads; D1 added `liveAccountLinks(app)`, `liveAccount(id)`, `accountRelationships(id)`,
`clientNames(ids)`) and `sync.applyLocal` (writes).

**The receiver** — `POST /api/wom/events` (a `signedRoutes` entry, so the only route outside the guard):
- **From the headers, before any of the body is read** (`precheck`): paused? **503** `paused` (nothing read or applied,
  nothing logged as a failure; the Order Manager keeps the events and resends them in order — its backoff caps at
  5 min) → `x-wom-timestamp` / `x-wom-signature` malformed → 401 → no secret / unreadable one → 401 `not_set_up`. Only
  then the raw body (≤ **2 MB**: a batch of 50 is typically 50–150 KB; 413 beyond, which the Order Manager retries —
  raise `RECEIVER_BODY_LIMIT` if an outsized order ever sticks there) → signature: hex HMAC-SHA256(secret, `${ts}\nPOST\n${req.originalUrl}\n${sha256hex(raw)}`), constant-time,
  then `|now − ts| ≤ 300 s` (401 `bad_signature` / `stale` / `no_signature` / `no_timestamp`) → JSON body
  `{ source?: 'wom', events: [1–50] }` (400 otherwise) → **200 `{ results: [{ key, status, reason? }] }`, one per event
  in order**.
- Per event: `eventProblem` (events.js: exactly the A10 envelope, version 1, a UUIDv7 key, known name, each data's uids
  and cents) → **refused + plain-English reason** (only for events that are themselves wrong: the Order Manager parks
  them); key already in `wholesale_events` → **duplicate**; else **applied**: its holding rows and its key in **one
  transaction** (exactly once). Applied in the order received, never by `time`. Refused keys aren't kept. **An
  unexpected error while applying** (SQLITE_BUSY, a full disk, a bug) is never `refused`: the answer stops at the
  events before it (a prefix, which A10 allows), so the Order Manager sends it and the rest again, in order. Such a
  short answer is **not** a success: the Connections row keeps its last success, shows "Couldn’t apply event … : …"
  as its last error, and "Stuck since …" once the same event has failed twice (cleared when it applies).
- Refused requests (bad signature, stale, malformed) are counted in memory and shown as the Connections row's last
  error ("… (N refused since the last good request)") — never the secret; `wholesale_status` is written and a warning
  logged **at most once a minute** (the route has no session); a good request clears it.
- **`wholesale_events` keys must never be pruned while the Order Manager could still re-send them**: it re-sends an
  event (same key) until it has an answer, with no time limit (an outage, a pause, a lost reply) — so only prune keys of
  events whose subject has a later applied event, or that are older than the longest outage you'd tolerate (e.g. a
  year), and never a key the Order Manager still lists as waiting. Not pruned yet (one small row per event). After the batch: `reconcile({ only: touched })`,
  then `automations.emit(name, { key, name, time, backfill, by, customerUid, orderUid, accountId, clientId, linked, data })`
  for each applied event (D3 hangs automations off these; a duplicate emits nothing).

**D5** added the Order Manager's A11 events (`note.added`, `note.deleted`, `followup.changed`): held, shown and turned
into tasks as described in "Wholesale notes and follow-ups (D5)".

**The secret**: made in the suite (`POST /api/wholesale/connection/secret`, either person; 32 random bytes,
base64url) and answered **once** (`{ secret, connection }`); stored AES-256-GCM-encrypted in `wholesale_connection`
with the key in `config.wholesale.keyFile` (`<data>/wom-secret.key`, 0600, made on first use; `WOM_KEY_FILE`) — never in
the database, so backups hold no usable secret (a hash can't work: checking an HMAC needs the secret). A new secret
replaces the old at once (logged in `wholesale_connection_changes`). Both tables are `keepOnRestore`.

**The holding area** (not synced; `wholesale_held_customers | _orders | _money`): the latest snapshot of every customer,
order, payment, refund, return and credit note, by uid — **every event is an upsert, latest arrival wins**. Deletes
and removals only mark: `order.deleted` → `deleted` (snapshot kept, or taken from the event), `payment.recorded`
removed → `removed` + reason + `moved_to`, cut-down "gone" snapshots never replace a full one, `customer.updated`
deleted → `gone`. **Creation events make a record live again**: `customer.created`, `order.placed`, **`order.restored`**
(no `order.placed` needed ahead of it), payment `recorded`/`edited`, refund/return/credit note issued. An order for an
unknown customer makes a stub from the order's customer summary. Every touched row is `dirty`.

**Restores** (D1 review): the holding area, `wholesale_events` and `wholesale_status` are `keepOnRestore` (with the
secret) — the exception to "switches only", because they mirror the Order Manager: it never re-sends what it delivered,
and its "Forget everything + Send existing" can't repair deletes (it sends only what still exists). At start,
`checkRestore()` sees the sync generation changed (`wholesale_status.sync_generation`), marks every held row dirty, and
the background `reconcileAll()` re-projects: each synced record is **adopted by its uid** (`order_uid` / `uid` /
`customer_uid`, oldest live one; extras deleted; missing ones re-made), statuses and deletions put back as the Order
Manager last said, links re-checked. No resend is needed. (A new Mac with the volume lost restores an older holding
area from the backup: then a resend is needed and deletes made meanwhile can't be known — DEPLOY.md step 6.)

**Attaching** (`reconcile`): a held customer is attached to an account when its uid has **exactly one live `wom`
account link** (`crm.liveAccountLinks`: link, account and client live); several → detached and flagged
`several_links` (listed, never one picked); none → detached. Runs after each request (touched customers), after each
link/unlink here, at start, and every minute (`startReconciler`, src/index.js; the full passes are `reconcileAll()`:
50 customers per transaction, projecting in 200-row transactions, yielding to the event loop in between — one pass
at a time) — so links made by D2 or by a device
are picked up within a minute (D2: call `ctx.services.wholesale.reconcile({ only: [uid], actor })` after linking to
attach at once). **A new attachment** sets the account `age_restricted: true` when it isn't true, and creates an active
`wholesale` relationship (start = first order date) when the account has no relationship with our wholesale business
— each only then, never overwriting (a paused relationship stays paused; an unticked flag isn't re-set later). (The
account form saves `false` by default, so "not already set" means "not true".) The account moving to another client
moves the records (`client_id` kept in step).

**What devices see** (synced, `checkServerOnly`: a device step — create, update **or delete** — is refused
`op_not_allowed`; they belong to the account (`account_id` ⇧), `client_id` a plain ref):
- `wholesale_order` — one per order: number, reference, order_date, `at` (its created_at; history-only = date at noon),
  status `active | cancelled | deleted`, history_only, goods/tax/shipping/total cents, `paid_cents` (payments + store
  credit used on it), `returned_cents` (refunds + credit notes, with tax), item_count, items ("10 × Zyn …"), packing.
- `wholesale_entry` — one per payment / refund / store_credit / credit_applied / return / credit_note: amount, method,
  at, number, order uid/number, status `live | removed` (+ removed_reason, moved_to), detail.
- `wholesale_customer` — one card per linked Order Manager customer: name, number, gone, order_count, first/last
  order date, sales, given back, **spend**, paid, credit.
- **Why records, not activities**: activities are append-only (a cancel or delete must change the shown status, never
  add or remove items); one order record kept up to date + one entry per money event gives the timeline items the plan
  asks for, and replays (upserts by uid) can never duplicate them. **Why cards**: the figures need the whole holding
  area (orders that still count, refunds on them, tax shares), so they are worked out once on the server and the
  device only adds cards up (an account with two Order Manager customers; a client's accounts).
- All three are `readOnly` (devices get no ops) as well as `checkServerOnly`.
- `project()` brings each dirty row's record up to date through `applyLocal` (actor `system`): the record is the
  remembered `record_id` or else the oldest live one with its uid (extras deleted); create, update only what
  differs, or **delete when detached**. A failure is logged and left dirty (tried again next time).

**Spend** (`figures.js`, the Order Manager's own A8 rules — the cross-app run checks it equals its `total_spent`):
orders count while active and not deleted (history-only ones count); sales = Σ (subtotal − discounts), before tax and
shipping; given back = credit notes' own `subtotal_cents` + other refunds with an amount (money or store credit) ×
goods / (goods + tax) of their order, only on orders that count (so no tax is taken off twice; store credit *used* never
counts); spend = sales − given back. paid = live payments. credit = store-credit refunds + credit notes + payments
**moved to store credit** by a delete − store credit used (a restore brings the payment back: the credit goes).
**Returns**: a refund or credit note made by a return (`return_uid`) whose `return.received` carries
`subtotal_cents` (the Order Manager's additive A10 change) counts that subtotal — exact even when shipping went back
too; older returns without it fall back to the proportion (off by the shipping share when shipping was refunded).

**Never removed from the timeline**: cancelled/deleted orders show their status (struck through), removed payments
and refunds show "Removed …" / "Kept as store credit when its order was deleted". Only **unlinking** detaches records
(deleted on devices, kept in the holding area: linking again re-creates them all — reversible).

**People's actions** (`/api/wholesale`, signed in; the Wholesale page): `GET /waiting` and `/linked` (`q`, paged, with
counts), `POST /customers/:uid/link { clientId, accountId? }` (no account = a new account under that client named
after the customer, with its address), `/create-client` (client + account + contact when there is a name/clean email
or phone + the link; values the Order Manager couldn't clean go in the account's notes, never matched on),
`/unlink` (deletes its account links; the account keeps its age mark and relationship). Each is one transaction;
links are `matched_by: 'approved'`, `created_by` the person. The CRM's `check` already refuses a second live link.

**Screens**: the client page's timeline merges activities and the Order Manager's records (type filter "Orders",
business wholesale, by account; rows say "from the Order Manager"); each account shows its customer(s) and figures,
the header the client's total; the client list's "last activity" counts orders. `/wholesale` (no nav tab: linked from
the client list, the client page and the Connections card; needs a connection — the lists are server data; picking a
client uses the device's copy). The `wom` card on System → Connections: the address to enter
(`config.wholesale.connectUrl`: `WOM_CONNECT_URL`, else `http://host.docker.internal:<SUITE_PORT>`), the secret's
state, **Make the secret / New secret…** (shown once, Copy).

**Connection row**: last success = last good request; last error = last refused request with a count; queue = held
orders + money (D5: + live notes) of unlinked, not-gone customers ("N records and K notes from M customers waiting for
a client"); detail = linked
count, refused events, several-links problems. pause()/resume() only log (the receiver reads the
switch on every request).

**For D2**: links are CRM `link` records (app `wom`, external_id = customer_uid). Create/delete them with `applyLocal`,
then `wholesale.reconcile({ only: [uid], actor })`; undo = delete the link (records detach; the holding area keeps
everything). `wholesale.list('waiting')` / `GET /api/wholesale/waiting` give the unlinked customers with clean
email/phone for matching (`=` on the stored forms; `contactProblems` are never matched). Contact links (an Order Manager
customer as a contact) aren't used by D1. Not built: a review list, "not the same", restoring the age flag /
relationship on undo, pruning `wholesale_events` (see the rule above). D2's auto-links in bulk: call
`reconcileAll()` (chunked) rather than `reconcile()`. Other modules read "last order per client" with
`wholesale.lastOrderAtByClient()`.

## Wholesale automations (wholesale module, D3)
Code `server/src/modules/wholesale/automations.js` (registered from the wholesale service when automations and planner
exist), the rules in `figures.js` (pure: `orderRhythm`, `isQuiet`, `owingByOrder`, `overdueOrders`, `daysBetween`,
`RHYTHM`, `OVERDUE_AFTER_DAYS`), the card fields in migration `003_rhythm.sql`, the flag on devices in
`client/src/modules/wholesale/logic.js` + `parts.jsx`; tests `server/test/wholesale-automations.test.js` (TZ Toronto),
`client/test/wholesale.test.js`, `test/e2e/wholesale-automations.e2e.test.js`.
All three only make or change **tasks** (and C8 in-app alerts when set to alert): nothing is ever sent outside the
suite. Every task: business **wholesale**, owner `planner.automatedOwnerFor(wholesale)` (the business's default
owner), `client_id`, `account_id`, and the account's wholesale relationship (an active one first) as
`relationship_id`; due today. Only **linked** (attached) Order Manager customers are looked at. Tasks are never deleted
by the suite: when their reason is gone they are **finished** (`done_at`) with a line in their notes saying why
("… — finished by the suite on Oct 17, 2026."). Reads: the holding area (own tables), `crm.liveAccount`,
`crm.accountRelationships`, `crm.accountContacts` (D3: an account's contacts, then its client's with no account),
`crm.getBusiness`, `planner.taskState` (now with `notes`, `doneAt`, `clientId`, `accountId`).
- **Who finished it decides** (review fix): what the suite finished is remembered (`automations_made` key
  `suite-done:<task id>:<done_at>`). When the reason comes back (a payment removed — a bounced cheque —, the order that
  ended a quiet spell cancelled, a customer linked again) a task **the suite** finished is **reopened** (done_at
  cleared, due today, a "— reopened by the suite on …" line); one **a person** finished or deleted is never reopened
  or made again for that key, and runs count it ("N … already handled by a person"). Titles and notes the suite wrote
  are remembered too (`wrote:<task id>:<field>:<hash>`): the suite only replaces a title (or a ship task's notes) that is
  still its own — a person's rename is never put back. **Unlinked** customers: their open check-ins and reminders are
  finished ("Unlinked from the Order Manager customer"); a customer **deleted** in the Order Manager: "Deleted in the
  Order Manager".
- **The rhythm** (`orderRhythm`, one rule for the check-in and the flag): counting orders (active, not deleted;
  history-only count), one per ordering **day**. A **regular** has ≥ 4 ordering days and a usual gap ≤ 90 days; the
  usual gap = the **median of the last 8 gaps** between ordering days (rounded). Quiet when the days since the last
  order exceed `max(ceil(1.5 × usual), usual + 7)` — i.e. from `quiet_from = last order date + that + 1`.
  (Weekly: quiet from day 15; monthly: day 46.)
- **wholesale-check-in** (every day 07:40; **on**, **silent**): each quiet regular whose client is **active** (closed =
  no next steps) and not deleted in the Order Manager gets "Check in with <account>: no order in N days (usually every
  M)" (+ the customer's name when an account has several linked) with the rhythm and last order in its notes. Key
  `<customer uid>:<last counting order uid>` — **once per quiet spell** (one a person finished or deleted isn't made
  again for that spell). A newer last order means a new spell: a check-in still open for an older key is finished
  ("Ordered again (order #N on …)"); if that order is then cancelled or deleted, the spell is back and the suite
  reopens the check-in it finished. At most **10 new a run** (most past their quiet day first; the rest come on the
  next days). Archived wholesale business: no new ones. No events involved, so backfill events can't trigger it.
- **wholesale-balances** (every day 07:45; **on**, **alert**): **what "owing" means** (`owingByOrder`; review fix:
  exactly the Order Manager's **Balances page**, `routes/customers.js GET /balances` + aging, so a reminder never says
  something is over 30 days when that page says it isn't): balance = Σ totals of counting orders (active, not deleted;
  history-only included) − everything paid (`PAID_ROWS_SQL`): **every** live payment of the customer (on any order,
  cancelled ones included, or on account) + store credit applied (any order) − what was given back (refunds + credit
  notes) on a cancelled, not-deleted order, never more than was paid there (payments + credit applied there). The aging
  pays the counting orders **oldest first** (order date, then placed time) with that whole figure — a payment recorded
  on a newer order still pays the oldest first (A Aug 1 $100 unpaid, B Oct 1 $100 paid on B → $100 current, nothing over
  30, as the Order Manager shows). **Refunds and credit notes on counting orders are not taken off** (a credit note is
  credit held until applied — then it is "store credit applied" — and a refund is money given back); payments moved to
  store credit by a delete are removed payments (credit held, not paid) until a restore records them again; the email
  mentions store credit the customer holds (`credit_cents` of the card). Cancelled and deleted orders never owe.
  `balance_cents` (may be negative: credit) = the Order Manager's `GET /api/payments/customer/:id/balance`;
  `wholesale.owingOf(uid)` gives it. `scripts/wom-e2e.mjs` step 6 checks both the balance and the over-30 figure against
  the real Order Manager. **Overdue** = owing on an order whose `order_date` is **more than 30 days** before today
  (the aging's `days > 30`). Per customer with overdue
  orders: one task "Balance owing over 30 days: <account>, $X (N orders)" whose notes hold a **drafted plain-text
  email** (To: the account's first contact with an email, else the Order Manager's email, else a "no email on file"
  line; subject; each overdue order's number, date, amount owing and total; the total; store credit; signed with the
  wholesale business's name) **above `NOTES_MARK`**; what a person writes below that line is kept. Key
  `<customer uid>:<oldest overdue order uid>`. While a task is open it is **updated** (the draft above the line, and the
  title while it is still the suite's) instead of making a second — only when the money changed (no daily churn, no
  daily alert) — and filed under the current key too (`remember`); a person who deletes the line takes the notes over.
  When nothing over 30 days is owed any more the open task is **finished** ("Nothing owing over 30 days any more"); owed
  again later (a payment removed), the suite **reopens** it ("Owing again: $X over 30 days"). A task a person finished
  or deleted isn't made again while the same order is the oldest overdue one; a different oldest overdue order makes a
  new one. At most **10 new a run** (biggest first). Closed clients still get them (money is owed either way).
- **wholesale-ready-to-ship** (event; **on**, **silent**): listens to `order.packed`, `order.shipped`,
  `order.cancelled`, `order.deleted`, `order.restored` and (review fix) `order.changed` — an edit of a packed order's
  lines or customer, or a reopen of a packed-then-cancelled one, makes it `check_again` in the Order Manager and only
  `order.changed` says so. Run key = the event's key (a re-delivered or replayed event is a no-op; the receiver doesn't
  emit duplicates either). **Decided on the held order as it is now** (`currentOrder`, review fix): a request's events
  are all applied before any is emitted, so a catch-up batch with "packed" then "shipped" (or cancelled) makes nothing.
  `accept`: never for `backfill: true`; for an order **ready to ship** now (active, not deleted, `packing.state ===
  'packed'`) only when its customer is linked; otherwise only when this automation made a task for that order (to
  finish or refresh it) — so edits of never-packed orders leave no run rows. Ready + no open task (`made(orderUid)`) →
  "Ship order #N for <account>" (packed by/when, reference, total, items in notes; no run date, so they change only with
  the order). Ready + open → brought up to date: account, client and relationship follow the order's customer, title
  and notes too while they are still the suite's; a customer no longer linked finishes it. Not ready (shipped,
  cancelled, deleted, unpacked, put back, "Changed in the Order Manager — check again") → the open one is finished with
  the reason. Packed again after an unpack or a check-again, unshipped, or restored packed → a new task. **Unlinked customers get nothing, and linking one later replays nothing** (only new events
  count) — until such an order next changes: an order packed before its customer was linked gets its ship task on its
  next `order.changed` (even a tags edit), since it really is waiting to ship. Run now does nothing (it runs on events).
- **The "Quiet regular" flag**: `wholesale_customer` cards carry `usual_gap_days` and `quiet_from` (nullable; null =
  not a regular or deleted in the Order Manager), computed in `desiredCustomer` by `orderRhythm`. `quiet_from` is a
  **date**, so a device shows the flag from that day on with its own `localDate()` (`isQuietRegular(card, today)`) —
  no daily server refresh is needed; a new or changed order dirties the customer and re-projects the card (a new
  `quiet_from`), so the flag goes away. Shown on the client list row (chip, `useClientListData().quietFrom` →
  `buildClientIndex` → `row.quietFrom`; the list now also reads `wholesale_customer`), the client header and the
  account's wholesale card ("Usually orders every 14 days; none for 32") — **never for a closed client** (review fix:
  as the check-ins skip them). **Existing cards**: at start
  `checkCardVersion()` marks every held customer dirty once when `wholesale_status.card_version` < `CARD_VERSION` (2),
  and the start's `reconcileAll` projects them through `applyLocal`, so devices pull the new fields (sync rule 7). Raise
  `CARD_VERSION` whenever a package adds card fields.
- **For D5 and later**: more wholesale automations go in `automations.js` with the same patterns (`taskBase`,
  `finishTask`, keys prefixed by customer uid + `madeLike`). The rules are pure in `figures.js` — reuse
  `owingByOrder` for statements and `orderRhythm` for reorder predictions. Open: per-customer overrides of the rhythm
  (a customer who pauses for winter), a "snooze" for a check-in, and emailing for real (would need consent per
  business and an explicit person's send — never automatic).

## Wholesale notes and follow-ups (wholesale module, D5)
Code: the receiver and holding area in `server/src/modules/wholesale/` (`events.js` checks, `service.js` hold / project,
`entities.js` `wholesale_note`, migration `004_notes.sql`), the follow-up automation `followUps.js`; client
`client/src/modules/wholesale/logic.js` + `parts.jsx` (+ the client page, the Wholesale page); tests
`server/test/wholesale-notes.test.js` (TZ Toronto; with the real Order Manager's A11 events,
`fixtures/wom-captured-notes.json`), `client/test/wholesale.test.js`, `test/e2e/wholesale-notes.e2e.test.js`, and step 7
of `scripts/wom-e2e.mjs`. The sender's spec: the Order Manager's CLAUDE.md, "CRM notes to the suite (A11)" and the A10
events table. It sends them only while its **"Send CRM notes to the suite"** switch is on (off by default; turn it on
after deploying D5 — before, this receiver refused the three names and the Order Manager parked them as refused).
- **The events** (envelope unchanged; `eventProblem` checks exactly these, a malformed one is refused with a reason):
  `note.added { note: { note_uid, number, customer_uid, type: note|call|email|meeting|follow_up, body, at, written_by } }`
  (envelope time = when queued, or `at` for a backfill), `note.deleted { note: { note_uid, number|null,
  customer_uid|null }, reason?: customer_deleted|gone|gone_after_restore }` (no reason = by hand),
  `followup.changed { customer_uid, follow_up_date: 'YYYY-MM-DD'|null, done }` (a state; `done: true` only with null).
  A type the Order Manager adds later is refused until the suite knows it (it waits there for "Send again").
- **Held notes** (`wholesale_held_notes`, not synced, `keepOnRestore` with the rest of the holding area — same
  reasoning): an upsert by `note_uid`, latest arrival wins (`note.added` for a held note replaces its text). A delete only
  marks it (`deleted`, `deleted_reason`, snapshot kept). **Ordering decision**: events apply in arrival order (the Order
  Manager's queue order), and a deleted note — including a **tombstone**, the delete of a note never seen — comes back
  **only through a backfill `note.added`**: the Order Manager's catch-up sends only notes that exist there now (e.g. a
  backup import brought one back), while a live `note.added` for a deleted note can only be an old event sent again after
  the delete (a refused add "sent again"): it is answered `applied`, its text kept, and the note stays deleted. A note
  for a customer never heard of gets a stub customer row (the Order Manager always sends `customer.created` first; just
  in case). A `note.deleted` after its customer's own delete (the switch was off when the customer was deleted) is fine.
- **Follow-up state** on `wholesale_held_customers`: `follow_up_date`, `follow_up_done` (the last change was "done"),
  `follow_up_at`, `follow_up_episode` (+1 each time a date is set where there was none). A customer deleted there has its
  follow-up cleared (the Order Manager forgets it too, and sends the date again if the customer comes back).
- **On devices**: `wholesale_note` (synced, `readOnly` + `checkServerOnly`, `account_id` ⇧, `client_id` plain, fields
  customer_uid, note_uid, number, type, body, at, written_by), projected like `wholesale_order` (adopted by `note_uid`
  after a restore, extras deleted). It exists only while the customer is attached, the note isn't deleted and the
  **customer isn't deleted there** (the Order Manager deletes a customer's notes with it) — so a deleted note, an unlinked
  or deleted customer takes it off devices, and linking again (or the customer coming back) brings it back. The card
  `wholesale_customer.follow_up_date` (migration 004; `CARD_VERSION` 3) is the held date (null when deleted there).
- **The timeline**: notes merge with activities and orders (`noteItem`): business wholesale, their account, **under
  their own type** (Call, Email, Meeting, Note); a follow-up marked done there (`follow_up`) is labelled "Follow-up done"
  and filtered under **Notes** — no new filter value. Each row says who wrote it there ("by sam") and "from the Order
  Manager". The account's wholesale card shows "Next follow-up in the Order Manager: <date>" (`nextFollowUp`). Notes
  count as **last activity** (the client list, the Friday review's quiet clients; server `lastActivityAtByClient()`).
- **Waiting**: notes of unlinked customers wait in the holding area and appear when the customer is linked; the
  Wholesale page's rows say "N notes waiting" (and the follow-up date), its counts and the Connections row's queue count
  them ("3 records and 2 notes from 2 customers waiting for a client"; `queueSize` includes notes).
- **Follow-up tasks** — automation `wholesale-follow-ups` (event; **on**, **silent**), in `followUps.js`. One open task
  **"Follow up with <account>"** per linked customer with a follow-up date, due that date, on the wholesale business, owner
  `planner.automatedOwnerFor(wholesale)`, with the client, account and the account's wholesale relationship (taskBase,
  as D3). Its notes say it is one way: "Mark it done in the Order Manager too" — finishing it here changes nothing there.
  - **Decided on the held customer as it is now** (`followUpPlan`), whatever the event — so a catch-up batch where a
    date is set then done makes nothing. Listens to `followup.changed`, `customer.created` / `customer.updated` (deleted
    there, or back), `wholesale.attachment` (emitted by reconcile after a link, unlink or move is committed — a person's
    link transaction, the minute reconciler, D2's links) and `wholesale.check` (emitted once at every start after the
    start's reconcile, so a restore or a run that failed is put right; Run now does the same check for every customer).
    `accept` runs it only when the customer's task would change — no run rows for the thousands of other events.
  - **Keys** `<customer uid>:<episode>:<date>` (automations_made). Set → **create**. A new date while one is open → the
    **same task moves** (filed under the new key too) — only while its due date is still the one the suite set (D3's
    `wrote:` bookkeeping); a person's own day is kept and a line "The follow-up date in the Order Manager is now …" is
    added once (`told:<task>:<date>`). Title and notes are refreshed only while still the suite's; client, account and
    relationship follow the link. Null + `done: true` → **finished** "Done in the Order Manager"; null + `done: false` →
    "Cleared in the Order Manager"; unlinked → "Unlinked from the Order Manager customer"; deleted there → "Deleted in
    the Order Manager". Never more than one open task per customer (the newest open one is the one kept up to date).
  - **Who finished it decides** (D3's rule): a task the suite finished is **reopened** for the same follow-up (linked
    again, due date put back); one a person finished or deleted isn't made again for that date — but a **new date** there
    (moved), or a new follow-up after a done one (a new episode, even on the same date), is a new task.
  - **Backfill events count** (unlike D3's): a follow-up date is the current state the owner wants to see, so turning
    the switch on there makes the tasks; replays can't duplicate — the same date finds its task by key, and nothing is
    made while one is open.
  - Closed clients and an archived wholesale business still get them: a person set the date in the Order Manager.
- **Restores**: the held notes and follow-up columns survive (keepOnRestore); `checkRestore` marks held notes dirty with
  everything else, so the notes are re-projected, and the start's `wholesale.check` brings the follow-up tasks (rolled
  back with the database) in line with the held dates. `restore.js` now migrates the restored copy before carrying the
  kept tables, so a backup from before D5 keeps them too.
- Not built: pruning held notes; notes typed in the suite going back (A11 is one way by design); a review list.

## Decisions for later packages
- **C1 (sign-in)**: done — see "Sign-in". Passkeys later through the seam described there. Keep the localhost binding.
- **C2 (offline sync)**: done — server half in C2a, browser half and service worker in C2b (see both "Offline sync"
  sections). `health_meta.instance_id` still names the database and survives restores; the sync `generation` is what
  changes on a restore.
- **C3a (core records)**: done — see "CRM". **C3b (screens)**: done — see "CRM screens".
- **C4a (tasks, inbox, Today)**: done — see "Planner". Tasks belong to a business (Personal included) and only point at
  a client/account/relationship; the shared list is `owner: 'shared'`; hand-made tasks default to their maker,
  automated ones to the business's `default_owner`.
- **C7 (client intake)**: done — see "Client intake". The brain dump is device-side (offline); the CSV import is
  server-side (applyLocal, chunked, fingerprints in `crm_import_rows`). Neither overwrites nor links.
- **C4b (planning)**: done — see "Planning". Goals are one entity with `kind` (week | month) rather than two; a task
  belongs to a day **or** a goal (plain `goal_id`), and "unplanned" is derived, never stored; each person's day length
  is a synced `workday` record with a fixed id. Next: C5 capture by Siri and the share sheet (`inbox_item.source`), C8
  the overview (goals against targets), D2 matching (links), the pull scope when volumes need it.
- **C8 (connections and automations)**: done — see "Connections" and "Automations". Switches are server settings
  (not synced) kept across restores; alerts are synced records. What comes next:
  - **D1** (Order Manager receiver): done — see "Wholesale". Its events (`order.placed`, …) go through
    `automations.emit` (no automations listen yet).
  - **C6** (Apple Calendar) registers `calendar` (CalDAV pull: last success, error; pausing stops the pull and the
    feed's refresh, never deletes anything); **D16** registers `stockroom` (read-only pull) the same way.
  - **D3** (done, see "Wholesale automations"): check-ins, balances, ready to ship in the wholesale module. **Later
    packages** add automations with `register()` in their own module (renewals…): tasks via `automatedOwnerFor`,
    `made(key)` / `madeLike(prefix)` for "once per order/customer/period", event triggers with a `key` (and `accept`).
  - **C5** turns alerts into phone notifications through `onAlert` (and adds quiet hours / the morning digest); until
    then "alert" means the in-app alert.
- **D1 (wholesale receiver)**: done — see "Wholesale". The receiver is a signed route outside the guard (one exact
  path); the Order Manager's data is held server-side by uid and shown as server-written synced records for linked
  customers (order + money entries + a figures card), never as activities; spend is computed on the server with the
  Order Manager's own rules; attaching follows the live CRM links (reconcile), so D2 only has to make or delete links.
  Next: D2 matching and the review list; pruning `wholesale_events`.
- **D3 (wholesale automations)**: done — see "Wholesale automations". Tasks only (a drafted email in a task's notes,
  never sent); one rhythm rule (`orderRhythm`) for the check-in and the "Quiet regular" flag, stored on the card as a
  date (`quiet_from`) so devices decide "today" themselves; "owing" is the Order Manager's own balance (credit notes
  and refunds not taken off) with the Balances page's oldest-first aging; ship tasks are finished, never deleted, and
  decided on the held order as it is now; backfill events and unlinked customers trigger nothing; the suite reopens
  only tasks it finished itself and never overwrites a person's title. D2: linking customers in bulk makes them eligible for check-ins/balances on the next daily run (10 new a
  day each). D5: build on `figures.js` and `automations.js`.
- **D5 (notes from the Order Manager)**: done — see "Wholesale notes and follow-ups". Notes are server-written synced
  records (`wholesale_note`), not activities (deletes must take them off; replays upsert by uid), filtered under the
  matching activity type; a deleted note comes back only through a backfill add (tombstones for unknown deletes); a
  follow-up date is held as a state and becomes one task per customer through an event automation that decides on the
  held state as it is now, with linking/unlinking emitted as `wholesale.attachment` and a check at every start; backfill
  follow-ups make tasks (keyed by customer, episode and date, so replays never duplicate). One way: nothing goes back to
  the Order Manager. The restore now migrates the copy before carrying kept tables.
- The live database sits in a Docker **named volume** (SQLite locking on Docker Desktop bind mounts to macOS is not
  trustworthy); only finished backup files cross to the Mac via the `/offsite` bind mount.
- Ports: suite 3100 (Order Manager uses 3000 in its container). Node 22 is the tested runtime (`engines >=22.12`).

## Testing
`npm test` from the root. Server tests use `node --test`, real temporary SQLite files and an app on an ephemeral port
(`createApp` + `listen(0)`) — no mocks of the database. Client tests (`client/test`) run the sync engine in Node with
fake-indexeddb against such a server (helpers.js: `startServer`, `makeDevice` with an on/off connection switch); the
client build must succeed. The sync engine tests (`server/test/sync.test.js`, `client/test/engine.test.js`) run without
the crm module (nor the planner, which needs it, nor the automations with their synced alerts, nor wholesale, which needs the crm) so seeded records don't
shift their counts; `startServer(t, config, { crm: true })` includes them. A restore of a broken live database still
works with `--force`: carrying the switches is best effort (a warning, then the backup's switches) and the restored
copy must pass `integrity_check`. Tests that depend on local time set
`process.env.TZ = 'America/Toronto'` at the top (automations.test.js, wholesale-automations.test.js, wholesale-notes.test.js). automations.test.js
switches D3's two scheduled wholesale automations off in its setup (they're on by default) so its ticks stay about C8. The e2e `startServer(t, { extraModules })` adds
test-only modules (conndemo). `npm run test:wom -- <wholesale-order-manager checkout>` (D1) runs the real Order
Manager (needs `npm ci` in its `server/`) against a real suite and checks the timeline and spend against its own;
`--capture <file>` writes the events it sent (the fixture `server/test/fixtures/wom-captured-events.json`; D5's
`wom-captured-notes.json` holds its A11 events and their customers' `customer.created`, taken from such a capture; step 7
needs an Order Manager with A11). `npm run test:e2e` runs the built app in Chromium (iPhone emulation) — run it when
touching the engine, the service worker or the sync UI. Write a test with every module and every bug fix.

## Git
Work on a branch per package (`pkg/<id>-<name>`), small commits, PR into `main`. No remote yet.
