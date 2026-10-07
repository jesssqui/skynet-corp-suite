import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newId, isId } from '@suite/shared/ids';
import { createHlc } from '@suite/shared/hlc';
import {
  totpCode, hotp, base32Encode, base32Decode, matchTotp, normalizeRecoveryCode, newRecoveryCode, hashPassword, verifyPassword,
} from '../src/modules/auth/crypto.js';
import { LIMITS } from '../src/modules/auth/service.js';
import { RULES } from '../src/modules/auth/throttle.js';
import { deviceNameFromUserAgent } from '../src/modules/auth/deviceName.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup } from '../src/backup/restore.js';
import { tmpDir, testConfig, startApp, testClock, ensureTestUsers, TEST_PASSWORD, dumpDb } from './helpers.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

async function setup(t, env = {}) {
  const dir = tmpDir(t);
  const clock = testClock();
  const config = testConfig(dir, env);
  const app = await startApp(t, config, { now: clock.now });
  const users = await ensureTestUsers(app.ctx);
  return { ...app, dir, config, clock, users };
}

/** A pretend browser: keeps the session cookie like a browser would, sends Origin like a browser would. */
function browser(base, { userAgent = MAC, headers = {} } = {}) {
  const b = {
    cookie: null,
    deviceId: null,
    async req(method, path, body, extra = {}) {
      const h = { origin: base, 'user-agent': userAgent, ...headers, ...extra };
      if (b.cookie && !('cookie' in extra)) h.cookie = b.cookie;
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const setCookie = res.headers.getSetCookie();
      for (const c of setCookie) {
        const [pair] = c.split(';');
        const [name, value] = pair.split('=');
        if (name === 'suite_session') b.cookie = value ? `suite_session=${value}` : null;
      }
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: res.status, body: data, headers: res.headers, setCookie };
    },
    get: (path, extra) => b.req('GET', path, undefined, extra),
    post: (path, body = {}, extra) => b.req('POST', path, body, extra),
    put: (path, body = {}, extra) => b.req('PUT', path, body, extra),
  };
  return b;
}

