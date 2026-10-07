# Skynet Corp Suite

Private business and life management suite (Skynet Corp Suite; `suite` is the short name used in code, packages and file names) for two people. Runs in Docker on the Mac mini at
home beside the Wholesale Order Manager, reachable only over Tailscale (Tailscale Serve gives it HTTPS). The CRM is its
core (later packages); this repo currently holds the skeleton from package **C0** (server, client shell, one example
module `health`, tests, Docker, nightly backups) and the server half of offline sync from **C2a** (module `sync`).

## Stack
- **Server**: Node 22+ (ESM), Express 5, SQLite via better-sqlite3 (WAL, foreign keys, busy_timeout), helmet. Port **3100**.
- **Client**: React 18 + Vite 6, react-router-dom 7 (same API as the v6 the Order Manager uses), inline styles + theme tokens.
- **Shared**: `shared/` (`@suite/shared`) holds code that runs in both Node and the browser (IDs, time helpers).
- npm workspaces: one `npm ci` at the root installs everything; one `package-lock.json`.
- Dependencies are kept few and mainstream; ask before adding one.

## Commands (repo root)
```bash
npm ci                 # install everything
npm test               # shared + server tests (node --test) and a client build — must pass before every commit
npm run dev:server     # API on http://127.0.0.1:3100 (data in ./data, git-ignored)
npm run dev:client     # Vite on http://localhost:5173, proxies /api to :3100
npm run build && npm start   # production-style: server also serves client/dist
npm run backup         # one backup now (same code as the nightly one)
npm run restore -- --list | <file> [--to <path>] [--force]
```
Deploying, Tailscale Serve, backup scheduling and the restore drill: **DEPLOY.md**.

## Layout
```
shared/                    @suite/shared — ids.js (UUIDv7), time.js, hlc.js (sync clock stamps); tests in shared/test
server/src/
  index.js                 start: open db, createApp, listen, heartbeat, backup schedule, shutdown
  app.js                   createApp({config, db, log}) — migrations, services, routes, static client, errors
  config.js                every setting, from env (see .env.example)
  db/open.js               openDb(): the only way to open SQLite (pragmas)
  db/migrate.js            per-module migrations, schema_migrations table
  modules/index.js         server module registration list (order = migration order)
  modules/<name>/          index.js (shape), routes.js, service.js, migrations/NNN_name.sql|js
  modules/sync/            offline sync: registry.js, service.js, routes.js, identity.js (stand-in until C1)
  backup/                  backup.js, restore.js, schedule.js
  lib/                     log.js, httpError.js, serverLock.js (heartbeat file)
server/scripts/            backup.js, restore.js (CLIs)
server/test/               node --test; helpers.js has tmpDir/testConfig/dumpDb; fixtures/syncdemo = test-only synced module
client/src/
  main.jsx, App.jsx        providers + router built from the module list
  shell/                   AppShell (sidebar on desktop, bottom tab bar on phones), shell.css
  ui/                      the shared look: theme.css (tokens, light/dark), theme.jsx, components.jsx, icons.jsx; import from ui/index.js
  modules/index.js         client module registration list -> nav + routes
  modules/<name>/          index.jsx ({ id, nav, routes }) + pages
  api/client.js            fetch wrapper (api.get/post/put/del, ApiError)
client/public/             manifest.webmanifest, icons (placeholders)
```

## Modules
One folder per module on each side, same name on both (`server/src/modules/health`, `client/src/modules/health`).
- **Server shape** (`modules/<name>/index.js`): `{ name, migrationsDir, createService(ctx), createRouter(ctx, service) }`.
  Routes mount at `/api/<name>`. `ctx = { db, config, log, services }`; `ctx.services.<other>` is how a module uses
  another one. **A module reads and writes only its own tables** — never another module's.
- **Client shape** (`modules/<name>/index.jsx`): `{ id, nav: { label, icon, order }, routes: [{ path, element }] }`.
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

## Security posture (until C1)
There is **no sign-in yet**. The server binds `127.0.0.1` by default; in Docker it listens on 0.0.0.0 inside the
container but compose publishes it on the Mac's `127.0.0.1:3100` only, and Tailscale Serve is the only way in from other
devices (tailnet members only). Don't publish the port on other interfaces, and don't enable Tailscale Funnel, before C1.
helmet sets a strict CSP (`script-src 'self'`): no inline scripts, no third-party script/style hosts.
**No HSTS** (helmet's is off): browsers apply it to the whole ts.net hostname on every port, which would force the
Order Manager's plain-http port on the same Mac to https. Tailscale Serve already makes the suite HTTPS-only.

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

**Endpoints** (`/api/sync`; identity until C1: headers `X-Suite-Device: <uuidv7>` and `X-Suite-Actor: owner|partner`,
or `deviceId`/`actor` in the body/query):
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
  value (it comes back in `stale`, not a clash), so late or re-sent steps can't undo newer work. Rejected steps are
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
  or deleting after all. A delete of something you had fully seen just deletes, and settles as `superseded` only the
  open clashes whose steps the deleting device had seen; an edit of something you knew was deleted is rejected (`deleted`).
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

**For C2b (browser side)**: keep a device id (`newId()`, once) and a persisted HLC (`createHlc(id, { last })`, save
`peek()`); for each change write the step to the outbox with `seen` = cursor of the last complete pull; push in order,
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
**For C1**: replace `identify()` in `modules/sync/identity.js` with the session (actor from the account, device id
bound to the session); keep the `{ actor, deviceId }` shape. `ACTORS` there are the two people (`system` = server).

**Not done in C2a / open**: clash resolution needs a connection (no offline "resolve" step yet); pulls send every
synced record (no "active clients only" scope yet — C2b/C3a should add an entity/scope filter); nothing is pruned
yet (see "Plan pruning"); after a restore, an edit re-sent before its record is re-created and then retried may show
as a clash against the re-created record's values (safe: kept for review); restores done by copying a file by hand (not `npm run restore`) are not
detected — always restore with the script.

## Decisions for later packages
- **C1 (sign-in)**: sessions/passkeys go in their own module; set `app.set('trust proxy', 'loopback')` when cookies need
  `secure` (Tailscale Serve terminates TLS and proxies from loopback). Keep the localhost binding regardless.
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
