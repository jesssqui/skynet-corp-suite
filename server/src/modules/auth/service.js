// Sign-in, sessions, devices, rate limiting and the request guard. CLAUDE.md,
// "Sign-in (auth module)", explains the design; this file is the only code that
// reads or writes auth_* tables (with accounts.js, which the CLI shares).
import { newId, isId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { HttpError } from '../../lib/httpError.js';
import { createAccounts, normalizeUsername } from './accounts.js';
import {
  verifyPassword, hashPassword, passwordProblem, newTotpSecret, matchTotp, totpStep, otpauthUrl,
  normalizeRecoveryCode, hashRecoveryCode, newToken, sha256, sameSecret, PASSWORD_MAX,
} from './crypto.js';
import { deviceNameFromUserAgent } from './deviceName.js';

export const COOKIE_NAME = 'suite_session';
export const ISSUER = 'Skynet Corp Suite';

export const LIMITS = {
  // Failed sign-in attempts (wrong password or code) per account, and per IP address.
  // At `threshold` failures the key is locked for baseMs, doubling with each further failure, up to maxMs.
  account: { threshold: 5, baseMs: 60_000, maxMs: 60 * 60_000 },
  ip: { threshold: 20, baseMs: 60_000, maxMs: 60 * 60_000 },
  forgetFailuresMs: 24 * 60 * 60_000, // a key with no failure for this long starts from zero
  challengeMs: { sign_in: 5 * 60_000, enroll: 15 * 60_000, totp_reset: 15 * 60_000 },
  challengeAttempts: 5, // wrong codes on one challenge before it is used up (start again)
  touchMs: 60_000, // how often a session's / device's last-seen is written
  keepEndedSessionsMs: 180 * 24 * 60 * 60_000,
};

// The answers a request without a usable session gets (401, `code`). The client acts on them:
//   not_signed_in      show sign-in
//   session_expired    show sign-in; keep local data (same person, same device)
//   device_signed_out  this device was signed out (here or from the other one): clear the local copy, then sign in
const PROBLEMS = {
  not_signed_in: 'Sign in to continue',
  session_expired: 'Your session has ended. Sign in again.',
  device_signed_out: 'This device was signed out. Sign in again.',
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const fail = (status, code, message, extra = {}) => new HttpError(status, message, undefined, { code, ...extra });
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return v.length > 0 && v.length <= 128 ? v : null;
    }
  }
  return null;
}