/** Full sign-in: password, then a code from the account's authenticator. Moves the clock to a fresh TOTP step. */
async function signIn(env, b, username, { secret, installed = false, password = TEST_PASSWORD } = {}) {
  const totpSecret = secret ?? Object.values(env.users).find((u) => u.username === username).totpSecret;
  env.clock.advance(30_000); // codes work once: each sign-in uses a new time step
  const first = await b.post('/api/auth/login', { username, password, deviceId: b.deviceId, installed });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(Object.keys(first.body).sort(), ['challenge', 'expiresAt', 'next']);
  assert.equal(first.body.next, 'code');
  const done = await b.post('/api/auth/login/code', { challenge: first.body.challenge, code: totpCode(totpSecret, env.clock.now()) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  b.deviceId = done.body.device.id;
  return { secret: totpSecret, result: done.body, setCookie: done.setCookie };
}

// ---------------------------------------------------------------- building blocks

test('TOTP matches RFC 6238 and base32 round-trips', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  // RFC 6238 appendix B (SHA-1), last 6 of the 8 digits.
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.equal(totpCode(secret, 1111111109_000), '081804');
  assert.equal(totpCode(secret, 2000000000_000), '279037');
  assert.equal(hotp(secret, 1), '287082');
  // One step of drift either way is accepted; a used step (or an earlier one) is not.
  const t = 1111111109_000;
  assert.equal(matchTotp(secret, totpCode(secret, t - 30_000), t), Math.floor(t / 30_000) - 1);
  assert.equal(matchTotp(secret, totpCode(secret, t + 30_000), t), Math.floor(t / 30_000) + 1);
  assert.equal(matchTotp(secret, totpCode(secret, t - 90_000), t), null);
  assert.equal(matchTotp(secret, totpCode(secret, t), t, Math.floor(t / 30_000)), null, 'replay');
  assert.equal(matchTotp(secret, '12345', t), null);
});

test('passwords are scrypt hashes; recovery codes are forgiving about how they are typed', async () => {
  const h = await hashPassword('correct horse battery staple', 1024);
  assert.match(h, /^scrypt\$1024\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery staple', h), true);
  assert.equal(await verifyPassword('correct horse battery stapl', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  const code = newRecoveryCode();
  assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ' ')), code.replace(/-/g, ''));
  assert.equal(normalizeRecoveryCode('oooo-iiii-llll'), '000011111111');
  assert.equal(normalizeRecoveryCode('123456'), null);
});

test('device names come from the user agent', () => {
  assert.equal(deviceNameFromUserAgent(IPHONE, { installed: true }), 'iPhone · Home screen app');
  assert.equal(deviceNameFromUserAgent(IPHONE), 'iPhone · Safari');
  assert.equal(deviceNameFromUserAgent(MAC), 'Mac · Safari');
  assert.equal(deviceNameFromUserAgent(undefined), 'Unknown device');
});

// ---------------------------------------------------------------- Done-when

test('password + code on the iPhone and the Mac for both people', async (t) => {
  const env = await setup(t);
  const phone = browser(env.base, { userAgent: IPHONE });

  const first = await phone.post('/api/auth/login', { username: 'Jessy', password: TEST_PASSWORD, installed: true });
  assert.equal(first.status, 200);
  assert.equal(first.body.next, 'code');
  assert.equal(phone.cookie, null, 'no session before the second factor');
  assert.equal((await phone.get('/api/auth/session')).status, 401);
  const wrong = await phone.post('/api/auth/login/code', { challenge: first.body.challenge, code: '000000' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'bad_code');
  env.clock.advance(30_000);
  const done = await phone.post('/api/auth/login/code', { challenge: first.body.challenge, code: totpCode(env.users.owner.totpSecret, env.clock.now()) });
  assert.equal(done.status, 200);
  assert.equal(done.body.user.actor, 'owner');
  assert.equal(done.body.device.name, 'iPhone · Home screen app');
  assert.ok(isId(done.body.device.id));
  assert.ok(phone.cookie);
  const session = await phone.get('/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.user.username, 'jessy');
  assert.equal(session.body.device.id, done.body.device.id);
  // The challenge is used up.
  env.clock.advance(30_000);
  assert.equal((await phone.post('/api/auth/login/code', { challenge: first.body.challenge, code: totpCode(env.users.owner.totpSecret, env.clock.now()) })).status, 401);
  phone.deviceId = done.body.device.id;

  const mac = browser(env.base, { userAgent: MAC });
  const viaMac = await signIn(env, mac, 'jessy');
  assert.equal(viaMac.result.device.name, 'Mac · Safari');
  assert.equal(viaMac.result.usedRecoveryCode, false);
  assert.notEqual(mac.deviceId, done.body.device.id);

  const herPhone = browser(env.base, { userAgent: IPHONE });
  const her = await signIn(env, herPhone, 'sam', { installed: true });
  assert.equal(her.result.user.actor, 'partner');
  const herMac = browser(env.base, { userAgent: MAC });
  await signIn(env, herMac, 'sam');

  for (const b of [phone, mac, herPhone, herMac]) assert.equal((await b.get('/api/auth/session')).status, 200);
  const devices = (await mac.get('/api/auth/devices')).body;
  assert.equal(devices.devices.length, 4);
  assert.equal(devices.currentDeviceId, mac.deviceId);
  assert.deepEqual(devices.devices.map((d) => d.user.actor).sort(), ['owner', 'owner', 'partner', 'partner']);
  assert.ok(devices.devices.every((d) => d.signedIn));

  // Nothing secret is stored as given: tokens and recovery codes are hashed.
  const codes = env.ctx.services.auth.accounts.newRecoveryCodes(env.users.owner.id);
  const dump = JSON.stringify(dumpDb(env.config.dbPath));
  assert.ok(!dump.includes(phone.cookie.split('=')[1]), 'session token not stored');
  assert.ok(!dump.includes(codes[0]) && !dump.includes(codes[0].replace(/-/g, '')));
  assert.ok(!dump.includes(TEST_PASSWORD));
});

test('no two-factor set up on the web: an account without a confirmed authenticator cannot sign in', async (t) => {
  const dir = tmpDir(t);
  const env = await startApp(t, testConfig(dir));
  const accounts = env.ctx.services.auth.accounts;
  await accounts.createUser({ actor: 'owner', username: 'jessy', password: TEST_PASSWORD }); // no TOTP (not what the CLI does)
  const b = browser(env.base);
  const res = await b.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: 'Wrong username or password', code: 'bad_credentials' }, 'same answer as a wrong password');
  assert.equal(b.cookie, null);
  const enrol = await b.post('/api/auth/login/enroll', { challenge: 'x', code: '123456' });
  assert.equal(enrol.status, 401, 'there is no web enrolment route');
  assert.equal(enrol.body.code, 'not_signed_in');
});

test('a recovery code signs in once; a TOTP code works once', async (t) => {
  const env = await setup(t);
  const a = browser(env.base);
  const { secret } = await signIn(env, a, 'jessy');
  const recoveryCodes = env.ctx.services.auth.accounts.newRecoveryCodes(env.users.owner.id);

  const b = browser(env.base);
  let step1 = await b.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD });
  const viaCode = await b.post('/api/auth/login/code', { challenge: step1.body.challenge, code: recoveryCodes[3].toLowerCase() });
  assert.equal(viaCode.status, 200);
  assert.equal(viaCode.body.usedRecoveryCode, true);
  assert.equal(viaCode.body.recoveryCodesLeft, 9);

  const c = browser(env.base);
  step1 = await c.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD });
  const again = await c.post('/api/auth/login/code', { challenge: step1.body.challenge, code: recoveryCodes[3] });
  assert.equal(again.status, 401, 'a recovery code is single use');
  assert.equal(again.body.code, 'bad_code');

  // The same authenticator code twice: the second is refused (replay).
  env.clock.advance(30_000);
  const code = totpCode(secret, env.clock.now());
  step1 = await c.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD });
  assert.equal((await c.post('/api/auth/login/code', { challenge: step1.body.challenge, code })).status, 200);
  const d = browser(env.base);
  step1 = await d.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD });
  assert.equal((await d.post('/api/auth/login/code', { challenge: step1.body.challenge, code })).status, 401);

  // A challenge runs out.
  step1 = await d.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD });
  env.clock.advance(LIMITS.challengeMs.sign_in + 1000);
  const late = await d.post('/api/auth/login/code', { challenge: step1.body.challenge, code: totpCode(secret, env.clock.now()) });
  assert.equal(late.status, 401);
  assert.equal(late.body.code, 'challenge_expired');
});

