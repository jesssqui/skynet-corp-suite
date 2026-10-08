# Deploying Skynet Corp Suite on the Mac mini

The suite runs in Docker on the Mac mini, listening only on the Mac's `127.0.0.1:3100`. Tailscale Serve puts an HTTPS
address in front of it that only devices on your tailnet can open, and every page needs one of the two accounts
(password + a code from an authenticator app). Backups run every night inside the container and are copied to a folder
that lives off the Mac.

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
curl -s http://127.0.0.1:3100/api/health   # {"ok":true,…} — details only show on the System page once signed in
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

Do **not** use `tailscale funnel` — that would put the suite on the public internet. Sign-in is a second lock, not a
reason to open the door.

## 3b. Create the two accounts, with two-factor

Accounts are only ever made here, on the Mac mini (there is no sign-up page), and two-factor is set up in the same
step — an account can't sign in, and nobody can attach their own authenticator to it, until a code from *its* phone
has been confirmed here. Do it with that person's iPhone in hand. `--actor` says who is who (`owner` = you,
`partner` = your partner) and is what the suite records on every change:

```bash
docker compose exec suite node server/scripts/users.js add --actor owner --username jessy --name "Jessy"
```

1. Type the password twice (nothing shows while typing; at least 12 characters — a few random words work well).
2. A QR code appears in Terminal. On **that person's iPhone**, open the Camera, point it at the QR code → *Add
   verification code* → it goes into the **Passwords** app (or scan it with Google Authenticator / 1Password). If the
   QR code won't scan, enlarge the Terminal window, or type the *Key* shown under it into the app instead.
3. Type the 6-digit code the phone now shows. Only now is the account saved.
4. **Save the 10 recovery codes** it prints (password manager, or paper kept away from the phone). Each signs in once if
   the phone is lost. They aren't shown again.

Then the partner's account, with the partner's phone:

```bash
docker compose exec suite node server/scripts/users.js add --actor partner --username <partner username> --name "<Partner name>"
docker compose exec suite node server/scripts/users.js list      # both show "2FA: on since …, 10 recovery codes left"
```

## 3c. Each iPhone: add to the Home Screen and sign in there

A home-screen web app on iPhone keeps its own sign-in, separate from Safari, so sign in **from the home-screen icon**:

1. iPhone connected to Tailscale → open the suite address from step 3 in Safari → Share → *Add to Home Screen* → *Add*.
   (The icon and name are placeholders for now.)
2. Open **Skynet Suite** from the Home Screen → sign in: username, password, then the code from Passwords (it may
   offer to fill it in above the keyboard).
3. Sign in on the Mac too (Safari, the same address). In the suite: **Account → Devices** shows the Mac browser and
   the iPhone (*iPhone · Home screen app*),
   each with a `100.x.y.z` address (the device's tailnet address). Rename them if you like (“Jessy's iPhone”).

Do the same on the partner’s iPhone with the partner’s account. Both of you now appear on the Devices page, and either of you can
**sign out any device** there (a lost phone, an old laptop): it is signed out at once, and the next time it connects it
clears the data saved on it and shows the sign-in screen.

Sessions last 30 days without use and at most 90 days (`SESSION_IDLE_DAYS`, `SESSION_MAX_DAYS` in `.env`); then that
device asks for the password and a code again (its data stays).

**Working offline.** Once signed in from the Home Screen icon (with a connection, once), the app opens with no signal
— airplane mode, no Tailscale — and shows what the phone has saved. Changes made then are kept on the phone; the bar
at the top says *Offline · N changes waiting*. They are sent when the app is **open** and the suite can be reached
again (an iPhone web app can't sync in the background): open the app once you're back online and wait for *All changes
saved*. If the bar says *N need attention*, tap it: those are changes the server refused, to fix or discard. Offline
only works through the HTTPS address from step 3 (service workers need HTTPS). After an update of the suite the app
shows *A new version of the suite is ready · Reload*.

## 4. Nightly backups

**Chosen approach: the container's own scheduler.** The server makes the backup itself every night at `BACKUP_TIME`
(default 03:15, `TZ` America/Toronto), copies it to the off-machine folder, verifies the copy and deletes copies older
than `BACKUP_KEEP_DAYS` (default 30; the newest is always kept). If the container was down at backup time, it catches
up two minutes after it starts. Nothing to set up on the Mac — no launchd plist, no Node on the Mac, no cron.

The automations (System → Automations: the Friday review list at 8:00 on Fridays, "no next step" at 7:30 daily) run
the same way: a scheduler inside the server, in the container's `TZ`, on by default in production
(`AUTOMATIONS_ENABLED=false` turns it off; *Run now* on that page works either way). After downtime each catches up
once for the current day or week.

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

**b) Full drill** — restore the live database from the off-machine copy and confirm it is the same data. First, signed
in on the Mac, open **System** and note the *Database ID* and the number of migrations. Then:

