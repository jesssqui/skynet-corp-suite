// A heartbeat file in the data folder that says "the server is running on this
// database". The restore script refuses to swap the database while it is fresh,
// which works across containers sharing the data volume (a port check would not).
import fs from 'node:fs';
import os from 'node:os';

export const HEARTBEAT_MS = 15_000;
export const STALE_MS = 60_000;

function write(lockPath, info) {
  const tmp = `${lockPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info));
  fs.renameSync(tmp, lockPath);
}

export function startHeartbeat(lockPath, { intervalMs = HEARTBEAT_MS } = {}) {
  const info = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
  const beat = () => write(lockPath, { ...info, heartbeatAt: new Date().toISOString() });
  beat();
  const timer = setInterval(() => {
    try { beat(); } catch { /* data folder briefly unavailable; next beat retries */ }
  }, intervalMs);
  timer.unref();
  return function stop() {
    clearInterval(timer);
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  };
}

/** The lock's contents if a server has beaten within STALE_MS, else null. */
export function runningServer(lockPath, { now = Date.now(), staleMs = STALE_MS } = {}) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
  const age = now - Date.parse(info.heartbeatAt);
  return Number.isFinite(age) && age < staleMs ? info : null;
}