test('wrong password and unknown username get the same answer', async (t) => {
  const env = await setup(t);
  const b = browser(env.base);
  const wrong = await b.post('/api/auth/login', { username: 'jessy', password: 'not the password at all' });
  const unknown = await b.post('/api/auth/login', { username: 'nobody', password: 'not the password at all' });
  const junk = await b.post('/api/auth/login', { username: { $ne: 1 }, password: ['x'] });
  for (const r of [wrong, unknown, junk]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'Wrong username or password', code: 'bad_credentials' });
  }
  assert.equal(b.cookie, null);
});

test('rate limiting: guessing from one device locks only that device out of the account', async (t) => {
  const env = await setup(t);
  // Different tailnet devices (Tailscale Serve sets X-Forwarded-For; the proxy on loopback is trusted).
  const from = (ip) => browser(env.base, { headers: { 'x-forwarded-for': ip } });
  const attacker = from('100.64.0.66');
  const owner = from('100.64.0.10');
  const guess = (b, username = 'jessy', password = 'wrong password, wrong') => b.post('/api/auth/login', { username, password });

  for (let i = 0; i < RULES.acctIp.threshold; i++) assert.equal((await guess(attacker)).status, 401);
  const locked = await guess(attacker, 'jessy', TEST_PASSWORD);
  assert.equal(locked.status, 429, 'that device is locked even with the right password');
  assert.equal(locked.body.code, 'too_many_attempts');
  assert.equal(locked.headers.get('retry-after'), '60');
  assert.equal((await signIn(env, owner, 'jessy')).result.user.username, 'jessy', 'the owner signs in from their own device');

  // The reviewer's case: one wrong guess every time the lock runs out, for hours, keeps only the guesser out.
  let retry = 60;
  for (let i = 0; i < 8; i++) {
    env.clock.advance(retry * 1000 + 1000);
    assert.equal((await guess(attacker)).status, 401);
    const r = await guess(attacker, 'jessy', TEST_PASSWORD);
    assert.equal(r.status, 429);
    retry = Number(r.headers.get('retry-after'));
    assert.ok(retry <= 3600, 'capped at an hour');
    const ok = await owner.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD });
    assert.equal(ok.status, 200, `the owner is never locked out (round ${i})`);
  }
  assert.equal(retry, 3600);
  await signIn(env, owner, 'jessy');

  // Unknown usernames lock the same way (no enumeration); wrong codes count too.
  const other = from('100.64.0.77');
  for (let i = 0; i < RULES.acctIp.threshold; i++) assert.equal((await guess(other, 'nobody')).status, 401);
  assert.equal((await guess(other, 'nobody')).status, 429);
  const viaCode = from('100.64.0.78');
  const step1 = await viaCode.post('/api/auth/login', { username: 'sam', password: TEST_PASSWORD });
  for (let i = 0; i < RULES.acctIp.threshold - 1; i++) {
    assert.equal((await viaCode.post('/api/auth/login/code', { challenge: step1.body.challenge, code: '000000' })).status, 401);
  }
  const s2 = await viaCode.post('/api/auth/login', { username: 'sam', password: TEST_PASSWORD });
  assert.equal(s2.status, 200, 'a right password doesn\'t count and leaves no lock');
  assert.equal((await viaCode.post('/api/auth/login/code', { challenge: s2.body.challenge, code: '000000' })).status, 401);
  assert.equal((await viaCode.post('/api/auth/login/code', { challenge: s2.body.challenge, code: '000000' })).status, 429);
});

