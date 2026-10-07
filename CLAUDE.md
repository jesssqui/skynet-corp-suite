# Skynet Corp Suite

Private business and life management suite (Skynet Corp Suite; `suite` is the short name used in code, packages and file names) for two people. Runs in Docker on the Mac mini at
home beside the Wholesale Order Manager, reachable only over Tailscale (Tailscale Serve gives it HTTPS). The CRM is its
core (later packages); this repo currently holds the skeleton from package **C0** (server, client shell, one example
module `health`, tests, Docker, nightly backups), the server half of offline sync from **C2a** (module `sync`),
sign-in from **C1** (module `auth`: two accounts, password + authenticator code, sessions, devices), the browser half
of offline sync from **C2b** (the on-device copy and outbox in IndexedDB, a service worker so the app opens with no
signal, the sync bar and the Needs attention page), the CRM's core records from **C3a** (module `crm`: our businesses,
clients, accounts, contacts, consent, relationships, services, activities, links — all synced) and its screens from
**C3b** (client list and search, the client page with its timeline, quick notes and call logs — all offline).

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
                           businesses' fixed ids, the consent rule); tests in shared/test
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
                           routes.js (read API), migrations/001_create_crm.sql
  backup/                  backup.js, restore.js, schedule.js
  lib/                     log.js, httpError.js, serverLock.js (heartbeat file)
server/scripts/            backup.js, restore.js, users.js (CLIs)
server/test/               node --test; helpers.js: tmpDir/testConfig/startApp/testClock/ensureTestUsers/sessionFor/dumpDb;
                           fixtures/syncdemo = test-only synced module
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
                           TextAreaField, CheckboxField), ui.css (the Sheet's media queries), icons.jsx; import from ui/index.js.
                           ui/format.js: formatDate/formatDateTime/formatDay (local time), toDateTimeInput/fromDateTimeInput
  modules/index.js         client module registration list -> nav + routes
  modules/<name>/          index.jsx ({ id, nav, routes }) + pages
  api/client.js            fetch wrapper (api.get/post/put/del, ApiError); sends X-Suite-Device; 401 session codes
                           fire SESSION_LOST_EVENT
  modules/sync/            /sync (Offline data), /sync/attention (Needs attention), /sync/data/:entity (plain records view)
  modules/crm/             C3b screens: ClientListPage (/crm), ClientPage (/crm/clients/:id), BusinessesPage
                           (/crm/businesses), forms.jsx (add/edit sheets), parts.jsx (chips, RecordSync, FormSheet),
                           data.js (cached offline reads), formFields.js (form values -> changed fields), logic.js (search, timeline filters, money, consent, errors — no
                           React, tested in client/test/clients.test.js), crm.css (layout media queries)
client/public/             manifest.webmanifest, icons (placeholders)
client/test/               node --test: the engine against a real server with syncdemo + fixtures/chk (a UNIQUE column),
                           overlay, the CRM screens' logic (clients.test.js) and forms with two devices
                           (clients-forms.test.js); fake-indexeddb
test/e2e/                  Playwright end-to-end tests (npm run test:e2e); proxy.js cuts the server off for real outages
```

## Modules
One folder per module on each side, same name on both (`server/src/modules/health`, `client/src/modules/health`).
- **Server shape** (`modules/<name>/index.js`): `{ name, migrationsDir, createService(ctx), createRouter(ctx, service),
  createPublicRouter?, start? }`. `start(ctx, service)` runs once every service exists (auth uses it to notice a
  restore). Routes mount at `/api/<name>`. **Every `createRouter` route requires a signed-in session**
  (app.js puts `auth.requireSession` in front; `req.auth = { user: { id, actor, username, displayName }, device: { id,
  name }, session }`). `createPublicRouter` is only for routes that must work signed out (sign-in, the minimal health
  check) — don't add one without a reason. `ctx = { db, config, log, services, now }` (`now()` = ms clock, tests move it);
  `ctx.services.<other>` is how a module uses another one. **A module reads and writes only its own tables** — never
  another module's.
- **Client shape** (`modules/<name>/index.jsx`): `{ id, nav: { label, icon, order, path? }, routes: [{ path, element }] }`.
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
- **Sign-in on everything**: every API route needs a session except `POST /api/auth/login|login/code` and
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
  on clean shutdown) is fresh, verifies the file, saves the current database as `backups/pre-restore-*.db`, removes
  `-wal/-shm`, swaps the file in. The heartbeat works across containers sharing the volume (a port check would not).

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
   Also on registerEntity: `check({ op, recordId, fields, current })` — the module's own rule, run inside the step's
   transaction after the field and reference checks (reads only); return `{ code, reason }` to refuse the step
   (devices show it in Needs attention). The CRM uses it for "one live link per outside record". Two limits: it sees
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
- **Writes**: devices `store.create/update/remove` (C2b engine), server code `sync.applyLocal`. No write routes;
  `crm_*` tables refuse any other write (guard triggers, tested per table).
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
- For **C4a**: reuse `Sheet`, `FormSheet`, `useAction`/`errorText`, `BusinessChip`, `pickableBusinesses`, `actorLabel`
  and `ui/format.js`. The client page has room for a Tasks card in the left column (or above the timeline); the timeline
  filter state is the natural default for a new task's business/account, as quick capture does.

## Decisions for later packages
- **C1 (sign-in)**: done — see "Sign-in". Passkeys later through the seam described there. Keep the localhost binding.
- **C2 (offline sync)**: done — server half in C2a, browser half and service worker in C2b (see both "Offline sync"
  sections). `health_meta.instance_id` still names the database and survives restores; the sync `generation` is what
  changes on a restore.
- **C3a (core records)**: done — see "CRM". **C3b (screens)**: done — see "CRM screens". Next: C4a tasks (`OWNERS` for the owner, `business_id`⇧ + optional client/account refs, the
  business's `default_owner` for automated tasks), D2 matching (links), the pull scope when volumes need it.
- The live database sits in a Docker **named volume** (SQLite locking on Docker Desktop bind mounts to macOS is not
  trustworthy); only finished backup files cross to the Mac via the `/offsite` bind mount.
- Ports: suite 3100 (Order Manager uses 3000 in its container). Node 22 is the tested runtime (`engines >=22.12`).

## Testing
`npm test` from the root. Server tests use `node --test`, real temporary SQLite files and an app on an ephemeral port
(`createApp` + `listen(0)`) — no mocks of the database. Client tests (`client/test`) run the sync engine in Node with
fake-indexeddb against such a server (helpers.js: `startServer`, `makeDevice` with an on/off connection switch); the
client build must succeed. The sync engine tests (`server/test/sync.test.js`, `client/test/engine.test.js`) run without
the crm module so its seeded businesses don't shift their counts; `startServer(t, config, { crm: true })` includes it. `npm run test:e2e` runs the built app in Chromium (iPhone emulation) — run it when
touching the engine, the service worker or the sync UI. Write a test with every module and every bug fix.

## Git
Work on a branch per package (`pkg/<id>-<name>`), small commits, PR into `main`. No remote yet.
