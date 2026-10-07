# Skynet Corp Suite

Private business and life management suite (Skynet Corp Suite; `suite` is the short name used in code, packages and file names) for two people. Runs in Docker on the Mac mini at
home beside the Wholesale Order Manager, reachable only over Tailscale (Tailscale Serve gives it HTTPS). The CRM is its
core (later packages); this repo currently holds the skeleton from package **C0** (server, client shell, one example
module `health`, tests, Docker, nightly backups), the server half of offline sync from **C2a** (module `sync`) and
sign-in from **C1** (module `auth`: two accounts, password + authenticator code, sessions, devices).

## Stack
- **Server**: Node 22+ (ESM), Express 5, SQLite via better-sqlite3 (WAL, foreign keys, busy_timeout), helmet. Port **3100**.
- **Client**: React 18 + Vite 6, react-router-dom 7 (same API as the v6 the Order Manager uses), inline styles + theme tokens.
- **Shared**: `shared/` (`@suite/shared`) holds code that runs in both Node and the browser (IDs, time helpers).
- npm workspaces: one `npm ci` at the root installs everything; one `package-lock.json`.
- Dependencies are kept few and mainstream; ask before adding one. Client: `qrcode-generator` (MIT, no dependencies,
  draws the authenticator QR code at two-factor setup).

## Commands (repo root)
```bash
npm ci                 # install everything
npm test               # shared + server tests (node --test) and a client build — must pass before every commit
npm run dev:server     # API on http://127.0.0.1:3100 (data in ./data, git-ignored)
npm run dev:client     # Vite on http://localhost:5173, proxies /api to :3100
npm run build && npm start   # production-style: server also serves client/dist
npm run backup         # one backup now (same code as the nightly one)
npm run restore -- --list | <file> [--to <path>] [--force]
npm run user:add -- --actor owner|partner --username <name> --name "Display"   # the only way to make an account
npm run user:list | user:password -- <username> | user:reset-2fa -- <username>
```
Deploying, Tailscale Serve, backup scheduling and the restore drill: **DEPLOY.md**.

## Layout
```
shared/                    @suite/shared — ids.js (UUIDv7), time.js, hlc.js (sync clock stamps), actors.js; tests in shared/test
server/src/
  index.js                 start: open db, createApp, listen, heartbeat, backup schedule, shutdown
  app.js                   createApp({config, db, log}) — migrations, services, routes, static client, errors
  config.js                every setting, from env (see .env.example)
  db/open.js               openDb(): the only way to open SQLite (pragmas)
  db/migrate.js            per-module migrations, schema_migrations table
  modules/index.js         server module registration list (order = migration order)
  modules/<name>/          index.js (shape), routes.js, service.js, migrations/NNN_name.sql|js
  modules/auth/            sign-in: crypto.js (scrypt, TOTP, codes), accounts.js (shared with the CLI), service.js
                           (sessions, devices, rate limits, the request guard), routes.js, deviceName.js
  modules/sync/            offline sync: registry.js, service.js, routes.js, identity.js (session -> actor + device)
  backup/                  backup.js, restore.js, schedule.js
  lib/                     log.js, httpError.js, serverLock.js (heartbeat file)
server/scripts/            backup.js, restore.js, users.js (CLIs)
server/test/               node --test; helpers.js: tmpDir/testConfig/startApp/testClock/ensureTestUsers/sessionFor/dumpDb;
                           fixtures/syncdemo = test-only synced module
client/src/
  main.jsx, App.jsx        providers + router built from the module list, behind AuthGate
  auth/                    session.jsx (AuthProvider, useAuth), SignInScreen.jsx (+ AuthGate), TwoFactorParts.jsx,
                           Qr.jsx, device.js (device id, clearLocalData — C2b extends it)
  shell/                   AppShell (sidebar on desktop, bottom tab bar on phones), shell.css
  ui/                      the shared look: theme.css (tokens, light/dark), theme.jsx, components.jsx, icons.jsx; import from ui/index.js
  modules/index.js         client module registration list -> nav + routes
  modules/<name>/          index.jsx ({ id, nav, routes }) + pages
  api/client.js            fetch wrapper (api.get/post/put/del, ApiError); sends X-Suite-Device; 401 session codes
                           fire SESSION_LOST_EVENT
client/public/             manifest.webmanifest, icons (placeholders)
```

## Modules
One folder per module on each side, same name on both (`server/src/modules/health`, `client/src/modules/health`).
- **Server shape** (`modules/<name>/index.js`): `{ name, migrationsDir, createService(ctx), createRouter(ctx, service),
  createPublicRouter? }`. Routes mount at `/api/<name>`. **Every `createRouter` route requires a signed-in session**
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
- Store emails lowercase and phones digits-only (plan: matching across businesses).

## Security posture
- **Network**: the server binds `127.0.0.1` by default; in Docker it listens on 0.0.0.0 inside the container but
  compose publishes it on the Mac's `127.0.0.1:3100` only, and Tailscale Serve is the only way in from other devices
  (tailnet members only). Keep it that way even with sign-in: don't publish the port on other interfaces, and don't
  enable Tailscale Funnel.
