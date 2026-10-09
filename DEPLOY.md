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

It should print `restored … (N tables, M migrations)` and `Restore complete` — counted after the copy is brought up to
this version (a backup from an older version adds ": the backup had K, L applied now"), so M matches the number of
migrations System shows after the restore. (`/tmp/drill.db` is thrown away with
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

## 6. Order Manager connection (D1)

**First: where does the Order Manager run?** Its checked-in `docker-compose.yml` mounts `/mnt/user/appdata/…` (an Unraid
path) and publishes port 3089 — so check before connecting:
- **On this Mac (Docker Desktop)** → its address for the suite is **`http://host.docker.internal:3100`**: Docker
  Desktop forwards `host.docker.internal` to the Mac's own `127.0.0.1`, where compose publishes the suite. Nothing is
  exposed to the LAN or the internet.
- **On another machine on the tailnet (e.g. the Unraid server)** → its address is the suite's Tailscale Serve address
  from step 3, **`https://<mac-name>.<tailnet>.ts.net`** (the one you open on the iPhone). No change to the suite is
  needed: the receiver authenticates by its signature only (no session, no Origin check), so Serve's HTTPS, `Host` and
  forwarded headers don't affect it (tested). Serve must map the root (`/`), as in step 3 — a path prefix would change
  the path the Order Manager signs. That machine must be on the tailnet, and its container must reach it: check with
  the command below using that address. If the container can't resolve `*.ts.net`, give it Tailscale's DNS
  (`dns: [100.100.100.100]` in its compose service) or run it on the host network. Enter that address in step 2 and
  set `WOM_CONNECT_URL` in the suite's `.env` to it so the Connections card shows the right one.
- Never publish the suite's port on the LAN for this, and never turn on Tailscale Funnel.

1. **In the suite** (signed in, either of you): **System → Connections → Wholesale Order Manager**. Note the *Suite
   address* (`http://host.docker.internal:3100`, or with your `SUITE_PORT`; `WOM_CONNECT_URL` in `.env` overrides what
   is shown). Press **Make the secret** and **copy it now: it is shown only once** (stored encrypted; the key is the
   file `/app/data/wom-secret.key` in the volume, never in the database or the backups).
2. **In the Order Manager** (admin): **Settings → Integrations → Suite connection**: paste the address and the secret,
   **Connect**, then **Send existing customers and orders** (everything made before the connection).
3. **Back in the suite**: the Connections card shows *Last success* within seconds and *N records from M customers
   waiting for a client*. Open **Clients → Order Manager customers waiting for a client** (`/wholesale`) and, for each,
   **Link to a client…** (an existing client's account, or a new account under it) or **Create a client**. Their orders,
   payments, returns and refunds then show on that client's timeline (type *Orders*), with spend and last order on the
   account. A linked account is marked age-restricted and gets an active wholesale relationship if it has none.

**Check** (this could not be tried where the suite was built — no Docker there):
- From the Order Manager's container (with the address you chose):
  `docker exec wholesale-order-manager node -e "fetch('http://host.docker.internal:3100/api/health').then(r=>r.text()).then(console.log)"`
  must print `{"ok":true,...}`. If it can't connect: the address doesn't fit where it runs (above), or the suite isn't
  running (`docker compose ps`). (On plain Linux Docker, `host.docker.internal` needs `extra_hosts:
  ["host.docker.internal:host-gateway"]` and still can't reach a port published on loopback — use the tailnet address.)
- The Order Manager's Settings → Suite connection shows no *last error* and *waiting* goes to 0.

4. **Notes and follow-ups (D5)** — **turn the switch on only after this version of the suite is running** (an older
   suite refuses the three new events, and the Order Manager parks them as refused): in the Order Manager (admin), **Settings → Integrations → Suite
   connection → Send CRM notes to the suite** → on. It sends every CRM note and follow-up date once (customers the suite
   never heard of first). Linked customers' notes then show on their client's timeline (*from the Order Manager*, with
   who wrote them; type Call / Email / Meeting / Note — a follow-up marked done shows under Notes as *Follow-up done*), and
   each follow-up date is a task **Follow up with …** due that day on the wholesale business's default owner's Today
   (System → Automations → *Order Manager follow-ups*). Mark follow-ups done **in the Order Manager**: the suite then
   finishes its task; finishing the task in the suite doesn't change the Order Manager (one way). Unlinked customers'
   notes wait with them on the Wholesale page (*N notes waiting*).
   **If it was switched on too early** (note events refused): **don't press Send again on refused note events with an
   Order Manager older than A11b** — for a note added and then deleted, both events were refused, and the older Order
   Manager re-sends only the add (it marks the refused delete superseded), so the deleted note would stay on the
   timeline for good. Update the Order Manager to A11b first: its **Send again** re-sends every refused event of a
   record, in order (a note's add, then its delete), and only the latest of a customer's refused follow-up dates (with
   the date as it is now). Then press **Send again**.

5. **Matching (D2)** — **the first pass runs at the first start of this version and can't be switched off beforehand**
   (the automation only exists once D2 is running). It links, on its own, every waiting Order Manager customer whose
   clean email or phone is on exactly one active client's contact, where that client has a Wholesale, GWND or
   consulting relationship and no other waiting customer matches it (clients with no business yet, and several customers
   matching one client, are only suggested). One in-app alert lists them. **Review the result on Wholesale → Linked**
   (each says "Linked automatically (same email)") and use **Undo link…** on any that are wrong. To have later ones
   wait for review instead, switch **System → Automations → Link Order Manager customers automatically** off; strong
   matches then appear under **Wholesale → Suggestions**. Newly linked customers with a follow-up date in the Order
   Manager get their follow-up task at once (D5); check-ins and balance reminders come at most 10 new a day (D3). Every link can be undone (Wholesale → Linked → **Undo link…**, or the account card on the
   client page): the link goes, the customer waits again, and the age-restricted mark / wholesale relationship / account
   or client that linking made are put back when untouched. Links made **before** D2 can be undone too, but only the
   link goes (the suite didn't record what they changed). No "Download everything again" is needed on devices.

**Pausing**: the switch on the Connections card pauses the connection: the suite answers 503 and the Order Manager
keeps its events queued (nothing is lost), then sends them in order — within its retry wait, at most 5 minutes —
once it is switched on. **New secret…** (either of you) replaces the secret at once; paste it into the Order Manager,
whose events wait meanwhile.

**After restoring the suite from a backup** (step 5, same Mac): nothing to do in the Order Manager. The suite keeps the
Order Manager's data as it last said across the restore (and the secret), and puts the client timelines back to match
at start — notes and follow-up tasks too (D5; also when the backup is from before D5). **On a new Mac with the volume lost** (restored from the off-machine copy): the Order Manager's changes since
that backup aren't in it, and the Order Manager counts them as delivered. Make a new secret (the key file is gone),
connect again, then in the Order Manager use **Forget everything (it's a different suite)** and **Send existing
customers and orders**: everything that exists there now is sent again (applied by permanent id, nothing doubled).
Orders and payments **deleted** there since the backup can't be known this way — they stay as they were in the backup
(check the Order Manager's Bin and the client timelines by hand); the same for notes deleted there since the backup.

## 7. Your tasks in Apple Calendar (C6a)

Each of you can subscribe to a read-only calendar of your dated tasks (your own and the shared list's — never the
other person's own). No Apple password is involved: Apple Calendar reads a secret link from the suite.

**Optional, once**: put the suite's Tailscale address in `.env` so the link (and each event's "Open in the suite" link)
always uses it, wherever the page was opened:

```bash
SUITE_URL=https://<mac-mini-name>.<tailnet-name>.ts.net        # or …ts.net:8443 — exactly what you open on the iPhone
```

then `docker compose up -d`. Without it the link uses the address the page is open at — so **make the link from the
ts.net address** (the iPhone, or Safari on the Mac at the ts.net address). A link made at `http://localhost:3100` only
works on the Mac mini itself; the page warns about that.

1. In the suite: **Account → Calendar → Make my calendar link**. The link is shown **once** — copy it now (only a hash is
   kept; if it is lost, *Replace link…* and subscribe again).
2. **iPhone** (Tailscale on): Settings → Apps → Calendar → Calendar Accounts (older iOS: Settings → Calendar → Accounts)
   → Add Account → Other → **Add Subscribed Calendar** → paste the link as the Server → Next → Save. Then Calendar
   Accounts → **Fetch New Data** → *Every 15 minutes* (subscribed calendars aren't pushed). Use the https link as shown:
   the page offers no `webcal://` link, because calendar apps may fetch that over plain http, which Tailscale Serve's
   HTTPS address doesn't answer.
3. **Mac**: Calendar → File → **New Calendar Subscription…** → paste the link → Subscribe → Location **On My Mac** (not
   iCloud: iCloud's servers can't reach your tailnet, so an iCloud subscription stays empty) → Auto-refresh *Every 15
   minutes* → OK.
4. Check: a task with a due date appears at the next refresh (all-day, or at its time for its estimate — 30 minutes
   when none); tick it done in the suite and it disappears at the following refresh. An open task overdue by more than
   30 days also drops out of the calendar (it is still overdue in the suite). **Account → Calendar** shows when a
   calendar last read the link, and **System → Connections → Task calendar feed** whose links are on.

Each person does this with their own account. **Replace link…** (if a link may have leaked) stops the old one at once —
then remove the old subscription on each device and subscribe again; **Turn off…** stops it altogether. The switch on
the *Task calendar feed* card pauses every feed (calendars keep what they last read). The links survive restores
exactly as they are now (a replaced link doesn't come back).

**What the calendar shows**: task titles **as written**, the business and a link back to the task. The suite's own
tasks put account names and amounts in their titles (e.g. *Balance owing over 30 days: Lefty's, $412.50*), so those
appear in Apple Calendar on the phone and the Mac — on the lock screen and in notifications too. Notes, contacts and
other details are not sent. Anyone holding the link (and on your tailnet) can read the titles: keep it to yourselves,
and *Replace* it if it may have leaked. The link never appears in the suite's logs.

Tailscale must be on for the calendar to update; without it the calendar keeps its last copy. 20 wrong links from one
device within an hour lock that device out of every feed for an hour (an old subscription left after *Replace* never
gets near that); a server restart lifts it.

## 8. Renewals and recurring costs (D6)

Nothing to set up. After this version starts:

- **Client service renewals**: every morning at 7:50 the suite makes a task **30 days before** a client service's
  *Renews* date (services that aren't Done or Cancelled), due that day on the business's default owner's Today. **At the
  first start** (the first look is about 15 seconds after it, and it runs then if it is past 7:50), every service that
  renews within the next 30 days gets its reminder at once, due today — at most 20 a day, the soonest first; the rest come
  on the next mornings. Check the *Renews* dates on your services (client page → the service → Edit) if a reminder looks
  wrong: fix the date and the open task moves with it; set a service to Done or Cancelled and the suite finishes its task.
- **Our costs**: open **Costs** (a new tab, on the phone too) and add what the businesses and the home pay for — hosting,
  domains, software, insurance, subscriptions — with *Paid by* (Personal for the home), the amount, how often and the
  next renewal. Tick *Renews on its own* for automatic renewals. Every morning at 7:55 the suite makes a task **14 days
  before** each renewal (none for monthly costs that renew on their own), and moves an automatic one's date forward by
  its period once it has passed. One that doesn't renew on its own shows **Overdue — renewed?** after its date until you
  set the next one. A cost billed to a client: pick the relationship under *Resold to a client* and what they pay; it
  shows under that relationship on the client page.
- Both are silent (the task on Today is the reminder). To get an in-app alert as well, or to switch either off: **System →
  Automations → Client service renewals / Recurring cost renewals**. Finishing or deleting a reminder is final for that
  renewal date; a new date brings a new one when its day comes.
- The Friday review's *Renewals* step lists both. Devices need nothing (no *Download everything again*): costs are a new
  record type and arrive with the next sync.

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

Order Manager connection:
- **The Order Manager says "The suite refused the shared secret (or this computer's clock is off)"** → the secret
  differs (a new one was made in the suite: paste it again) or a clock is more than 5 minutes off (both containers use
  the Mac's clock). The suite's Connections card shows the reason as its last error.
- **"The suite answered 503"** → the connection is switched off on the suite's Connections card.
- **"Can't reach the suite"** → see the `docker exec … /api/health` check in step 6.
- **A customer is "Linked to more than one account"** (a link undone on one device and made again on another) → open
  the client pages, undo one link (`/wholesale` → Linked → Unlink, then link again): the suite never picks one by itself.

Task calendar:
- **The subscribed calendar stays empty or says it can't be reached** → on the Mac it must be *On My Mac*, not iCloud;
  the device must be on Tailscale; the link must be the ts.net address (not `localhost`) — remake it from the ts.net
  address or set `SUITE_URL`. `curl -sI <link>` on the Mac must answer `200` and `text/calendar`.
- **404** → the link was replaced or turned off (Account → Calendar shows *Off* or a newer link): subscribe with the
  new one and remove the old subscription. **503** → the *Task calendar feed* is switched off on System → Connections.
  **429** → too many wrong links from that device; wait an hour or restart the suite.
- **Times off by an hour** → `TZ` in `.env` (or `CALENDAR_TIME_ZONE`) must be the zone the tasks' times are meant in
  (America/Toronto).
