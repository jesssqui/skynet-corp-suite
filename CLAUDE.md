# Skynet Corp Suite

Private business and life management suite (Skynet Corp Suite; `suite` is the short name used in code, packages and file names) for two people. Runs in Docker on the Mac mini at
home beside the Wholesale Order Manager, reachable only over Tailscale (Tailscale Serve gives it HTTPS). The CRM is its
core (later packages); this repo currently holds the skeleton from package **C0**: server, client shell, one example
module (`health`), tests, Docker and nightly backups.

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
shared/                    @suite/shared — ids.js (UUIDv7), time.js; tests in shared/test
server/src/
  index.js                 start: open db, createApp, listen, heartbeat, backup schedule, shutdown
  app.js                   createApp({config, db, log}) — migrations, services, routes, static client, errors
  config.js                every setting, from env (see .env.example)
  db/open.js               openDb(): the only way to open SQLite (pragmas)
  db/migrate.js            per-module migrations, schema_migrations table
  modules/index.js         server module registration list (order = migration order)
  modules/<name>/          index.js (shape), routes.js, service.js, migrations/NNN_name.sql|js
  backup/                  backup.js, restore.js, schedule.js
  lib/                     log.js, httpError.js, serverLock.js (heartbeat file)
server/scripts/            backup.js, restore.js (CLIs)
server/test/               node --test; helpers.js has tmpDir/testConfig/dumpDb
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

## Decisions for later packages
- **C1 (sign-in)**: sessions/passkeys go in their own module; set `app.set('trust proxy', 'loopback')` when cookies need
  `secure` (Tailscale Serve terminates TLS and proxies from loopback). Keep the localhost binding regardless.
- **C2 (offline sync)**: IDs and time helpers already live in `@suite/shared` so the client can make records offline.
  Each change ("keyed step") should get its own `newId()` as its idempotency key; UUIDv7 order = creation order per device.
  `health_meta.instance_id` names the database and survives restores — C2 may want an extra "restore generation" so
  devices can tell the server went back in time and re-send their outbox. No service worker yet; C2 adds it.
- The live database sits in a Docker **named volume** (SQLite locking on Docker Desktop bind mounts to macOS is not
  trustworthy); only finished backup files cross to the Mac via the `/offsite` bind mount.
- Ports: suite 3100 (Order Manager uses 3000 in its container). Node 22 is the tested runtime (`engines >=22.12`).

## Testing
`npm test` from the root. Server tests use `node --test`, real temporary SQLite files and an app on an ephemeral port
(`createApp` + `listen(0)`) — no mocks of the database. Client: the build must succeed (add component tests when there is
logic worth testing). Write a test with every module and every bug fix.

## Git
Work on a branch per package (`pkg/<id>-<name>`), small commits, PR into `main`. No remote yet.