```bash
docker compose exec suite node server/scripts/backup.js
docker compose stop suite
docker compose run --rm suite node server/scripts/restore.js --list
docker compose run --rm suite node server/scripts/restore.js /offsite/<the backup you just made>
docker compose start suite
```

Open **System** again (you may have to sign in again): same Database ID and migrations. Spot-check records.

Once there is real data, also spot-check a few records you remember in the app after step (b).

**If the Mac mini is lost:** set up a new Mac with steps 0–2 (the database starts empty), then run step (b) from
`docker compose stop suite` onwards, pointing at the newest file in the off-machine folder.

**After any restore** the phones and Macs start over automatically the next time they connect: they download
everything again and re-send the changes they kept, so work done after the backup was made comes back.
**A restore also signs everyone out** (every session ends at the first start after it): each phone and Mac asks for
the password and a code again and keeps its saved data. Accounts, passwords and authenticators go back to the moment of
the backup — a password changed after it is the old one again (`users.js password` sets a new one). A device that was
signed out after the backup is no longer marked signed out on **Account → Devices**. It has no session and can't get
one without the password and a code, but if it is lost or gone, sign it out again there.

**To undo a restore:** stop the app and restore the `pre-restore-…db` file the restore printed, the same way
(it is inside the volume: `/app/data/backups/pre-restore-….db`).

## Troubleshooting

Offline:
- **The app doesn't open without a connection** → it must have been opened once, signed in, from the HTTPS ts.net
  address after it was added to the Home Screen; a plain `http://` address can't work offline. Open it once online
  and try again.
- **Changes stay "waiting"** → the app sends them only while it is open and can reach the suite: open it and check
  Tailscale is connected. It retries by itself; Offline data (from the bar or System) → *Sync now* forces a try.
- **Signing out deletes unsent changes** (on purpose: a signed-out phone may be lost). The app warns before it does,
  and the sign-in screen warns before another person signs in over them. Signing out with no connection works; the
  sign-out reaches the Mac mini the next time the device can reach it.

Sign-in:
- **“Request from another origin”** when signing in through the ts.net address → the suite isn't believing Tailscale
  Serve's forwarded headers. Check `TRUST_PROXY` isn't overridden in `.env` (the compose default is
  `loopback, uniquelocal`). As a last resort add the exact address to `.env`, e.g.
  `ALLOWED_ORIGINS=https://mac-mini.tail1234.ts.net:8443`, then `docker compose up -d`. On the Devices page every device
  should show a `100.x.y.z` address; a `172.x` or `192.168.x` one means the forwarded headers are being ignored.
- **“Too many attempts”** → wrong passwords or codes lock that account *from that address* (each tailnet device has
  its own `100.x.y.z` address) for 1 minute, then 2, 4… up to an hour; the same account still signs in from your other
  devices. 30 failures within an hour from several addresses lock the whole account for 15 minutes, and 20 failures
  from one address (any usernames) lock that address for both accounts.
  To lift locks now, on the Mac mini:
  `docker compose exec suite node server/scripts/users.js unlock <username>` — that account's locks, plus the
  address locks of every device that failed on it (`password` and `reset-2fa` do the same);
  `docker compose exec suite node server/scripts/users.js unlock --all` — every lock, all accounts and addresses.
- **Codes don't work** → the phone's clock must be right (Settings → General → Date & Time → Set Automatically). A code
  works once; wait for the next one.
- **Lost phone** → sign in on another device with a **recovery code** instead of the code, then Account → *Move to a new
  authenticator*, and on Devices sign the lost phone out. Running low on codes → Account → *New recovery codes*.
- **Lost phone and recovery codes** → on the Mac mini, with the new phone in hand:
  `docker compose exec suite node server/scripts/users.js reset-2fa <username>` — same QR-and-code steps as `add`;
  the old authenticator and codes stop working only once the new code is confirmed, and new recovery codes are printed.
- **Forgotten password** → `docker compose exec suite node server/scripts/users.js password <username>`.
  Both sign that person out everywhere (their saved data stays).
- **“Wrong username or password” although both are right** → `users.js list`: if it says *2FA: NOT SET UP*, run
  `reset-2fa` for that account (an account can't sign in without confirmed two-factor).

Server and backups:

- `Set SUITE_OFFSITE_DIR in .env` when starting → step 2, `.env` is missing the folder.
- Backup error mentioning `.suite-backup-target` → the drive/share isn't mounted, or step 1's `touch` was skipped.
- Permission denied writing `/offsite` → in Docker Desktop → Settings → Resources → File sharing, make sure the folder's
  parent (`/Users` or `/Volumes`) is listed, then `docker compose up -d`.
- Port 3100 already in use → set `SUITE_PORT` in `.env` and use that port in the `tailscale serve` command and the
  `curl` checks.
