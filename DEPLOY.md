# Deploying Skynet Corp Suite on the Mac mini

The suite runs in Docker on the Mac mini, listening only on the Mac's `127.0.0.1:3100`. Tailscale Serve puts an HTTPS
address in front of it that only devices on your tailnet can open. Backups run every night inside the container and are
copied to a folder that lives off the Mac.

Commands are run in Terminal on the Mac mini, in the repo folder, unless it says otherwise.

## 0. One-time Mac setup

1. **Docker Desktop** for Mac installed. Settings → General → turn on *Start Docker Desktop when you sign in to your
   computer*. Docker Desktop runs inside your user session, so the Mac must stay signed in: System Settings → Users &
   Groups → *Automatically log in as* your user (or never sign out).
2. **Keep the Mac awake and coming back after a power cut**:
   ```bash
   sudo pmset -a sleep 0 disksleep 0 autorestart 1
   ```
   (Or System Settings → Energy: *Prevent automatic sleeping*, *Start up automatically after a power failure*.)
3. **Tailscale** installed and signed in on the Mac, with the `tailscale` command available. With the standalone app,
   use the menu bar item → *Install CLI*, or call it by its full path:
   `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
4. In the Tailscale admin console → **DNS**: turn on **MagicDNS** and **HTTPS Certificates** (Serve needs both).

## 1. Pick the off-machine backup folder

Backups must end up somewhere that survives the Mac mini dying. Pick one folder on the Mac that is either synced to the
cloud or lives on another device. **Use iCloud Drive or Google Drive unless you have a reason not to** — they are
ordinary folders on the Mac's own disk, so they are always there when Docker starts.

| Option | Folder on the Mac | Notes |
|---|---|---|
| iCloud Drive | `/Users/<you>/Library/Mobile Documents/com~apple~CloudDocs/Suite Backups` | Simplest. Check the files appear on another device. |
| Google Drive (Drive for desktop) | `/Users/<you>/Library/CloudStorage/GoogleDrive-<account>/My Drive/Suite Backups` | Set Drive to *Mirror files* or *Stream* — both work. |
| Network share / NAS (not recommended) | `/Volumes/<share>/suite-backups` | See the warning below. Add `/Volumes` in Docker Desktop → Settings → Resources → File sharing. |

**If you use a network share anyway:** Docker Desktop can start before the share is mounted at login. The container
then either fails to start or gets an empty stand-in folder instead of the share, and macOS sometimes remounts the share
as `/Volumes/<share>-1`, so the path in `.env` silently points at the wrong place. The marker file below makes backups
fail loudly (and the app shows a red banner) rather than write to the wrong place, but you have to fix it by hand:
after every restart of the Mac, once the share shows up in Finder at the exact path in `.env`, run

```bash
docker compose up -d --force-recreate
docker compose exec suite node server/scripts/backup.js     # must end with "copied off-machine"
```

Create the folder and the marker file that tells the backup "this is the real folder" (if the drive or share is not
mounted, the marker is missing and the backup fails loudly instead of writing to the Mac's own disk):

```bash
mkdir -p "/Users/<you>/Library/Mobile Documents/com~apple~CloudDocs/Suite Backups"
touch "/Users/<you>/Library/Mobile Documents/com~apple~CloudDocs/Suite Backups/.suite-backup-target"
```

## 2. Configure and start

```bash
git clone https://github.com/jesssqui/skynet-corp-suite.git ~/Developer/skynet-corp-suite
cd ~/Developer/skynet-corp-suite
cp .env.example .env
open -e .env                            # set SUITE_OFFSITE_DIR to the folder from step 1 (no quotes needed)
APP_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build
```

Check it (if you changed `SUITE_PORT` in `.env`, use that port instead of 3100 here and in every `curl` below):

```bash
docker compose ps                       # STATUS should become "healthy"
curl -s http://127.0.0.1:3100/api/health
docker compose logs --tail=20 suite     # shows "listening" and "next backup at …"
```

The database lives in the Docker volume `suite_suite-data` (not a folder on the Mac — SQLite's locking is only reliable
inside Docker's own disk). `docker compose down` keeps it; **`docker compose down -v` deletes it** — never use `-v`.

To update later: `git pull && APP_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build`.
Migrations run automatically on start. Take a backup first (step 4) before any update that changes data.

## 3. HTTPS on the tailnet with Tailscale Serve

First see what Serve already does on this Mac (the Wholesale Order Manager may already use it):

```bash
tailscale serve status
```

**If nothing is served on port 443**, give the suite the main address:

```bash
tailscale serve --bg 3100
```

→ `https://<mac-mini-name>.<tailnet-name>.ts.net/`