- **Sign-in on everything**: every API route needs a session except `POST /api/auth/login|login/code|login/enroll` and
  `GET /api/health` (which answers anonymous callers with `{ ok, name, version, time }` only; details, backup paths
  and errors need a session). Unknown `/api` paths answer 401 to anonymous callers. The built client (HTML/JS) is public;
  it shows nothing until `GET /api/auth/session` succeeds.
- helmet sets a strict CSP (`script-src 'self'`): no inline scripts, no third-party script/style hosts.
- **No HSTS** (helmet's is off): browsers apply it to the whole ts.net hostname on every port, which would force the
  Order Manager's plain-http port on the same Mac to https. Tailscale Serve already makes the suite HTTPS-only.

## Sign-in (auth module, C1)
Code `server/src/modules/auth/`, client `client/src/auth/` + `client/src/modules/auth/`, tests `server/test/auth.test.js`.
- **Accounts**: exactly two, one per actor (`owner`, `partner` — `@suite/shared/actors`, also what sync records as
  "who"). Made only by `server/scripts/users.js` (`npm run user:add`), never over HTTP; usernames lowercase.
  The CLI also sets a new password (`user:password`, signs the person out everywhere) and removes two-factor
  (`user:reset-2fa`, for a lost phone *and* lost recovery codes: the next sign-in enrols again).
- **Factors**: password (scrypt N=2^16 r=8 p=1, parameters stored in each hash, at most 2 hashes at once) **and**
  an authenticator code (TOTP RFC 6238: SHA-1, 6 digits, 30 s, ±1 step, each step usable once — `auth_totp.last_step`)
  or one of 10 one-time recovery codes (60 bits, stored as SHA-256). All secret comparisons are constant-time.
  First sign-in after the CLI made the account = enrolment: password → QR / otpauth link / key → first code →
  recovery codes shown once. Until someone enrols, anyone with the password could enrol their own app: **enrol right
  after creating the account.** In-app: change password (current password; other sessions end), new recovery codes
  and "move to a new authenticator" (password + a code, which may be a recovery code; other sessions end).
- **Passkey seam** (not built): a passkey is both factors at once. Add `auth_passkeys` (credential id, public key,
  counter, user), `POST /login/passkey/options` + `/login/passkey` in the public router, verify, then call
  `service.startSession({ user, deviceHint, installed, userAgent, ip, secondFactor: 'passkey' })` — the same function the
  code steps use, so devices and cookies work unchanged. `second_factor`, `end_reason` and challenge `kind` have no
  CHECK lists so this needs no table rebuild. Registering a passkey belongs on the Account page behind `recheck()`.
- **Sign-in endpoints** (public): `POST /api/auth/login {username, password, deviceId?, installed?}` →
  `{ next: 'code' | 'enroll', challenge, enroll?: { secret, otpauthUrl } }`; `POST /login/code {challenge, code}` (TOTP
  or recovery code) and `POST /login/enroll {challenge, code}` → session cookie + `{ user, device, session,
  deviceReplaced, recoveryCodes? }`. A challenge is a random token (hashed in `auth_challenges`), 5 min (15 for
  enrolment), 5 tries. Wrong username and wrong password give the identical 401 `bad_credentials`.
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
- **Rate limiting** (`auth_throttle`, survives restarts): every password or code attempt — sign-in and re-checks — is
  charged to `user:<username as typed>` (unknown usernames too: no enumeration) and `ip:<req.ip>` *before* checking,
  and refunded if right (so parallel guesses can't slip past). Account: 5 failures → locked 1 min, doubling per further
  failure, max 1 h; IP: 20 failures, same backoff. 429 `too_many_attempts` + `Retry-After`. A full sign-in clears the
  account's counter; failures are forgotten after 24 h without one.
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
  shows the sign-in screen with the reason. The session is re-checked when the app returns to the foreground and
  every 5 minutes.
- **Backups** contain the auth tables (scrypt hashes, TOTP secrets, hashed tokens). A restore brings back the sessions
  and device states of that moment: devices signed in after the backup must sign in again, and a device signed out
  after the backup is signed in again — check the Devices page after any restore.

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
  a change is `{ entity, id, seq, deleted:false, flagged, fields, clashes:[open clashes] }` or `{ entity, id, seq,
  deleted:true }`. Keep calling with the returned cursor until `hasMore` is false. Cursors are opaque (`<generation>.<seq>`).
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
   create only (notes, activities, call logs: they simply add up). The table must start with the module's name;
   entity names are global, short and singular (`client`, `task`, `note`).
   **Column types must match field types** or registration fails: `text`/`date`/`datetime`/`id`/`enum` → `TEXT`,
   `integer`/`boolean` → `INTEGER`, `number` → `REAL` (`id`, `deleted_at`, `created_*`/`updated_*` TEXT, `flagged`
   INTEGER). A boolean in a TEXT column would come back as '1.0'; "0123" in an INTEGER column as 123.
3. The module comes **after `sync`** in `modules/index.js`.
4. **All writes go through sync**: devices push steps; server code calls `ctx.services.sync.applyLocal({ actor, entity,
   op, recordId?, fields })` (imports, automations — same rules and log, server's own device id). TEMP triggers make
   any other write to a registered table fail on the app's connection. Reads are the module's own SQL — always filter
   `deleted_at IS NULL`; `sync.recordState(entity, id)` gives flag + open clashes for a record page.
5. Plan new fields as nullable or with defaults; renaming/removing a synced field breaks old outbox steps (`unknown_field`).
6. **Migrations never change rows of a synced table.** Schema changes (add a column) are fine; data changes
   (backfills, clean-ups, imports) run *after* start-up through `applyLocal` — migrations run before the guard exists,
   so SQL there would bypass the log, field versions and clash rules, and devices would never receive the change.
7. A newly added field reaches devices only on records changed afterwards (pulls are by record change). To push a
   backfilled value out, write it with `applyLocal`; to show a new field everywhere at once, devices must re-pull from
   scratch (C2b: pull without `since`).

**For C2b (browser side)**: the device id comes from sign-in (`client/src/auth/device.js` `getDeviceId()`, stored by
`AuthProvider.signedIn`); keep a persisted HLC (`createHlc(id, { last })`, save `peek()`); for each change write the step to the outbox with `seen` = cursor of the last complete pull; push in order,
remove `applied`/`duplicate`/`clash` results from the outbox but **keep sent steps for 30 days** (backup retention) so
they can be re-sent after a restore; move `rejected` ones to "needs attention". On `reset: true` (or a new
`generation` on push), drop the local copy of server data, re-push the kept sent steps first (in order; they come back
`duplicate` or apply again), then the outbox, then pull from scratch. Show `clashes` on each record with keep/discard.
- **One push in flight per device.** Mac browser tabs share one device id (and HLC) through storage: use a Web Lock
  (`navigator.locks.request('suite-sync', …)`) or a single leader tab, so two tabs never push or stamp in parallel.
- **Pending outbox changes are re-applied on top of pulled records** when showing data: the pulled record is the
  server's truth; replay the not-yet-acknowledged steps over it so the person sees their own changes until they're in.
- **Retries**: network errors / 5xx → retry the same steps unchanged (keys make it safe). `rejected` with `not_found`
  → keep it and retry after the next pull or reset (its record may still be coming); other `rejected` codes →
  "needs attention" (the person fixes or discards; a fixed change is a *new* step with a new key). `stale` fields are
  done, not errors.
- **Plan pruning**: `sync_steps`, `sync_field_versions`, tombstones in `sync_records`/module tables, resolved clashes and
  `sync_devices` rows all grow forever. Before it matters, add pruning (e.g. steps and tombstones older than the
  device-retention window, devices unseen for 90 days, forcing those devices to reset).
**Sign-out and C2b (must do)**: a device can be signed out from the other device at any time. When any request
(sync or not) answers **401 `device_signed_out`**, the device must delete everything it stores for the person —
offline records (IndexedDB), the outbox **including unsent changes** (on purpose: the phone may be lost), kept sent
steps, the HLC, the pull cursor, cached API responses in the service worker — then show sign-in. Do it by extending
`clearLocalData()` in `client/src/auth/device.js` (already called on that code, on Sign out, and when sign-in returns
a different device id). On `session_expired` keep everything: after signing in again the device keeps its id, so its
outbox pushes as before. Send `X-Suite-Device` on every request (`api/client.js` does) so a device whose cookie is
gone still hears `device_signed_out`. A signed-out device must not push before clearing (the server refuses anyway).
If the browser is shared (Mac), signing in as the other person gives a new device id → clear the previous person's
copy first (`deviceReplaced` / id change).

**Not done in C2a / open**: clash resolution needs a connection (no offline "resolve" step yet); pulls send every
synced record (no "active clients only" scope yet — C2b/C3a should add an entity/scope filter); nothing is pruned
yet (see "Plan pruning"); after a restore, an edit re-sent before its record is re-created and then retried may show
as a clash against the re-created record's values (safe: kept for review); restores done by copying a file by hand (not `npm run restore`) are not
detected — always restore with the script.

## Decisions for later packages
- **C1 (sign-in)**: done — see "Sign-in". Passkeys later through the seam described there. Keep the localhost binding.
- **C2 (offline sync)**: server half done in C2a — see "Offline sync" above. `health_meta.instance_id` still names the
  database and survives restores; the sync `generation` is what changes on a restore. No service worker yet; C2b adds it.
- The live database sits in a Docker **named volume** (SQLite locking on Docker Desktop bind mounts to macOS is not
  trustworthy); only finished backup files cross to the Mac via the `/offsite` bind mount.
- Ports: suite 3100 (Order Manager uses 3000 in its container). Node 22 is the tested runtime (`engines >=22.12`).

## Testing
`npm test` from the root. Server tests use `node --test`, real temporary SQLite files and an app on an ephemeral port
(`createApp` + `listen(0)`) — no mocks of the database. Client: the build must succeed (add component tests when there is
logic worth testing). Write a test with every module and every bug fix.

## Git
Work on a branch per package (`pkg/<id>-<name>`), small commits, PR into `main`. No remote yet.