test('rate limiting: many addresses lock the account for 15 minutes; one address spraying usernames is locked', async (t) => {
  const env = await setup(t);
  const from = (ip) => browser(env.base, { headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < RULES.acct.threshold; i++) {
    assert.equal((await from(`100.64.1.${i}`).post('/api/auth/login', { username: 'jessy', password: 'nope nope nope' })).status, 401);
  }
  const owner = from('100.64.0.10');
  const blocked = await owner.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD });
  assert.equal(blocked.status, 429, 'distributed guessing locks the whole account');
  assert.equal(blocked.headers.get('retry-after'), '900');
  assert.equal((await from('100.64.0.11').post('/api/auth/login', { username: 'sam', password: TEST_PASSWORD })).status, 200,
    'the other account is not affected');
  // users.js unlock (accounts.unlock) clears it at once.
  assert.ok(env.ctx.services.auth.accounts.unlock('jessy') > 0);
  assert.equal((await owner.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD })).status, 200);
  // Or it runs out by itself.
  for (let i = 0; i < RULES.acct.threshold; i++) await from(`100.64.2.${i}`).post('/api/auth/login', { username: 'jessy', password: 'nope nope nope' });
  assert.equal((await owner.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD })).status, 429);
  env.clock.advance(15 * MIN + 1000);
  assert.equal((await owner.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD })).status, 200);
  // A new password or a new authenticator (CLI) also unlocks.
  for (let i = 0; i < RULES.acct.threshold; i++) await from(`100.64.3.${i}`).post('/api/auth/login', { username: 'jessy', password: 'nope nope nope' });
  await env.ctx.services.auth.accounts.setPassword(env.users.owner.id, 'another long passphrase');
  assert.equal((await owner.post('/api/auth/login', { username: 'jessy', password: 'another long passphrase' })).status, 200);
  for (let i = 0; i < RULES.acct.threshold; i++) await from(`100.64.4.${i}`).post('/api/auth/login', { username: 'jessy', password: 'nope nope nope' });
  env.ctx.services.auth.accounts.replaceTwoFactor(env.users.owner.id, env.users.owner.totpSecret, 0);
  assert.equal((await owner.post('/api/auth/login', { username: 'jessy', password: 'another long passphrase' })).status, 200);

  // Per address: spraying usernames from one device locks that device.
  const sprayer = from('100.64.9.9');
  for (let i = 0; i < RULES.ip.threshold; i++) {
    assert.equal((await sprayer.post('/api/auth/login', { username: `guess${i}`, password: 'nope nope nope' })).status, 401);
  }
  assert.equal((await sprayer.post('/api/auth/login', { username: 'sam', password: TEST_PASSWORD })).status, 429);
  assert.equal((await from('100.64.0.11').post('/api/auth/login', { username: 'sam', password: TEST_PASSWORD })).status, 200);
});

test('sessions end after the idle limit and after the absolute limit', async (t) => {
  const env = await setup(t, { SESSION_IDLE_DAYS: '7', SESSION_MAX_DAYS: '20' });
  const b = browser(env.base);
  const { secret } = await signIn(env, b, 'jessy');
  env.clock.advance(6 * DAY);
  assert.equal((await b.get('/api/auth/session')).status, 200, 'used within the idle limit');
  env.clock.advance(6 * DAY);
  assert.equal((await b.get('/api/auth/session')).status, 200, 'still within: the last use counts');
  env.clock.advance(7 * DAY + 1000);
  const idle = await b.get('/api/auth/session');
  assert.equal(idle.status, 401);
  assert.equal(idle.body.code, 'session_expired', 'sign in again; keep local data');
  assert.equal(b.cookie, null, 'the cookie is cleared');

  // Absolute: used every few days, it still ends 20 days after sign-in.
  const keepDevice = b.deviceId;
  await signIn(env, b, 'jessy', { secret });
  assert.equal(b.deviceId, keepDevice, 'an expired session keeps its device (and so its unsent changes)');
  for (let d = 0; d < 18; d += 6) {
    env.clock.advance(6 * DAY);
    assert.equal((await b.get('/api/auth/session')).status, 200);
  }
  env.clock.advance(3 * DAY);
  const absolute = await b.get('/api/auth/session');
  assert.equal(absolute.status, 401);
  assert.equal(absolute.body.code, 'session_expired');
});

