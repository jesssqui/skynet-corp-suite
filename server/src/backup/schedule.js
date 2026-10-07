// The nightly backup runs inside the server process (see CLAUDE.md, "Backups"):
// once a day at BACKUP_TIME in the container's local time zone (TZ), plus a
// catch-up run shortly after start-up when the last good backup is over a day old
// (the Mac was off, Docker was restarted, an update went out at 3 a.m.).
// A failed run is retried every hour until one succeeds, so a share that was
// briefly unmounted doesn't cost a whole day of backups.
const DAY_MS = 24 * 60 * 60 * 1000;
export const CATCH_UP_DELAY_MS = 2 * 60 * 1000;
export const RETRY_MS = 60 * 60 * 1000;

/** The next local time matching "HH:MM" strictly after `now`. DST-safe (recomputed every run). */
export function nextRunAt(time, now = new Date()) {
  const [h, m] = time.split(':').map(Number);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

/** True when a catch-up backup is due: never succeeded, or last success more than ~a day ago. */
export function needsCatchUp(lastSuccessAt, now = new Date()) {
  if (!lastSuccessAt) return true;
  const age = now - Date.parse(lastSuccessAt);
  return !Number.isFinite(age) || age > DAY_MS + 60 * 60 * 1000;
}

/**
 * @param {object} opts
 * @param {string} opts.time "HH:MM"
 * @param {() => Promise<unknown>} opts.run makes one backup; throws on failure
 * @param {string|null} [opts.lastSuccessAt]
 * @param {object} [opts.log]
 * @param {number} [opts.catchUpDelayMs] overridable for tests
 * @param {number} [opts.retryMs] overridable for tests
 * @returns {() => void} stop
 */
export function startBackupSchedule({
  time, run, lastSuccessAt = null, log = console, catchUpDelayMs = CATCH_UP_DELAY_MS, retryMs = RETRY_MS,
}) {
  let nightly = null;
  let catchUp = null;
  let retry = null;
  let stopped = false;
  let running = false;

  const fire = async (why) => {
    if (running || stopped) return;
    running = true;
    clearTimeout(retry);
    retry = null;
    try {
      log.info(`backup starting (${why})`);
      await run();
      log.info('backup finished');
    } catch (err) {
      if (!stopped) {
        log.error(`backup failed: ${err.message} — retrying in ${Math.round(retryMs / 60000)} min`);
        retry = setTimeout(() => fire('retry after failure'), retryMs);
        retry.unref();
      }
    } finally {
      running = false;
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    const at = nextRunAt(time);
    nightly = setTimeout(async () => {
      await fire('nightly');
      scheduleNext();
    }, at - Date.now());
    nightly.unref();
    log.info(`next backup at ${at.toString()}`);
  };

  if (needsCatchUp(lastSuccessAt)) {
    catchUp = setTimeout(() => fire('catch-up: last good backup is over a day old'), catchUpDelayMs);
    catchUp.unref();
  }
  scheduleNext();

  return () => {
    stopped = true;
    clearTimeout(nightly);
    clearTimeout(catchUp);
    clearTimeout(retry);
  };
}
