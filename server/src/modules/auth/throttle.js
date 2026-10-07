// Rate limiting for sign-in and re-checks: failed attempts counted per key, with locks that grow.
// Shared by the auth service and the users CLI (`users.js unlock`).
//
// Each attempt is charged to three keys at once:
//   acct-ip  this account from this address — 5 failures lock it for 1 min, doubling up to 1 h.
//            Someone guessing from their own device only ever locks themselves out, so they can't
//            keep the other person (on other devices) out of their account.
//   acct     this account from anywhere — 30 failures within an hour lock it for 15 min. Stops
//            guessing spread over many addresses; one device can't reach it (its acct-ip lock
//            allows ~5 in the first hour and ~1 an hour after that).
//   ip       this address, any username — 20 failures lock it for 1 min, doubling up to 1 h.
// Unknown usernames are counted the same way (no hint that an account exists).
import { normalizeUsername } from './accounts.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

export const RULES = {
  acctIp: { threshold: 5, baseMs: MIN, maxMs: HOUR, windowMs: 24 * HOUR },
  acct: { threshold: 30, baseMs: 15 * MIN, maxMs: 15 * MIN, windowMs: HOUR },
  ip: { threshold: 20, baseMs: MIN, maxMs: HOUR, windowMs: 24 * HOUR },
};

const userPart = (username) => normalizeUsername(username).slice(0, 64);

export function throttleKeys(username, ip) {
  const u = userPart(username);
  const addr = ip ?? 'unknown';
  return [
    { key: `acct-ip:${u}@${addr}`, rule: RULES.acctIp },
    { key: `acct:${u}`, rule: RULES.acct },
    { key: `ip:${addr}`, rule: RULES.ip },
  ];
}

/** Remove every lock and count for an account (all addresses). Returns how many were removed. */
export function clearAccountThrottle(db, username) {
  const u = userPart(username);
  const prefix = `acct-ip:${u}@`;
  return db.prepare('DELETE FROM auth_throttle WHERE key = ? OR substr(key, 1, ?) = ?')
    .run(`acct:${u}`, prefix.length, prefix).changes;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ now: () => number }} opts
 */
export function createThrottle(db, { now }) {
  const iso = (ms) => new Date(ms).toISOString();
  const getRow = db.prepare('SELECT * FROM auth_throttle WHERE key = ?');
  const put = db.prepare(`INSERT INTO auth_throttle (key, failures, first_failure_at, last_failure_at, locked_until)
    VALUES (@key, @failures, @first_failure_at, @last_failure_at, @locked_until)
    ON CONFLICT (key) DO UPDATE SET failures = excluded.failures, first_failure_at = excluded.first_failure_at,
      last_failure_at = excluded.last_failure_at, locked_until = excluded.locked_until`);
  const del = db.prepare('DELETE FROM auth_throttle WHERE key = ?');

  /** The row if it still counts: within its window, or still locked. */
  function live(key, rule, t) {
    const row = getRow.get(key);
    if (!row) return null;
    const locked = row.locked_until && Date.parse(row.locked_until) > t;
    if (!locked && t - Date.parse(row.first_failure_at) > rule.windowMs) return null;
    return row;
  }

  /**
   * Charge one attempt to every key, unless one of them is locked.
   * @returns {{ waitMs: number, locksSet?: Record<string, string|null> }}
   */
  const charge = db.transaction((keys) => {
    const t = now();
    let waitMs = 0;
    for (const { key, rule } of keys) {
      const until = live(key, rule, t)?.locked_until;
      if (until && Date.parse(until) > t) waitMs = Math.max(waitMs, Date.parse(until) - t);
    }
    if (waitMs > 0) return { waitMs };
    const locksSet = {};
    for (const { key, rule } of keys) {
      const row = live(key, rule, t);
      const failures = (row?.failures ?? 0) + 1;
      const lockMs = failures >= rule.threshold ? Math.min(rule.maxMs, rule.baseMs * 2 ** (failures - rule.threshold)) : 0;
      const lockedUntil = lockMs ? iso(t + lockMs) : null;
      put.run({ key, failures, first_failure_at: row?.first_failure_at ?? iso(t), last_failure_at: iso(t), locked_until: lockedUntil });
      locksSet[key] = lockedUntil;
    }
    return { waitMs: 0, locksSet };
  });

  /** A right answer takes back its charge, including any lock that charge set. */
  const refund = db.transaction((keys, charged) => {
    for (const { key } of keys) {
      const row = getRow.get(key);
      if (!row) continue;
      const ownLock = charged.locksSet?.[key] && row.locked_until === charged.locksSet[key];
      put.run({ ...row, failures: Math.max(0, row.failures - 1), locked_until: ownLock ? null : row.locked_until });
    }
  });

  /** After a full sign-in: forget this account's failures from this address (and the address's). */
  const clear = db.transaction((keys) => {
    for (const { key, rule } of keys) if (rule !== RULES.acct) del.run(key);
  });

  const prune = (t) => db.prepare(`DELETE FROM auth_throttle WHERE last_failure_at < ?
    AND (locked_until IS NULL OR locked_until < ?)`).run(iso(t - 24 * HOUR), iso(t));

  return { charge, refund, clear, prune };
}