test('CSRF: state-changing requests need this origin and a JSON body', async (t) => {
  const env = await setup(t, { ALLOWED_ORIGINS: 'https://suite.example.ts.net:8443' });
  const b = browser(env.base);
  await signIn(env, b, 'jessy');
  const rename = (extra, body = JSON.stringify({ name: 'x' }), type = 'application/json') => fetch(`${env.base}/api/auth/devices/${b.deviceId}`, {
    method: 'PUT', headers: { cookie: b.cookie, 'content-type': type, ...extra }, body,
  });

  const missing = await rename({});
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).code, 'bad_origin');
  assert.equal((await rename({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await rename({ origin: env.base, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await rename({ origin: env.base, 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await rename({ origin: env.base }, 'name=x', 'application/x-www-form-urlencoded')).status, 415);
  assert.equal((await rename({ origin: env.base }, '{"name":"x"}', 'text/plain')).status, 415);
  assert.equal((await rename({ origin: env.base, 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await rename({ origin: 'https://suite.example.ts.net:8443' })).status, 200, 'ALLOWED_ORIGINS');
  // Sign-in itself is protected too (no logging someone in from another site).
  const crossLogin = await fetch(`${env.base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ username: 'jessy', password: TEST_PASSWORD }),
  });
  assert.equal(crossLogin.status, 403);
  // Reads don't need an Origin.
  assert.equal((await fetch(`${env.base}/api/auth/session`, { headers: { cookie: b.cookie } })).status, 200);
});

test('signing out another device: its session ends, its next request and sync are refused with device_signed_out', async (t) => {
  const env = await setup(t);
  const phone = browser(env.base, { userAgent: IPHONE });
  const { secret } = await signIn(env, phone, 'jessy', { installed: true });
  const mac = browser(env.base, { userAgent: MAC });
  await signIn(env, mac, 'sam');

  // The phone syncs (as its session's device and person).
  const clock = createHlc(phone.deviceId);
  const step = () => ({ key: newId(), entity: 'item', recordId: newId(), op: 'create', fields: { title: 'x' }, hlc: clock.now() });
  const pushed = await phone.post('/api/sync/push', { steps: [] });
  assert.equal(pushed.status, 200);
  assert.equal((await phone.get('/api/sync/pull')).status, 200);
  const phoneCookie = phone.cookie;

  // The partner renames it, then signs it out from the Mac.
  assert.equal((await mac.put(`/api/auth/devices/${phone.deviceId}`, { name: 'Jessy’s old iPhone' })).status, 200);
  const out = await mac.post(`/api/auth/devices/${phone.deviceId}/sign-out`);
  assert.equal(out.status, 200);
  assert.equal(out.body.current, false);
  assert.equal(out.body.device.signedIn, false);
  assert.ok(out.body.device.signedOutAt);
  assert.equal(out.body.device.signedOutBy.displayName, 'Sam');
  assert.equal((await mac.get('/api/auth/session')).status, 200, 'the Mac is unaffected');

  // Every request from the phone now says: signed out, clear your local copy.
  const next = await phone.get('/api/auth/session');
  assert.equal(next.status, 401);
  assert.equal(next.body.code, 'device_signed_out');
  assert.equal(phone.cookie, null, 'the answer also clears the cookie');
  const sync = await phone.req('POST', '/api/sync/push', { steps: [step()] }, { cookie: phoneCookie });
  assert.equal(sync.status, 401, 'sync from the signed-out device is refused');
  assert.equal(sync.body.code, 'device_signed_out');
  const pull = await phone.req('GET', '/api/sync/pull', undefined, { cookie: phoneCookie });
  assert.equal(pull.body.code, 'device_signed_out');
  // Even with the cookie gone, the device id header gets the same answer.
  const byHeader = await fetch(`${env.base}/api/sync/pull`, { headers: { 'x-suite-device': phone.deviceId } });
  assert.equal(byHeader.status, 401);
  assert.equal((await byHeader.json()).code, 'device_signed_out');

  // Signing in again on that phone makes a new device (the old one stays signed out in the list).
  const oldId = phone.deviceId;
  const again = await signIn(env, phone, 'jessy', { secret, installed: true });
  assert.equal(again.result.deviceReplaced, true);
  assert.notEqual(phone.deviceId, oldId);
  const list = (await mac.get('/api/auth/devices')).body.devices;
  assert.equal(list.find((d) => d.id === oldId).signedOutAt !== null, true);
  assert.equal(list.find((d) => d.id === phone.deviceId).signedIn, true);
});

test('the sign-out answer reaches a device whose cookie was replayed after sign-out; own sign-out clears the cookie', async (t) => {
  const env = await setup(t);
  const b = browser(env.base);
  await signIn(env, b, 'jessy');
  const cookie = b.cookie;
  const out = await b.post('/api/auth/logout');
  assert.equal(out.status, 200);
  assert.equal(b.cookie, null);
  assert.match(out.setCookie[0], /suite_session=;/);
  const replay = await fetch(`${env.base}/api/sync/pull`, { headers: { cookie } });
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).code, 'device_signed_out');
  assert.equal((await b.post(`/api/auth/devices/${newId()}/sign-out`)).status, 401);
});

test('an expired session signs in again on the same device; a device id the server never saw is kept', async (t) => {
  const env = await setup(t, { SESSION_IDLE_DAYS: '1' });
  const b = browser(env.base);
  const { secret } = await signIn(env, b, 'jessy');
  const first = b.deviceId;
  env.clock.advance(2 * DAY);
  assert.equal((await b.get('/api/auth/session')).body.code, 'session_expired');
  const again = await signIn(env, b, 'jessy', { secret });
  assert.equal(b.deviceId, first);
  assert.equal(again.result.deviceReplaced, false);

  // A device id the other person uses is not taken over.
  const hers = browser(env.base);
  await signIn(env, hers, 'sam');
  const thief = browser(env.base);
  thief.deviceId = hers.deviceId;
  const taken = await signIn(env, thief, 'jessy', { secret });
  assert.notEqual(thief.deviceId, hers.deviceId);
  assert.equal(taken.result.deviceReplaced, true);

  // Unknown here (e.g. made after the backup this database was restored from): kept.
  const restored = browser(env.base);
  restored.deviceId = newId();
  const keep = restored.deviceId;
  await signIn(env, restored, 'jessy', { secret });
  assert.equal(restored.deviceId, keep);
  // Not a UUIDv7: ignored.
  const odd = browser(env.base);
  odd.deviceId = 'phone-1';
  await signIn(env, odd, 'jessy', { secret });
  assert.ok(isId(odd.deviceId));
});

test('cookie flags: HttpOnly, SameSite=Strict, Secure behind the HTTPS proxy on loopback', async (t) => {
  const env = await setup(t);
  // What Tailscale Serve sends when it proxies https://mac-mini.tail1234.ts.net:8443 to 127.0.0.1.
  const serve = {
    origin: 'https://mac-mini.tail1234.ts.net:8443',
    'x-forwarded-proto': 'https', 'x-forwarded-host': 'mac-mini.tail1234.ts.net:8443', 'x-forwarded-for': '100.101.102.103',
  };
  const viaServe = browser(env.base, { headers: serve });
  const { secret, setCookie } = await signIn(env, viaServe, 'jessy');
  const cookie = setCookie.find((c) => c.startsWith('suite_session='));
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; Max-Age=7776000/, '90 days');
  const devices = await viaServe.get('/api/auth/devices');
  assert.equal(devices.body.devices[0].lastIp, '100.101.102.103', 'req.ip is the device, not the proxy');

  // Plain http on localhost (development): no Secure flag, or the browser would drop the cookie.
  const local = browser(env.base);
  const plain = await signIn(env, local, 'jessy', { secret });
  const plainCookie = plain.setCookie.find((c) => c.startsWith('suite_session='));
  assert.match(plainCookie, /HttpOnly/);
  assert.doesNotMatch(plainCookie, /Secure/);
});

test('forwarded headers are ignored unless the proxy is trusted', async (t) => {
  const env = await setup(t, { TRUST_PROXY: 'off' });
  const res = await fetch(`${env.base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', origin: 'https://mac-mini.tail1234.ts.net:8443',
      'x-forwarded-proto': 'https', 'x-forwarded-host': 'mac-mini.tail1234.ts.net:8443',
    },
    body: JSON.stringify({ username: 'jessy', password: TEST_PASSWORD }),
  });
  assert.equal(res.status, 403, 'not this server\'s own origin when the forwarded host is not believed');
});

test('account: change password, new recovery codes, reset two-factor', async (t) => {
  const env = await setup(t);
  const mac = browser(env.base);
  const { secret } = await signIn(env, mac, 'jessy');
  const phone = browser(env.base, { userAgent: IPHONE });
  await signIn(env, phone, 'jessy', { secret });

  const info = await mac.get('/api/auth/account');
  assert.equal(info.body.twoFactor.recoveryCodesLeft, 10);
  assert.ok(info.body.twoFactor.totp.enrolledAt);

  // Change password: wrong current password is refused (403: still signed in), short ones too.
  const bad = await mac.post('/api/auth/account/password', { currentPassword: 'nope nope nope', newPassword: 'a brand new passphrase' });
  assert.equal(bad.status, 403);
  assert.equal(bad.body.code, 'bad_credentials');
  assert.equal((await mac.post('/api/auth/account/password', { currentPassword: TEST_PASSWORD, newPassword: 'short' })).status, 400);
  const changed = await mac.post('/api/auth/account/password', { currentPassword: TEST_PASSWORD, newPassword: 'a brand new passphrase' });
  assert.equal(changed.status, 200);
  assert.equal((await mac.get('/api/auth/session')).status, 200, 'this device carries on');
  const kicked = await phone.get('/api/auth/session');
  assert.equal(kicked.body.code, 'session_expired', 'other devices sign in again (keeping their data)');
  assert.equal((await browser(env.base).post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD })).status, 401);
  assert.equal((await browser(env.base).post('/api/auth/login', { username: 'jessy', password: 'a brand new passphrase' })).status, 200);

  // New recovery codes need the password and a code; the old ones stop working.
  env.clock.advance(30_000);
  const noCode = await mac.post('/api/auth/account/recovery-codes', { password: 'a brand new passphrase', code: '000000' });
  assert.equal(noCode.status, 403);
  const codes = await mac.post('/api/auth/account/recovery-codes', { password: 'a brand new passphrase', code: totpCode(secret, env.clock.now()) });
  assert.equal(codes.status, 200);
  assert.equal(codes.body.recoveryCodes.length, 10);
  assert.equal((await mac.get('/api/auth/account')).body.twoFactor.recoveryCodesLeft, 10);

  // Reset two-factor (phone lost): password + a recovery code, then confirm the new app.
  const reset = await mac.post('/api/auth/account/two-factor/reset', { password: 'a brand new passphrase', code: codes.body.recoveryCodes[0] });
  assert.equal(reset.status, 200);
  const newSecret = reset.body.enroll.secret;
  assert.notEqual(newSecret, secret);
  assert.equal((await mac.post('/api/auth/account/two-factor/confirm', { challenge: reset.body.challenge, code: '000000' })).status, 403);
  const confirmed = await mac.post('/api/auth/account/two-factor/confirm', { challenge: reset.body.challenge, code: totpCode(newSecret, env.clock.now()) });
  assert.equal(confirmed.status, 200);
  // The old authenticator no longer signs in; the new one does.
  env.clock.advance(30_000);
  const other = browser(env.base);
  let s1 = await other.post('/api/auth/login', { username: 'jessy', password: 'a brand new passphrase' });
  assert.equal((await other.post('/api/auth/login/code', { challenge: s1.body.challenge, code: totpCode(secret, env.clock.now()) })).status, 401);
  s1 = await other.post('/api/auth/login', { username: 'jessy', password: 'a brand new passphrase' });
  assert.equal((await other.post('/api/auth/login/code', { challenge: s1.body.challenge, code: totpCode(newSecret, env.clock.now()) })).status, 200);
});

test('accounts are made by the CLI only: no sign-up route, one account per person', async (t) => {
  const env = await setup(t);
  const b = browser(env.base);
  for (const path of ['/api/auth/signup', '/api/auth/users', '/api/auth/register', '/api/auth/login/enroll']) {
    assert.equal((await b.post(path, { username: 'x', password: 'y' })).status, 401);
  }
  const accounts = env.ctx.services.auth.accounts;
  await assert.rejects(accounts.createUser({ actor: 'owner', username: 'other', password: TEST_PASSWORD }), /already an account/);
  await assert.rejects(accounts.createUser({ actor: 'stranger', username: 'other', password: TEST_PASSWORD }), /actor/);
  await assert.rejects(accounts.createUser({ actor: 'partner', username: 'x', password: TEST_PASSWORD }), /already|username/);
});

// ---------------------------------------------------------------- restore

test('after a restore every session is ended (session_expired, keep data), even a lost phone signed out after the backup', async (t) => {
  const env = await setup(t);
  const phone = browser(env.base, { userAgent: IPHONE });
  await signIn(env, phone, 'jessy', { installed: true });
  const mac = browser(env.base);
  await signIn(env, mac, 'sam');
  const phoneCookie = phone.cookie;
  const macCookie = mac.cookie;

  const backup = await runBackup({ db: env.db, dir: env.config.backup.dir, offsiteDir: null, keepDays: 30 });
  // After the backup, the phone is lost and signed out from the Mac.
  assert.equal((await mac.post(`/api/auth/devices/${phone.deviceId}/sign-out`)).status, 200);
  await env.close();

  // A plain restart keeps sessions.
  const restarted = await startApp(t, env.config, { now: env.clock.now });
  const again = await fetch(`${restarted.base}/api/auth/session`, { headers: { cookie: macCookie } });
  assert.equal(again.status, 200, 'a restart without a restore keeps everyone signed in');
  await restarted.close();

  await restoreBackup({ from: backup.file, dbPath: env.config.dbPath, backupDir: env.config.backup.dir });
  const after = await startApp(t, env.config, { now: env.clock.now });
  for (const cookie of [phoneCookie, macCookie]) {
    const r = await fetch(`${after.base}/api/auth/session`, { headers: { cookie } });
    assert.equal(r.status, 401, 'the restored copy\'s sessions no longer work');
    assert.equal((await r.json()).code, 'session_expired', 'sign in again, keep local data');
  }
  const ended = after.db.prepare("SELECT count(*) AS n FROM auth_sessions WHERE ended_at IS NULL").get().n;
  assert.equal(ended, 0);
  // The Mac signs in again on the same device; the phone (still lost) can't without the password and a code.
  const mac2 = browser(after.base);
  mac2.deviceId = mac.deviceId;
  await signIn({ ...env, base: after.base }, mac2, 'sam');
  assert.equal(mac2.deviceId, mac.deviceId);
  // Starting again later does not end the new session.
  await after.close();
  const later = await startApp(t, env.config, { now: env.clock.now });
  assert.equal((await fetch(`${later.base}/api/auth/session`, { headers: { cookie: mac2.cookie } })).status, 200);
});

// ---------------------------------------------------------------- the users CLI

const CLI = fileURLToPath(new URL('../scripts/users.js', import.meta.url));

/**
 * Run users.js against the test database. `answers(stdoutSoFar)` returns { lines, end? } to type next
 * (or null); it is called whenever more output arrives. No `answers` = stdin closed at once.
 * Returns { code, out, err }.
 */
function runCli(dir, args, answers) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, DATA_DIR: path.join(dir, 'data'), AUTH_SCRYPT_N: '1024', BACKUP_OFFSITE_DIR: path.join(dir, 'offsite') },
    });
    let out = '';
    let err = '';
    const feed = () => {
      if (!answers) return child.stdin.end();
      const r = answers(out);
      if (!r) return undefined;
      child.stdin.write(r.lines.map((l) => `${l}\n`).join(''));
      if (r.end) child.stdin.end();
      return undefined;
    };
    child.stdout.on('data', (d) => { out += d; feed(); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
    feed();
  });
}

