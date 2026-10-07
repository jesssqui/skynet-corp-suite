import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId, isId } from '@suite/shared/ids';
import { createHlc } from '@suite/shared/hlc';
import {
  totpCode, hotp, base32Encode, base32Decode, matchTotp, normalizeRecoveryCode, newRecoveryCode, hashPassword, verifyPassword,
} from '../src/modules/auth/crypto.js';
import { LIMITS } from '../src/modules/auth/service.js';
import { deviceNameFromUserAgent } from '../src/modules/auth/deviceName.js';
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

/** Full sign-in. First time: enrols (returns the secret and recovery codes). Moves the clock to a fresh TOTP step. */
async function signIn(env, b, username, { secret, installed = false } = {}) {
  env.clock.advance(30_000); // codes work once: each sign-in uses a new time step
  const first = await b.post('/api/auth/login', { username, password: TEST_PASSWORD, deviceId: b.deviceId, installed });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  if (first.body.next === 'enroll') {
    const s = first.body.enroll.secret;
    const done = await b.post('/api/auth/login/enroll', { challenge: first.body.challenge, code: totpCode(s, env.clock.now()) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    b.deviceId = done.body.device.id;
    return { secret: s, recoveryCodes: done.body.recoveryCodes, result: done.body, setCookie: done.setCookie };
  }
  assert.equal(first.body.next, 'code');
  const done = await b.post('/api/auth/login/code', { challenge: first.body.challenge, code: totpCode(secret, env.clock.now()) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  b.deviceId = done.body.device.id;
  return { secret, result: done.body, setCookie: done.setCookie };
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

test('enrolment on first sign-in, then password + code on the iPhone and the Mac for both people', async (t) => {
  const env = await setup(t);
  const phone = browser(env.base, { userAgent: IPHONE });

  // First sign-in: password, then set up the authenticator.
  const first = await phone.post('/api/auth/login', { username: 'Jessy', password: TEST_PASSWORD, installed: true });
  assert.equal(first.status, 200);
  assert.equal(first.body.next, 'enroll');
  const { secret, otpauthUrl } = first.body.enroll;
  assert.match(otpauthUrl, /^otpauth:\/\/totp\/Skynet%20Corp%20Suite%3Ajessy\?/);
  assert.match(otpauthUrl, new RegExp(`secret=${secret}`));
  assert.match(otpauthUrl, /issuer=Skynet%20Corp%20Suite/);
  assert.equal(phone.cookie, null, 'no session before the second factor');
  assert.equal((await phone.get('/api/auth/session')).status, 401);

  const wrong = await phone.post('/api/auth/login/enroll', { challenge: first.body.challenge, code: '000000' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'bad_code');
  const done = await phone.post('/api/auth/login/enroll', { challenge: first.body.challenge, code: totpCode(secret, env.clock.now()) });
  assert.equal(done.status, 200);
  assert.equal(done.body.recoveryCodes.length, 10);
  assert.equal(new Set(done.body.recoveryCodes).size, 10);
  assert.equal(done.body.user.actor, 'owner');
  assert.equal(done.body.device.name, 'iPhone · Home screen app');
  assert.ok(isId(done.body.device.id));
  assert.ok(phone.cookie);
  const session = await phone.get('/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.user.username, 'jessy');
  assert.equal(session.body.device.id, done.body.device.id);
  // The challenge is used up.
  assert.equal((await phone.post('/api/auth/login/enroll', { challenge: first.body.challenge, code: totpCode(secret, env.clock.now()) })).status, 401);

  // The Mac: password, then a code (enrolled now).
  const mac = browser(env.base, { userAgent: MAC });
  const viaMac = await signIn(env, mac, 'jessy', { secret });
  assert.equal(viaMac.result.device.name, 'Mac · Safari');
  assert.equal(viaMac.result.usedRecoveryCode, false);
  assert.notEqual(mac.deviceId, done.body.device.id);

  // The partner, on her iPhone and the Mac (same browser kind, separate device).
  const herPhone = browser(env.base, { userAgent: IPHONE });
  const her = await signIn(env, herPhone, 'sam', { installed: true });
  assert.equal(her.result.user.actor, 'partner');
  const herMac = browser(env.base, { userAgent: MAC });
  await signIn(env, herMac, 'sam', { secret: her.secret });

  for (const b of [phone, mac, herPhone, herMac]) assert.equal((await b.get('/api/auth/session')).status, 200);
  const devices = (await mac.get('/api/auth/devices')).body;
  assert.equal(devices.devices.length, 4);
  assert.equal(devices.currentDeviceId, mac.deviceId);
  assert.deepEqual(devices.devices.map((d) => d.user.actor).sort(), ['owner', 'owner', 'partner', 'partner']);
  assert.ok(devices.devices.every((d) => d.signedIn));

  // Nothing secret is stored as given: tokens and recovery codes are hashed.
  const dump = JSON.stringify(dumpDb(env.config.dbPath));
  assert.ok(!dump.includes(phone.cookie.split('=')[1]), 'session token not stored');
  assert.ok(!dump.includes(done.body.recoveryCodes[0]) && !dump.includes(done.body.recoveryCodes[0].replace(/-/g, '')));
  assert.ok(!dump.includes(TEST_PASSWORD));
});

test('a recovery code signs in once; a TOTP code works once', async (t) => {
  const env = await setup(t);
  const a = browser(env.base);
  const { secret, recoveryCodes } = await signIn(env, a, 'jessy');

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

test('rate limiting: per account and per IP, with lockouts that grow', async (t) => {
  const env = await setup(t);
  const { threshold } = LIMITS.account;
  const b = browser(env.base);
  const login = (username, password = 'wrong password, wrong') => b.post('/api/auth/login', { username, password });

  for (let i = 0; i < threshold; i++) assert.equal((await login('jessy')).status, 401);
  const locked = await login('jessy', TEST_PASSWORD);
  assert.equal(locked.status, 429, 'locked even with the right password');
  assert.equal(locked.body.code, 'too_many_attempts');
  assert.equal(locked.headers.get('retry-after'), '60');
  // The other account is not affected; an unknown username locks the same way (no enumeration).
  assert.equal((await login('sam', TEST_PASSWORD)).status, 200);
  for (let i = 0; i < threshold; i++) assert.equal((await login('nobody')).status, 401);
  assert.equal((await login('nobody')).status, 429);

  // After the lock: one more failure locks again, for twice as long.
  env.clock.advance(MIN + 1000);
  assert.equal((await login('jessy')).status, 401);
  const longer = await login('jessy', TEST_PASSWORD);
  assert.equal(longer.status, 429);
  assert.equal(longer.headers.get('retry-after'), '120');
  env.clock.advance(2 * MIN + 1000);
  // Right password now: allowed, and it neither counts as a failure nor leaves a lock behind.
  const ok = await login('jessy', TEST_PASSWORD);
  assert.equal(ok.status, 200);
  // Wrong codes count too: the account is past the threshold, so one more failure locks it (4 min now).
  assert.equal(ok.body.next, 'enroll');
  const wrongCode = await b.post('/api/auth/login/enroll', { challenge: ok.body.challenge, code: '000000' });
  assert.equal(wrongCode.status, 401);
  assert.equal(wrongCode.body.code, 'bad_code');
  const lockedCode = await b.post('/api/auth/login/enroll', { challenge: ok.body.challenge, code: '000000' });
  assert.equal(lockedCode.status, 429);
  assert.equal(lockedCode.headers.get('retry-after'), '240');

  // Per IP: many failures across usernames lock this address out for everyone.
  const env2 = await setup(t);
  const c = browser(env2.base);
  for (let i = 0; i < LIMITS.ip.threshold; i++) {
    assert.equal((await c.post('/api/auth/login', { username: `guess${i}`, password: 'nope nope nope' })).status, 401);
  }
  assert.equal((await c.post('/api/auth/login', { username: 'jessy', password: TEST_PASSWORD })).status, 429);
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
  for (const path of ['/api/auth/signup', '/api/auth/users', '/api/auth/register']) {
    assert.equal((await b.post(path, { username: 'x', password: 'y' })).status, 401);
  }
  const accounts = env.ctx.services.auth.accounts;
  await assert.rejects(accounts.createUser({ actor: 'owner', username: 'other', password: TEST_PASSWORD }), /already an account/);
  await assert.rejects(accounts.createUser({ actor: 'stranger', username: 'other', password: TEST_PASSWORD }), /actor/);
  await assert.rejects(accounts.createUser({ actor: 'partner', username: 'x', password: TEST_PASSWORD }), /already|username/);
});
