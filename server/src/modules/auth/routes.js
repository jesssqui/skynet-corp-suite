import { Router } from 'express';

const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

function sendSignedIn(req, res, service, result) {
  const { token, ...rest } = result;
  service.setSessionCookie(req, res, token);
  res.json(rest);
}

/** Reachable without a session: the two (or three, first time) sign-in steps. */
export function createAuthPublicRouter(_ctx, service) {
  const router = Router();

  // POST /api/auth/login {username, password, deviceId?, installed?}
  //   -> {next: 'code', challenge} | {next: 'enroll', challenge, enroll: {secret, otpauthUrl}}
  router.post('/login', async (req, res) => {
    const b = body(req);
    res.json(await service.beginSignIn({
      username: b.username, password: b.password, deviceId: b.deviceId, installed: b.installed === true, ip: req.ip,
    }));
  });

  // POST /api/auth/login/code {challenge, code} -> session cookie + {user, device, session, deviceReplaced, ...}
  router.post('/login/code', (req, res) => {
    const b = body(req);
    sendSignedIn(req, res, service, service.finishSignIn({
      challenge: b.challenge, code: b.code, ip: req.ip, userAgent: req.get('user-agent'),
    }));
  });

  // POST /api/auth/login/enroll {challenge, code} -> session cookie + {..., recoveryCodes} (shown once)
  router.post('/login/enroll', (req, res) => {
    const b = body(req);
    sendSignedIn(req, res, service, service.finishEnrollment({
      challenge: b.challenge, code: b.code, ip: req.ip, userAgent: req.get('user-agent'),
    }));
  });

  return router;
}

/** Signed in only (app.js puts requireSession in front). */
export function createAuthRouter(_ctx, service) {
  const router = Router();

  // GET /api/auth/session -> who is signed in, on which device
  router.get('/session', (req, res) => {
    res.json({ user: req.auth.user, device: req.auth.device, session: req.auth.session });
  });

  // POST /api/auth/logout — signs this device out (the browser clears its own local copy).
  router.post('/logout', (req, res) => {
    service.signOutDevice({ deviceId: req.auth.device.id, by: req.auth.user });
    service.clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  // GET /api/auth/devices -> both people's devices
  router.get('/devices', (req, res) => {
    res.json({ currentDeviceId: req.auth.device.id, devices: service.listDevices() });
  });

  // PUT /api/auth/devices/:id {name}
  router.put('/devices/:id', (req, res) => {
    res.json({ device: service.renameDevice({ deviceId: req.params.id, name: body(req).name }) });
  });

  // POST /api/auth/devices/:id/sign-out — either person, any device. Its next request is told to clear its data.
  router.post('/devices/:id/sign-out', (req, res) => {
    const device = service.signOutDevice({ deviceId: req.params.id, by: req.auth.user });
    if (device.id === req.auth.device.id) service.clearSessionCookie(req, res);
    res.json({ device, current: device.id === req.auth.device.id });
  });

  // GET /api/auth/account -> user, two-factor state, recovery codes left
  router.get('/account', (req, res) => {
    res.json(service.accountInfo(req.auth));
  });

  // POST /api/auth/account/password {currentPassword, newPassword}
  router.post('/account/password', async (req, res) => {
    const b = body(req);
    res.json(await service.changePassword({ auth: req.auth, currentPassword: b.currentPassword, newPassword: b.newPassword, ip: req.ip }));
  });

  // POST /api/auth/account/recovery-codes {password, code} -> {recoveryCodes} (the old ones stop working)
  router.post('/account/recovery-codes', async (req, res) => {
    const b = body(req);
    res.json(await service.regenerateRecoveryCodes({ auth: req.auth, password: b.password, code: b.code, ip: req.ip }));
  });

  // POST /api/auth/account/two-factor/reset {password, code} -> {challenge, enroll: {secret, otpauthUrl}}
  router.post('/account/two-factor/reset', async (req, res) => {
    const b = body(req);
    res.json(await service.beginTotpReset({ auth: req.auth, password: b.password, code: b.code, ip: req.ip }));
  });

  // POST /api/auth/account/two-factor/confirm {challenge, code} — switches to the new authenticator
  router.post('/account/two-factor/confirm', (req, res) => {
    const b = body(req);
    res.json(service.finishTotpReset({ auth: req.auth, challenge: b.challenge, code: b.code, ip: req.ip }));
  });

  return router;
}