export function createAuthService({ db, config, log, services, now = Date.now }) {
  const cfg = config.auth;
  const accounts = createAccounts(db, { scryptN: cfg.scryptN, now });
  const iso = (ms = now()) => nowIso(new Date(ms));
  const allowedOrigins = new Set(cfg.allowedOrigins.map((o) => o.toLowerCase()));
  // Compared against when the username doesn't exist, so a wrong username takes as long as a wrong password.
  const dummyHash = hashPassword(newToken(), cfg.scryptN);

  // ---- statements -------------------------------------------------------------
  const sessionByToken = db.prepare(`SELECT s.*, d.name AS device_name, d.signed_out_at AS device_signed_out_at,
      u.actor, u.username, u.display_name
    FROM auth_sessions s JOIN auth_devices d ON d.id = s.device_id JOIN auth_users u ON u.id = s.user_id
    WHERE s.token_hash = ?`);
  const endSession = db.prepare('UPDATE auth_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL');
  const endDeviceSessions = db.prepare(`UPDATE auth_sessions SET ended_at = ?, end_reason = ?
    WHERE device_id = ? AND ended_at IS NULL`);
  const touchSession = db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?');
  const insertSession = db.prepare(`INSERT INTO auth_sessions
    (id, token_hash, user_id, device_id, second_factor, created_at, last_seen_at, expires_at)
    VALUES (@id, @token_hash, @user_id, @device_id, @second_factor, @at, @at, @expires_at)`);

  const getDevice = db.prepare('SELECT * FROM auth_devices WHERE id = ?');
  const insertDevice = db.prepare(`INSERT INTO auth_devices (id, user_id, name, user_agent, created_at, last_seen_at, last_ip)
    VALUES (@id, @user_id, @name, @user_agent, @at, @at, @ip)`);
  const touchDevice = db.prepare('UPDATE auth_devices SET last_seen_at = ?, last_ip = ? WHERE id = ?');
  const updateDeviceUa = db.prepare('UPDATE auth_devices SET user_agent = ?, last_seen_at = ?, last_ip = ? WHERE id = ?');
  const renameDeviceStmt = db.prepare('UPDATE auth_devices SET name = ? WHERE id = ?');
  const markDeviceSignedOut = db.prepare(`UPDATE auth_devices SET signed_out_at = ?, signed_out_by = ?
    WHERE id = ? AND signed_out_at IS NULL`);
  const allDevices = db.prepare(`SELECT d.*, u.display_name, u.actor, u.username, b.display_name AS signed_out_by_name,
      EXISTS (SELECT 1 FROM auth_sessions s WHERE s.device_id = d.id AND s.ended_at IS NULL
        AND s.expires_at > @now AND s.last_seen_at > @idle_cutoff) AS signed_in
    FROM auth_devices d JOIN auth_users u ON u.id = d.user_id LEFT JOIN auth_users b ON b.id = d.signed_out_by
    ORDER BY (d.signed_out_at IS NULL) DESC, d.last_seen_at DESC`);

  const insertChallenge = db.prepare(`INSERT INTO auth_challenges
    (id, token_hash, kind, user_id, session_id, totp_secret, device_hint, installed, created_at, expires_at)
    VALUES (@id, @token_hash, @kind, @user_id, @session_id, @totp_secret, @device_hint, @installed, @at, @expires_at)`);
  const challengeByToken = db.prepare('SELECT * FROM auth_challenges WHERE token_hash = ?');
  const countChallengeAttempt = db.prepare('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?');
  const useChallenge = db.prepare('UPDATE auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL');

  const getThrottle = db.prepare('SELECT * FROM auth_throttle WHERE key = ?');
  const putThrottle = db.prepare(`INSERT INTO auth_throttle (key, failures, last_failure_at, locked_until)
    VALUES (@key, @failures, @last_failure_at, @locked_until)
    ON CONFLICT (key) DO UPDATE SET failures = excluded.failures, last_failure_at = excluded.last_failure_at,
      locked_until = excluded.locked_until`);
  const deleteThrottle = db.prepare('DELETE FROM auth_throttle WHERE key = ?');

  // ---- housekeeping -------------------------------------------------------------
  function prune() {
    const t = now();
    db.transaction(() => {
      db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(iso(t - 24 * 60 * 60_000));
      db.prepare('DELETE FROM auth_throttle WHERE last_failure_at < ? AND (locked_until IS NULL OR locked_until < ?)')
        .run(iso(t - LIMITS.forgetFailuresMs), iso(t));
      // Device rows are kept (a signed-out device must keep getting "signed out" answers).
      db.prepare('DELETE FROM auth_sessions WHERE ended_at IS NOT NULL AND ended_at < ?').run(iso(t - LIMITS.keepEndedSessionsMs));
      db.prepare('DELETE FROM auth_sessions WHERE ended_at IS NULL AND expires_at < ?').run(iso(t - LIMITS.keepEndedSessionsMs));
    })();
  }
  prune();
  if (accounts.listUsers().length === 0) {
    log?.warn('no accounts yet: create them with `npm run user:add` (see DEPLOY.md)');
  }

  // ---- rate limiting ------------------------------------------------------------
  // Every sign-in or re-check attempt is charged as a failure *before* the password or code
  // is checked (so parallel guesses can't slip past the limit), then refunded if it was right.
  const throttleKeys = (username, ip) => [
    { key: `user:${normalizeUsername(username).slice(0, 64)}`, rule: LIMITS.account },
    { key: `ip:${ip ?? 'unknown'}`, rule: LIMITS.ip },
  ];

  function liveRow(key, t) {
    const row = getThrottle.get(key);
    if (!row) return null;
    const lockedUntil = row.locked_until ? Date.parse(row.locked_until) : 0;
    if (t - Date.parse(row.last_failure_at) > LIMITS.forgetFailuresMs && lockedUntil <= t) return null;
    return row;
  }

  const chargeAttempt = db.transaction((keys) => {
    const t = now();
    let waitMs = 0;
    for (const { key } of keys) {
      const row = liveRow(key, t);
      const until = row?.locked_until ? Date.parse(row.locked_until) : 0;
      if (until > t) waitMs = Math.max(waitMs, until - t);
    }
    if (waitMs > 0) return { waitMs };
    const locksSet = {};
    for (const { key, rule } of keys) {
      const failures = (liveRow(key, t)?.failures ?? 0) + 1;
      const lockMs = failures >= rule.threshold ? Math.min(rule.maxMs, rule.baseMs * 2 ** (failures - rule.threshold)) : 0;
      const lockedUntil = lockMs ? iso(t + lockMs) : null;
      putThrottle.run({ key, failures, last_failure_at: iso(t), locked_until: lockedUntil });
      locksSet[key] = lockedUntil;
    }
    return { waitMs: 0, locksSet };
  });

  // A right answer takes back its charge, including any lock that charge set.
  const refundAttempt = db.transaction((keys, charged) => {
    for (const { key } of keys) {
      const row = getThrottle.get(key);
      if (!row) continue;
      const ownLock = charged.locksSet[key] && row.locked_until === charged.locksSet[key];
      putThrottle.run({ key, failures: Math.max(0, row.failures - 1), last_failure_at: row.last_failure_at,
        locked_until: ownLock ? null : row.locked_until });
    }
  });

  const clearAttempts = db.transaction((keys) => {
    for (const { key } of keys) deleteThrottle.run(key);
  });

  function charge(keys) {
    const charged = chargeAttempt(keys);
    const { waitMs } = charged;
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);
      const minutes = Math.ceil(seconds / 60);
      throw fail(429, 'too_many_attempts',
        `Too many attempts. Try again in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`,
        { headers: { 'Retry-After': String(seconds) } });
    }
    return charged;
  }

  // ---- second factors -----------------------------------------------------------
  // Each method checks a code for a user and uses it up. A passkey would not go here: it is
  // both factors at once and would call startSession() directly after its own verification.
  const secondFactors = {
    totp(user, code) {
      const totp = accounts.getTotp(user.id);
      if (!totp) return false;
      const step = matchTotp(totp.secret, code, now(), totp.last_step);
      return step !== null && accounts.useTotpStep(user.id, step);
    },
    recovery(user, code) {
      const normalized = normalizeRecoveryCode(code);
      if (!normalized) return false;
      const hash = hashRecoveryCode(normalized);
      let match = null;
      for (const row of accounts.unusedRecoveryCodes(user.id)) {
        if (sameSecret(row.code_hash, hash) && !match) match = row; // compare all: constant time
      }
      return Boolean(match) && accounts.useRecoveryCode(match.id);
    },
  };

  /** 'totp' | 'recovery' if the code is right (and now used up), else null. */
  function checkCode(user, rawCode) {
    if (typeof rawCode !== 'string' || rawCode.length > 64) return null;
    const code = rawCode.replace(/\s/g, '');
    if (/^\d{6}$/.test(code)) return secondFactors.totp(user, code) ? 'totp' : null;
    return secondFactors.recovery(user, code) ? 'recovery' : null;
  }

  // ---- challenges (between the password and the code) ---------------------------
  function makeChallenge({ kind, userId, sessionId = null, totpSecret = null, deviceHint = null, installed = false }) {
    const token = newToken();
    const t = now();
    insertChallenge.run({
      id: newId(), token_hash: sha256(token), kind, user_id: userId, session_id: sessionId, totp_secret: totpSecret,
      device_hint: isId(deviceHint) ? deviceHint : null, installed: installed ? 1 : 0,
      at: iso(t), expires_at: iso(t + LIMITS.challengeMs[kind]),
    });
    return { token, expiresAt: iso(t + LIMITS.challengeMs[kind]) };
  }

  function openChallenge(token, kinds) {
    const ch = typeof token === 'string' && token.length <= 128 ? challengeByToken.get(sha256(token)) : null;
    if (!ch || !kinds.includes(ch.kind) || ch.used_at || Date.parse(ch.expires_at) <= now()
      || ch.attempts >= LIMITS.challengeAttempts) {
      throw fail(401, 'challenge_expired', 'That took too long or had too many tries. Start again.');
    }
    return ch;
  }

  // ---- sessions and devices -----------------------------------------------------
  function publicUser(u) {
    return { id: u.id, actor: u.actor, username: u.username, displayName: u.display_name };
  }

  /**
   * Choose the device a sign-in belongs to. A device id the browser already had is kept when
   * it is this person's and not signed out (so an expired session doesn't orphan its unsent
   * changes), or when no one knows it (e.g. the database was restored from a backup made
   * before the device signed in; the device keeps its id, its steps and its outbox).
   * Otherwise the device gets a new id and the browser must drop what it holds for the old one.
   */
  function chooseDevice(user, hint) {
    if (!isId(hint)) return null;
    const existing = getDevice.get(hint);
    if (existing) return existing.user_id === user.id && !existing.signed_out_at ? existing : null;
    const syncActor = services.sync?.deviceActor?.(hint);
    if (syncActor && syncActor !== user.actor) return null;
    return { id: hint, isNew: true };
  }

  /**
   * Start a session after both factors passed (or a passkey, later). Synchronous.
   * @returns {{ token, session, device, user, deviceReplaced: boolean }}
   */
  function startSession({ user, deviceHint = null, installed = false, userAgent = null, ip = null, secondFactor }) {
    const t = now();
    const ua = str(userAgent, 512);
    return db.transaction(() => {
      let device = chooseDevice(user, deviceHint);
      if (!device || device.isNew) {
        const id = device?.id ?? newId();
        insertDevice.run({ id, user_id: user.id, name: deviceNameFromUserAgent(ua, { installed }), user_agent: ua, at: iso(t), ip });
        device = getDevice.get(id);
      } else {
        updateDeviceUa.run(ua, iso(t), ip, device.id);
        endDeviceSessions.run(iso(t), 'replaced', device.id); // one session per device
      }
      const token = newToken();
      const session = {
        id: newId(), token_hash: sha256(token), user_id: user.id, device_id: device.id, second_factor: secondFactor,
        at: iso(t), expires_at: iso(t + cfg.sessionMaxMs),
      };
      insertSession.run(session);
      return {
        token,
        user: publicUser(user),
        device: { id: device.id, name: device.name },
        session: { id: session.id, createdAt: session.at, expiresAt: session.expires_at },
        deviceReplaced: Boolean(deviceHint) && deviceHint !== device.id,
      };
    })();
  }

  /** Look up the session behind a cookie: { auth } or { problem }. Ends sessions that ran out. */
  function resolveSession(token, { ip } = {}) {
    if (!token) return { problem: 'not_signed_in' };
    const row = sessionByToken.get(sha256(token));
    if (!row) return { problem: 'not_signed_in' };
    if (row.device_signed_out_at) return { problem: 'device_signed_out' };
    if (row.ended_at) return { problem: 'session_expired' };
    const t = now();
    const lastSeen = Date.parse(row.last_seen_at);
    if (t >= Date.parse(row.expires_at) || t - lastSeen >= cfg.sessionIdleMs) {
      endSession.run(iso(t), 'expired', row.id);
      return { problem: 'session_expired' };
    }
    let seen = lastSeen;
    if (t - lastSeen >= LIMITS.touchMs) {
      db.transaction(() => {
        touchSession.run(iso(t), row.id);
        touchDevice.run(iso(t), ip ?? null, row.device_id);
      })();
      seen = t;
    }
    return {
      auth: {
        user: { id: row.user_id, actor: row.actor, username: row.username, displayName: row.display_name },
        device: { id: row.device_id, name: row.device_name },
        session: {
          id: row.id,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          idleExpiresAt: iso(Math.min(seen + cfg.sessionIdleMs, Date.parse(row.expires_at))),
          secondFactor: row.second_factor,
        },
      },
    };
  }

  function deviceProblem(deviceId) {
    if (!isId(deviceId)) return null;
    return getDevice.get(deviceId)?.signed_out_at ? 'device_signed_out' : null;
  }

  // ---- cookies ------------------------------------------------------------------
  const cookieOptions = (req) => ({ httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
  function setSessionCookie(req, res, token) {
    res.cookie(COOKIE_NAME, token, { ...cookieOptions(req), maxAge: cfg.sessionMaxMs });
  }
  function clearSessionCookie(req, res) {
    res.clearCookie(COOKIE_NAME, cookieOptions(req));
  }

  // ---- the request guard ----------------------------------------------------------
  /**
   * Cross-site request protection for every state-changing API request (signed in or not):
   *  1. the session cookie is SameSite=Strict, so other sites' requests don't carry it;
   *  2. Origin must be this server's own origin (scheme://host as the browser saw it, via
   *     X-Forwarded-Proto/Host from the trusted proxy) or one listed in ALLOWED_ORIGINS, and
   *     Sec-Fetch-Site, when sent, must be same-origin;
   *  3. a body must be JSON, which a cross-site form can't send without a CORS preflight
   *     (and the server answers no preflights).
   */
  function originProblem(req) {
    if (SAFE_METHODS.has(req.method)) return null;
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin') return 'Cross-site requests are not allowed';
    const origin = req.get('origin')?.toLowerCase();
    if (!origin) return 'Missing Origin header';
    const own = `${req.protocol}://${req.host}`.toLowerCase();
    if (origin !== own && !allowedOrigins.has(origin)) return 'Request from another origin';
    return null;
  }

  function guard(req, res, next) {
    const problem = originProblem(req);
    if (problem) return next(fail(403, 'bad_origin', problem));
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if (!SAFE_METHODS.has(req.method) && hasBody && !req.is('application/json')) {
      return next(fail(415, 'json_only', 'Send JSON (Content-Type: application/json)'));
    }
    const token = readCookie(req, COOKIE_NAME);
    const result = resolveSession(token, { ip: req.ip });
    if (result.auth) {
      req.auth = result.auth;
    } else {
      req.auth = null;
      // No cookie (e.g. long gone): the device id header still tells a signed-out device so.
      req.authProblem = result.problem === 'not_signed_in'
        ? (deviceProblem(req.get('x-suite-device')) ?? 'not_signed_in')
        : result.problem;
      if (token) clearSessionCookie(req, res);
    }
    next();
  }

  function requireSession(req, _res, next) {
    if (req.auth) return next();
    const code = req.authProblem ?? 'not_signed_in';
    next(fail(401, code, PROBLEMS[code]));
  }

  // ---- sign-in --------------------------------------------------------------------
  /** Step 1: username + password. Same answer for an unknown username and a wrong password. */
  async function beginSignIn({ username, password, deviceId, installed, ip }) {
    prune();
    const name = str(username, 64);
    const pass = str(password, PASSWORD_MAX);
    const keys = throttleKeys(name ?? '', ip);
    const charged = charge(keys);
    const user = name ? accounts.getUserByUsername(name) : null;
    const ok = await verifyPassword(pass ?? '', user?.password_hash ?? await dummyHash);
    if (!ok || !user) throw fail(401, 'bad_credentials', 'Wrong username or password');
    refundAttempt(keys, charged); // the code step still has to pass

    const enrolled = Boolean(accounts.getTotp(user.id));
    if (enrolled) {
      const ch = makeChallenge({ kind: 'sign_in', userId: user.id, deviceHint: deviceId, installed });
      return { next: 'code', challenge: ch.token, expiresAt: ch.expiresAt };
    }
    // First sign-in: set up the authenticator app before the account can be used.
    const secret = newTotpSecret();
    const ch = makeChallenge({ kind: 'enroll', userId: user.id, totpSecret: secret, deviceHint: deviceId, installed });
    return {
      next: 'enroll',
      challenge: ch.token,
      expiresAt: ch.expiresAt,
      enroll: { secret, otpauthUrl: otpauthUrl({ secret, account: user.username, issuer: ISSUER }), issuer: ISSUER, account: user.username },
    };
  }

  /** Step 2: a code from the authenticator app, or a recovery code. */
  function finishSignIn({ challenge, code, ip, userAgent }) {
    const ch = openChallenge(challenge, ['sign_in']);
    const user = accounts.getUser(ch.user_id);
    const keys = throttleKeys(user.username, ip);
    charge(keys);
    countChallengeAttempt.run(ch.id);
    const method = checkCode(user, code);
    if (!method) throw fail(401, 'bad_code', 'That code didn’t work');
    clearAttempts(keys);
    useChallenge.run(iso(), ch.id);
    const started = startSession({ user, deviceHint: ch.device_hint, installed: ch.installed === 1, userAgent, ip, secondFactor: method });
    return { ...started, usedRecoveryCode: method === 'recovery', recoveryCodesLeft: accounts.unusedRecoveryCodes(user.id).length };
  }

  /** First sign-in: the first code from the new secret proves the app is set up. */
  function finishEnrollment({ challenge, code, ip, userAgent }) {
    const ch = openChallenge(challenge, ['enroll']);
    const user = accounts.getUser(ch.user_id);
    const keys = throttleKeys(user.username, ip);
    charge(keys);
    countChallengeAttempt.run(ch.id);
    const step = matchTotp(ch.totp_secret, typeof code === 'string' ? code.replace(/\s/g, '') : '', now());
    if (step === null) throw fail(401, 'bad_code', 'That code didn’t work. Check the time on your phone and try the next one.');
    clearAttempts(keys);
    return db.transaction(() => {
      if (accounts.getTotp(user.id)) throw fail(409, 'already_enrolled', 'Two-factor is already set up. Start again.');
      useChallenge.run(iso(), ch.id);
      accounts.enrollTotp(user.id, ch.totp_secret, step);
      const recoveryCodes = accounts.newRecoveryCodes(user.id);
      const started = startSession({ user, deviceHint: ch.device_hint, installed: ch.installed === 1, userAgent, ip, secondFactor: 'enroll' });
      return { ...started, recoveryCodes };
    })();
  }

  // ---- signed-in actions ------------------------------------------------------------
  function signOutDevice({ deviceId, by }) {
    if (!isId(deviceId)) throw fail(404, 'not_found', 'No such device');
    return db.transaction(() => {
      const d = getDevice.get(deviceId);
      if (!d) throw fail(404, 'not_found', 'No such device');
      const t = iso();
      markDeviceSignedOut.run(t, by.id, deviceId);
      endDeviceSessions.run(t, 'signed_out', deviceId);
      log?.info(`device ${deviceId} (${d.name}) signed out by ${by.username}`);
      return listDevices().find((x) => x.id === deviceId);
    })();
  }

  function listDevices() {
    const t = now();
    return allDevices.all({ now: iso(t), idle_cutoff: iso(t - cfg.sessionIdleMs) }).map((d) => ({
      id: d.id,
      name: d.name,
      user: { id: d.user_id, actor: d.actor, username: d.username, displayName: d.display_name },
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
      lastIp: d.last_ip,
      signedIn: d.signed_in === 1,
      signedOutAt: d.signed_out_at,
      signedOutBy: d.signed_out_by ? { id: d.signed_out_by, displayName: d.signed_out_by_name } : null,
    }));
  }

  function renameDevice({ deviceId, name }) {
    const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (!clean || clean.length > 60) throw fail(400, 'invalid', 'Name: 1–60 characters');
    if (!isId(deviceId) || renameDeviceStmt.run(clean, deviceId).changes === 0) throw fail(404, 'not_found', 'No such device');
    return listDevices().find((x) => x.id === deviceId);
  }

  /** Password (and code) again before changing sign-in details. 403, not 401: the session is fine. */
  async function recheck(user, { password, code, needCode }, ip) {
    const keys = throttleKeys(user.username, ip);
    charge(keys);
    const full = accounts.getUser(user.id);
    const passOk = await verifyPassword(str(password, PASSWORD_MAX) ?? '', full.password_hash);
    const codeOk = needCode ? passOk && Boolean(checkCode(full, code)) : true;
    if (!passOk || !codeOk) {
      throw fail(403, 'bad_credentials', needCode ? 'Wrong password or code' : 'Wrong password');
    }
    clearAttempts(keys);
    return full;
  }

  async function changePassword({ auth, currentPassword, newPassword, ip }) {
    const problem = passwordProblem(newPassword);
    if (problem) throw fail(400, 'weak_password', problem);
    await recheck(auth.user, { password: currentPassword }, ip);
    // Other devices sign in again (their local data stays); this one carries on.
    await accounts.setPassword(auth.user.id, newPassword, { exceptSessionId: auth.session.id });
    return { ok: true };
  }

  async function regenerateRecoveryCodes({ auth, password, code, ip }) {
    await recheck(auth.user, { password, code, needCode: true }, ip);
    return { recoveryCodes: accounts.newRecoveryCodes(auth.user.id) };
  }

  async function beginTotpReset({ auth, password, code, ip }) {
    const user = await recheck(auth.user, { password, code, needCode: true }, ip);
    const secret = newTotpSecret();
    const ch = makeChallenge({ kind: 'totp_reset', userId: user.id, sessionId: auth.session.id, totpSecret: secret });
    return {
      challenge: ch.token,
      expiresAt: ch.expiresAt,
      enroll: { secret, otpauthUrl: otpauthUrl({ secret, account: user.username, issuer: ISSUER }), issuer: ISSUER, account: user.username },
    };
  }

  function finishTotpReset({ auth, challenge, code, ip }) {
    const ch = openChallenge(challenge, ['totp_reset']);
    if (ch.session_id !== auth.session.id) throw fail(401, 'challenge_expired', 'Start again.');
    const keys = throttleKeys(auth.user.username, ip);
    charge(keys);
    countChallengeAttempt.run(ch.id);
    const step = matchTotp(ch.totp_secret, typeof code === 'string' ? code.replace(/\s/g, '') : '', now());
    if (step === null) throw fail(403, 'bad_code', 'That code didn’t work');
    clearAttempts(keys);
    db.transaction(() => {
      useChallenge.run(iso(), ch.id);
      accounts.replaceTotp(auth.user.id, ch.totp_secret, step);
      // The old authenticator may be on a lost phone: other sessions sign in again.
      accounts.endSessions(auth.user.id, 'two_factor_reset', auth.session.id);
    })();
    return { ok: true };
  }

  function accountInfo(auth) {
    const totp = accounts.getTotp(auth.user.id);
    return {
      user: auth.user,
      device: auth.device,
      session: auth.session,
      twoFactor: {
        totp: totp ? { enrolledAt: totp.enrolled_at } : null,
        recoveryCodesLeft: accounts.unusedRecoveryCodes(auth.user.id).length,
      },
    };
  }

  return {
    // middleware (app.js mounts these around every module's routes)
    guard,
    requireSession,
    // routes
    beginSignIn,
    finishSignIn,
    finishEnrollment,
    signOutDevice,
    listDevices,
    renameDevice,
    changePassword,
    regenerateRecoveryCodes,
    beginTotpReset,
    finishTotpReset,
    accountInfo,
    setSessionCookie,
    clearSessionCookie,
    // for other modules and tests
    startSession,
    accounts,
    totpStep: () => totpStep(now()),
  };
}
