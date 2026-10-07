// Accounts and their factors: used by the auth service and by the users CLI
// (server/scripts/users.js), which is the only way to create an account.
import { newId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { ACTORS } from '@suite/shared/actors';
import {
  hashPassword, passwordProblem, newRecoveryCode, normalizeRecoveryCode, hashRecoveryCode, RECOVERY_CODE_COUNT,
} from './crypto.js';

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
  const deleteTotp = db.prepare('DELETE FROM auth_totp WHERE user_id = ?');
  const useTotpStep = db.prepare('UPDATE auth_totp SET last_step = ? WHERE user_id = ? AND last_step < ?');
  const deleteCodes = db.prepare('DELETE FROM auth_recovery_codes WHERE user_id = ?');
  const insertCode = db.prepare('INSERT INTO auth_recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)');
  const unusedCodes = db.prepare('SELECT * FROM auth_recovery_codes WHERE user_id = ? AND used_at IS NULL');
  const useCode = db.prepare('UPDATE auth_recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL');
  const endSessions = db.prepare(`UPDATE auth_sessions SET ended_at = @at, end_reason = @reason
    WHERE user_id = @user AND ended_at IS NULL AND id IS NOT @except`);

  async function createUser({ actor, username, displayName, password }) {
    if (!ACTORS.includes(actor)) throw new Error(`actor must be one of ${ACTORS.join(', ')}`);
    const name = normalizeUsername(username);
    if (!USERNAME_RE.test(name)) throw new Error('username: 2–32 characters, a–z 0–9 . _ - (starting with a letter or digit)');
    const display = typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 60) : name;
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    if (byActor.get(actor)) throw new Error(`There is already an account for ${actor}`);
    if (byUsername.get(name)) throw new Error(`The username ${name} is taken`);
    const hash = await hashPassword(password, scryptN);
    const id = newId();
    insertUser.run({ id, actor, username: name, display_name: display, password_hash: hash, at: iso() });
    return byId.get(id);
  }

  /** New password; ends the user's other sessions (all of them when exceptSessionId is null). */
  async function setPassword(userId, password, { exceptSessionId = null, reason = 'password_changed' } = {}) {
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const hash = await hashPassword(password, scryptN);
    db.transaction(() => {
      updatePassword.run(hash, iso(), userId);
      endSessions.run({ at: iso(), reason, user: userId, except: exceptSessionId });
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

  /** Remove the second factor entirely (CLI, for a lost phone and lost codes): next sign-in enrols again. */
  function resetTwoFactor(userId) {
    db.transaction(() => {
      deleteTotp.run(userId);
      deleteCodes.run(userId);
      endSessions.run({ at: iso(), reason: 'reset_by_admin', user: userId, except: null });
    })();
  }

  return {
    getUser: (id) => byId.get(id),
    getUserByUsername: (username) => byUsername.get(normalizeUsername(username)),
    listUsers: () => all.all(),
    createUser,
    setPassword,
    newRecoveryCodes,
    resetTwoFactor,
    getTotp: (userId) => getTotp.get(userId),
    enrollTotp: (userId, secret, step) => insertTotp.run(userId, secret, step, iso()),
    replaceTotp: (userId, secret, step) => replaceTotp.run(userId, secret, step, iso()),
    /** Record that a TOTP step was used; false if it (or a later one) already was (replay). */
    useTotpStep: (userId, step) => useTotpStep.run(step, userId, step).changes === 1,
    unusedRecoveryCodes: (userId) => unusedCodes.all(userId),
    useRecoveryCode: (codeId) => useCode.run(iso(), codeId).changes === 1,
    endSessions: (userId, reason, exceptSessionId = null) => endSessions.run({ at: iso(), reason, user: userId, except: exceptSessionId }),
  };
}
