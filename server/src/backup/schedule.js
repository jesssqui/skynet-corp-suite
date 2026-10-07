// The nightly backup runs inside the server process (see CLAUDE.md, "Backups"):
// once a day at BACKUP_TIME in the container's local time zone (TZ), plus a
// catch-up run shortly after start-up when the last good backup is over a day old
// (the Mac was off, Docker was restarted, an update went out at 3 a.m.).
const DAY_MS = 24 * 60 * 60 * 1000;
export const CATCH_UP_DELAY_MS = 2 * 60 * 1000;

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
 * @param {{ time: string, run: () => Promise<unknown>, lastSuccessAt?: string|null, log?: object }} opts
 * @returns {() => void} stop
 */
export function startBackupSchedule({ time, run, lastSuccessAt = null, log = console }) {
  let timer = null;
  let catchUp = null;
  let stopped = false;
  let running = false;

  const fire = async (why) => {
    if (running) return;
    running = true;
    try {
      log.info(`backup starting (${why})`);
      await run();
      log.info('backup finished');
    } catch (err) {
      log.error(`backup failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    const at = nextRunAt(time);
    timer = setTimeout(async () => {
      await fire('nightly');
      scheduleNext();
    }, at - Date.now());
    timer.unref();
    log.info(`next backup at ${at.toString()}`);
  };

  if (needsCatchUp(lastSuccessAt)) {
    catchUp = setTimeout(() => fire('catch-up: last good backup is over a day old'), CATCH_UP_DELAY_MS);
    catchUp.unref();
  }
  scheduleNext();

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(catchUp);
  };
}
