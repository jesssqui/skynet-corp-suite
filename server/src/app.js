// Builds the Express app around an open database. Kept separate from index.js
// (which listens, schedules backups and handles shutdown) so tests can create
// an app on a temporary database.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { runMigrations } from './db/migrate.js';
import { modules as registeredModules } from './modules/index.js';
import { HttpError } from './lib/httpError.js';
import { redactPath } from './lib/redact.js';

/**
 * @param {object} opts
 * @param {ReturnType<import('./config.js').loadConfig>} opts.config
 * @param {import('better-sqlite3').Database} opts.db
 * @param {ReturnType<import('./lib/log.js').createLogger>} opts.log
 * @param {Array} [opts.modules] defaults to the registration list
 * @param {() => number} [opts.now] the clock in ms (tests move it to expire sessions)
 */
export async function createApp({ config, db, log, modules = registeredModules, now = Date.now }) {
  await runMigrations(db, modules, { log: (m) => log.info(m) });

  const ctx = { config, db, log, services: {}, now };
  for (const mod of modules) {
    if (mod.createService) {
      ctx.services[mod.name] = mod.createService({ ...ctx, log: log.child(mod.name) });
    }
  }

  for (const mod of modules) {
    if (mod.start) mod.start({ ...ctx, log: log.child(mod.name) }, ctx.services[mod.name]);
  }

  // Every route needs a signed-in session unless its module lists it in createPublicRouter.
  const auth = ctx.services.auth;
  if (!auth?.guard || !auth?.requireSession) throw new Error('The auth module must be registered (modules/index.js)');

  const app = express();
  app.disable('x-powered-by');
  // Who to believe about X-Forwarded-For/-Proto/-Host: Tailscale Serve, proxying from the
  // Mac's loopback (and, in Docker, through Docker's port forwarder — see docker-compose.yml).
  // Makes req.secure true behind HTTPS (Secure cookies) and req.ip the device's tailnet address.
  app.set('trust proxy', config.auth.trustProxy);
  app.use(helmet({
    // No HSTS: it would apply to the whole ts.net hostname on every port and force
    // other apps on this Mac (e.g. the Order Manager on http://…ts.net:3000) to https.
    // Tailscale Serve already makes the suite HTTPS-only.
    strictTransportSecurity: false,
    contentSecurityPolicy: {
      directives: {
        // Pages are reached over plain http on localhost as well as https via Tailscale Serve.
        upgradeInsecureRequests: null,
      },
    },
  }));
  // Signed server-to-server routes (D1: the Order Manager's POST /api/wom/events). Each is one exact
  // method + path that authenticates every request itself (an HMAC signature over the raw body), so
  // it is mounted before the Origin/JSON guard and the JSON parser — and nothing else is: any other
  // method or path under it (e.g. GET /api/wom/events, POST /api/wom/events/x) still goes through
  // the guard like every API request. app.test.js / wholesale.test.js prove the exemption is that narrow.
  for (const mod of modules) {
    for (const route of mod.signedRoutes ?? []) {
      const method = String(route.method).toLowerCase();
      if (!['post', 'put'].includes(method) || !/^\/api\/[a-z0-9/_-]+$/.test(route.path ?? '')) {
        throw new Error(`${mod.name}: a signed route needs POST/PUT and an exact /api/... path`);
      }
      const modCtx = { ...ctx, log: log.child(mod.name) };
      app[method](route.path, ...route.handlers(modCtx, ctx.services[mod.name]));
    }
  }
  // Origin/CSRF check, JSON-only bodies, and the session (req.auth) for every API request.
  app.use('/api', auth.guard);
  // A module may take bigger JSON bodies on some paths (`bodyLimits: { '/import': '8mb' }`): signed in
  // only, parsed before the default 1 MB parser (which then leaves the parsed body alone).
  for (const mod of modules) {
    for (const [at, limit] of Object.entries(mod.bodyLimits ?? {})) {
      app.use(`/api/${mod.name}${at}`, auth.requireSession, express.json({ limit }));
    }
  }
  app.use(express.json({ limit: '1mb' }));

  for (const mod of modules) {
    const modCtx = { ...ctx, log: log.child(mod.name) };
    // Public routes first (sign-in, the minimal health check); anything they don't answer
    // falls through to the module's signed-in routes behind requireSession.
    if (mod.createPublicRouter) app.use(`/api/${mod.name}`, mod.createPublicRouter(modCtx, ctx.services[mod.name]));
    if (mod.createRouter) app.use(`/api/${mod.name}`, auth.requireSession, mod.createRouter(modCtx, ctx.services[mod.name]));
  }

  app.use('/api', auth.requireSession, (req, _res, next) => next(new HttpError(404, `No API route for ${req.method} ${redactPath(req.originalUrl)}`)));

  // The built client (production / Docker). In development Vite serves it on :5173.
  const indexHtml = path.join(config.clientDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use('/assets', express.static(path.join(config.clientDist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(config.clientDist, { index: false, maxAge: 0 }));
    // Any other GET is a client-side route.
    app.get('/{*path}', (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    // Never the calendar feed's token (C6a): paths with a secret in them are redacted.
    if (status >= 500) log.error(`${req.method} ${redactPath(req.originalUrl)}:`, err);
    const own = err instanceof HttpError;
    if (own && err.headers) res.set(err.headers);
    res.status(status).json({
      error: status >= 500 && config.production ? 'Something went wrong' : err.message,
      ...(own && err.code ? { code: err.code } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
  });

  return { app, ctx };
}