**If 443 is already used** (for example by the Order Manager), put the suite on its own HTTPS port instead of a path —
the suite is a home-screen app and wants to own the root of its address:

```bash
tailscale serve --bg --https=8443 3100
```

→ `https://<mac-mini-name>.<tailnet-name>.ts.net:8443/`

`--bg` keeps the setting across restarts. `tailscale serve status` shows the address; to remove it:
`tailscale serve --https=8443 off` (or `--https=443`). This is the current Serve syntax (Tailscale 1.52 and later);
**confirm with `tailscale serve --help`** on the Mac before running it, since flags have changed between versions.

Do **not** use `tailscale funnel` — that would put the suite on the public internet, and it has no sign-in until C1.

Open the address on the iPhone (Tailscale connected) → Share → *Add to Home Screen*. The icon and name are
placeholders for now.

## 4. Nightly backups

**Chosen approach: the container's own scheduler.** The server makes the backup itself every night at `BACKUP_TIME`
(default 03:15, `TZ` America/Toronto), copies it to the off-machine folder, verifies the copy and deletes copies older
than `BACKUP_KEEP_DAYS` (default 30; the newest is always kept). If the container was down at backup time, it catches
up two minutes after it starts. Nothing to set up on the Mac — no launchd plist, no Node on the Mac, no cron.

Why not launchd: a plist would have to run `docker compose exec …` from your user session and fail quietly when Docker
isn't up yet, and it would not move with the app. The trade-off is that no backup is made while the app is down — but
nothing changes while it is down, and the catch-up run covers it when it comes back.

Run one now and confirm it reached the off-machine folder:

```bash
docker compose exec suite node server/scripts/backup.js
ls -l "<your SUITE_OFFSITE_DIR>"
```

If a backup fails, it is retried every hour until one works, and a red banner appears across the top of every page of
the suite until the problem is fixed. The **System** page in the suite (or `curl -s http://127.0.0.1:3100/api/health`) shows the last good
backup; `backup.ok: false` means it is over a day old or the off-machine copy failed, with the reason in
`backup.lastError`. Local copies are also kept inside the volume at `/app/data/backups` for quick restores.

## 5. Restore drill (do it before go-live, then every few months)

Restoring always means: stop the app, restore, start the app. The restore script refuses to run while the app is up,
checks the backup file, and saves the database it replaces as `/app/data/backups/pre-restore-<time>.db`.

**a) Quick check, nothing touched** — proves the latest off-machine copy is readable:

```bash
docker compose run --rm suite node server/scripts/restore.js --list
docker compose run --rm suite node server/scripts/restore.js /offsite/<newest suite-….db> --to /tmp/drill.db
```

It should print `restored … (N tables, M migrations)` and `Restore complete`. (`/tmp/drill.db` is thrown away with
the one-off container.)

**b) Full drill** — restore the live database from the off-machine copy and confirm it is the same data:

```bash
curl -s http://127.0.0.1:3100/api/health        # note db.instanceId and db.migrations
docker compose exec suite node server/scripts/backup.js
docker compose stop suite
docker compose run --rm suite node server/scripts/restore.js --list
docker compose run --rm suite node server/scripts/restore.js /offsite/<the backup you just made>
docker compose start suite
curl -s http://127.0.0.1:3100/api/health        # same instanceId and migrations; open the app and spot-check records
```

Once there is real data, also spot-check a few records you remember in the app after step (b).

**If the Mac mini is lost:** set up a new Mac with steps 0–2 (the database starts empty), then run step (b) from
`docker compose stop suite` onwards, pointing at the newest file in the off-machine folder.

**To undo a restore:** stop the app and restore the `pre-restore-…db` file the restore printed, the same way
(it is inside the volume: `/app/data/backups/pre-restore-….db`).

## Troubleshooting

- `Set SUITE_OFFSITE_DIR in .env` when starting → step 2, `.env` is missing the folder.
- Backup error mentioning `.suite-backup-target` → the drive/share isn't mounted, or step 1's `touch` was skipped.
- Permission denied writing `/offsite` → in Docker Desktop → Settings → Resources → File sharing, make sure the folder's
  parent (`/Users` or `/Volumes`) is listed, then `docker compose up -d`.
- Port 3100 already in use → set `SUITE_PORT` in `.env` and use that port in the `tailscale serve` command and the
  `curl` checks.