/**
 * Answers for add / reset-2fa / password: the password first (if any), then — unless `noCode` — a code
 * for the secret the command shows. Stdin is closed after the last answer.
 */
function setupAnswers({ password, code = (secret) => totpCode(secret, Date.now()), noCode = false }) {
  let sentPassword = !password;
  let sentCode = false;
  return (out) => {
    if (!sentPassword) {
      sentPassword = true;
      return { lines: [password], end: noCode };
    }
    const m = /secret=([A-Z2-7]+)/.exec(out);
    if (m && !sentCode && !noCode) {
      sentCode = true;
      return { lines: [].concat(code(m[1])), end: true };
    }
    return null;
  };
}

const secretIn = (out) => /secret=([A-Z2-7]+)/.exec(out)[1];
const codesIn = (out) => out.match(/^ {2}[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/gm).map((c) => c.trim());

test('users.js add sets up two-factor before saving; reset-2fa, password and unlock', async (t) => {
  const dir = tmpDir(t);

  // A wrong code five times: nothing is saved.
  const failed = await runCli(dir, ['add', '--actor', 'owner', '--username', 'Jessy', '--name', 'Jessy'],
    setupAnswers({ password: TEST_PASSWORD, code: () => Array(5).fill('000000') }));
  assert.equal(failed.code, 1);
  assert.match(failed.err, /Nothing was saved/);
  assert.match((await runCli(dir, ['list'])).out, /No accounts yet/);

  // The real thing: QR + key + link, one code, then 10 recovery codes.
  const added = await runCli(dir, ['add', '--actor', 'owner', '--username', 'Jessy', '--name', 'Jessy'], setupAnswers({ password: TEST_PASSWORD }));
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /\x1b\[30;47m[ █▀▄]+\x1b\[0m/, 'a QR code drawn in the terminal');
  assert.match(added.out, /otpauth:\/\/totp\/Skynet%20Corp%20Suite%3Ajessy\?secret=/);
  assert.match(added.out, /Created jessy \(Jessy, owner\) with two-factor on/);
  const secret = secretIn(added.out);
  const recovery = codesIn(added.out);
  assert.equal(recovery.length, 10);
  assert.match((await runCli(dir, ['list'])).out, /owner\s+jessy\s+Jessy\s+2FA: on since .*10 recovery codes left/);
  // A duplicate is refused before anything is asked.
  assert.match((await runCli(dir, ['add', '--actor', 'owner', '--username', 'other'])).err, /already an account/);

  // The server signs in with that authenticator (and its recovery codes).
  const clock = testClock();
  const app = await startApp(t, testConfig(dir), { now: clock.now });
  const env = { ...app, clock, users: { owner: { username: 'jessy', totpSecret: secret } } };
  const mac = browser(app.base, { headers: { 'x-forwarded-for': '100.64.0.10' } });
  await signIn(env, mac, 'jessy');
  const viaRecovery = browser(app.base);
  const s1 = await viaRecovery.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD });
  assert.equal((await viaRecovery.post('/api/auth/login/code', { challenge: s1.body.challenge, code: recovery[0] })).status, 200);

  // Locked by guesses from many addresses -> users.js unlock.
  for (let i = 0; i < RULES.acct.threshold; i++) {
    await browser(app.base, { headers: { 'x-forwarded-for': `100.64.1.${i}` } }).post('/api/auth/login', { username: 'jessy', password: 'nope nope nope' });
  }
  assert.equal((await mac.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD })).status, 429);
  const unlocked = await runCli(dir, ['unlock', 'jessy']);
  assert.match(unlocked.out, /Unlocked jessy/);
  assert.equal((await mac.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD })).status, 200);

  // reset-2fa: a new authenticator, confirmed; the old one stops working, everyone signs in again, unlocked.
  for (let i = 0; i < RULES.acct.threshold; i++) {
    await browser(app.base, { headers: { 'x-forwarded-for': `100.64.2.${i}` } }).post('/api/auth/login', { username: 'jessy', password: 'nope nope nope' });
  }
  const reset = await runCli(dir, ['reset-2fa', 'jessy'], setupAnswers({}));
  assert.equal(reset.code, 0, reset.err);
  const newSecret = secretIn(reset.out);
  assert.notEqual(newSecret, secret);
  assert.equal(codesIn(reset.out).length, 10);
  assert.equal((await mac.get('/api/auth/session')).body.code, 'session_expired');
  clock.advance(30_000);
  const old = browser(app.base);
  let step = await old.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD });
  assert.equal(step.status, 200, 'unlocked');
  assert.equal((await old.post('/api/auth/login/code', { challenge: step.body.challenge, code: totpCode(secret, clock.now()) })).status, 401);
  step = await old.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD });
  assert.equal((await old.post('/api/auth/login/code', { challenge: step.body.challenge, code: totpCode(newSecret, clock.now()) })).status, 200);
  // A reset abandoned halfway changes nothing.
  const abandoned = await runCli(dir, ['reset-2fa', 'jessy']); // input ends before a code
  assert.equal(abandoned.code, 1);
  assert.match((await runCli(dir, ['list'])).out, /10 recovery codes left/);

  // password: new password, unlocked.
  for (let i = 0; i < RULES.acct.threshold; i++) {
    await browser(app.base, { headers: { 'x-forwarded-for': `100.64.3.${i}` } }).post('/api/auth/login', { username: 'jessy', password: 'nope nope nope' });
  }
  const pw = await runCli(dir, ['password', 'jessy'], setupAnswers({ password: 'a different passphrase', noCode: true }));
  assert.equal(pw.code, 0, pw.err);
  assert.match(pw.out, /unlocked/);
  assert.equal((await old.post('/api/auth/login', { username: 'jessy', password: 'a different passphrase' })).status, 200);
});
