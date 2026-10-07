// Accounts and their factors: used by the auth service and by the users CLI
// (server/scripts/users.js), which is the only way to create an account. An account is
// created together with its confirmed authenticator (TOTP) and recovery codes: there is
// no window in which the password alone could be used to attach someone else's app.
import { newId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { ACTORS } from '@suite/shared/actors';
import {
  hashPassword, passwordProblem, newRecoveryCode, normalizeRecoveryCode, hashRecoveryCode, RECOVERY_CODE_COUNT,
} from './crypto.js';
import { clearAccountThrottle, clearAllThrottle } from './throttle.js';

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const normalizeUsername = (u) => (typeof u === 'string' ? u.trim().toLowerCase() : '');

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ scryptN: number, now?: () => number }} opts
 */
export function createAccounts(db, { scryptN, now = Date.now }) {
  const iso = () => nowIso(new Date(now()));

  const byId = db.prepare('SELECT * FROM auth_users WHERE id = ?');
  const byUsername = db.prepare('SELECT * FROM auth_users WHERE username = ?');
  const byActor = db.prepare('SELECT * FROM auth_users WHERE actor = ?');
  const all = db.prepare('SELECT * FROM auth_users ORDER BY actor');
  const insertUser = db.prepare(`INSERT INTO auth_users
    (id, actor, username, display_name, password_hash, password_changed_at, created_at)
    VALUES (@id, @actor, @username, @display_name, @password_hash, @at, @at)`);
  const updatePassword = db.prepare('UPDATE auth_users SET password_hash = ?, password_changed_at = ? WHERE id = ?');
  const getTotp = db.prepare('SELECT * FROM auth_totp WHERE user_id = ?');
  const insertTotp = db.prepare('INSERT INTO auth_totp (user_id, secret, last_step, enrolled_at) VALUES (?, ?, ?, ?)');
  const replaceTotp = db.prepare(`INSERT INTO auth_totp (user_id, secret, last_step, enrolled_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET secret = excluded.secret, last_step = excluded.last_step, enrolled_at = excluded.enrolled_at`);
  const useTotpStep = db.prepare('UPDATE auth_totp SET last_step = ? WHERE user_id = ? AND last_step < ?');
  const deleteCodes = db.prepare('DELETE FROM auth_recovery_codes WHERE user_id = ?');
  const insertCode = db.prepare('INSERT INTO auth_recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)');
  const unusedCodes = db.prepare('SELECT * FROM auth_recovery_codes WHERE user_id = ? AND used_at IS NULL');
  const useCode = db.prepare('UPDATE auth_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL');
  const endSessions = db.prepare(`UPDATE auth_sessions SET ended_at = @at, end_reason = @reason
    WHERE user_id = @user AND ended_at IS NULL AND id IS NOT @except`);

  /** Validate a new account's details (before asking for a password or showing a QR code). */
  function checkNewUser({ actor, username, displayName }) {
    if (!ACTORS.includes(actor)) throw new Error(`actor must be one of ${ACTORS.join(', ')}`);
    const name = normalizeUsername(username);
    if (!USERNAME_RE.test(name)) throw new Error('username: 2–32 characters, a–z 0–9 . _ - (starting with a letter or digit)');
    if (byActor.get(actor)) throw new Error(`There is already an account for ${actor}`);
    if (byUsername.get(name)) throw new Error(`The username ${name} is taken`);
    const display = typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 60) : name;
    return { actor, username: name, displayName: display };
  }

  /**
   * Create an account. With `totp` ({ secret, step } — a secret whose code was just confirmed) the
   * authenticator and 10 recovery codes are stored in the same transaction; returns { user, recoveryCodes }.
   * Without it the account can't sign in (tests and tooling only).
   */
  async function createUserWithTwoFactor(input, totp) {
    const { actor, username, displayName } = checkNewUser(input);
    const problem = passwordProblem(input.password);
    if (problem) throw new Error(problem);
    const hash = await hashPassword(input.password, scryptN);
    const id = newId();
    let recoveryCodes = null;
    db.transaction(() => {
      checkNewUser(input); // again, inside the transaction
      insertUser.run({ id, actor, username, display_name: displayName, password_hash: hash, at: iso() });
      if (totp) {
        insertTotp.run(id, totp.secret, totp.step, iso());
        recoveryCodes = newRecoveryCodes(id);
      }
    })();
    return { user: byId.get(id), recoveryCodes };
  }

  async function createUser(input) {
    return (await createUserWithTwoFactor(input, null)).user;
  }

  /** New password; ends the user's other sessions (all of them when exceptSessionId is null). */
  async function setPassword(userId, password, { exceptSessionId = null, reason = 'password_changed' } = {}) {
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const hash = await hashPassword(password, scryptN);
    db.transaction(() => {
      updatePassword.run(hash, iso(), userId);
      endSessions.run({ at: iso(), reason, user: userId, except: exceptSessionId });
      clearAccountThrottle(db, byId.get(userId).username);
    })();
  }

  /** Fresh recovery codes (the old ones stop working). Returns the codes to show once. */
  function newRecoveryCodes(userId) {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    db.transaction(() => {
      deleteCodes.run(userId);
      for (const c of codes) insertCode.run(newId(), userId, hashRecoveryCode(normalizeRecoveryCode(c)), iso());
    })();
    return codes;
  }

  /**
   * A new authenticator (its code just confirmed) and new recovery codes, from the CLI (lost phone and
   * lost codes). Signs the person out everywhere and unlocks the account. Returns the codes to show once.
   */
  function replaceTwoFactor(userId, secret, step) {
    return db.transaction(() => {
      replaceTotp.run(userId, secret, step, iso());
      const codes = newRecoveryCodes(userId);
      endSessions.run({ at: iso(), reason: 'reset_by_admin', user: userId, except: null });
      clearAccountThrottle(db, byId.get(userId).username);
      return codes;
    })();
  }

  return {
    getUser: (id) => byId.get(id),
    getUserByUsername: (username) => byUsername.get(normalizeUsername(username)),
    listUsers: () => all.all(),
    checkNewUser,
    createUser,
    createUserWithTwoFactor,
    setPassword,
    newRecoveryCodes,
    replaceTwoFactor,
    /** Clear sign-in locks and failure counts for this account and the addresses that failed on it. */
    unlock: (username) => clearAccountThrottle(db, username),
    /** Clear every sign-in lock and failure count (all accounts and addresses). */
    unlockAll: () => clearAllThrottle(db),
    getTotp: (userId) => getTotp.get(userId),
    replaceTotp: (userId, secret, step) => replaceTotp.run(userId, secret, step, iso()),
    /** Record that a TOTP step was used; false if it (or a later one) already was (replay). */
    useTotpStep: (userId, step) => useTotpStep.run(step, userId, step).changes === 1,
    unusedRecoveryCodes: (userId) => unusedCodes.all(userId),
    useRecoveryCode: (codeId) => useCode.run(iso(), codeId).changes === 1,
    endSessions: (userId, reason, exceptSessionId = null) => endSessions.run({ at: iso(), reason, user: userId, except: exceptSessionId }),
  };
}
