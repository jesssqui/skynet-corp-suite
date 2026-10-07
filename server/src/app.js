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

/**
 * @param {object} opts
 * @param {ReturnType<import('./config.js').loadConfig>} opts.config
 * @param {import('better-sqlite3').Database} opts.db
 * @param {ReturnType<import('./lib/log.js').createLogger>} opts.log
 * @param {Array} [opts.modules] defaults to the registration list
 */
export async function createApp({ config, db, log, modules = registeredModules }) {
  await runMigrations(db, modules, { log: (m) => log.info(m) });

  const ctx = { config, db, log, services: {} };
  for (const mod of modules) {
    if (mod.createService) {
      ctx.services[mod.name] = mod.createService({ ...ctx, log: log.child(mod.name) });
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        // Pages are reached over plain http on localhost as well as https via Tailscale Serve.
        upgradeInsecureRequests: null,
      },
    },
  }));
  app.use(express.json({ limit: '1mb' }));

  for (const mod of modules) {
    if (mod.createRouter) {
      app.use(`/api/${mod.name}`, mod.createRouter({ ...ctx, log: log.child(mod.name) }, ctx.services[mod.name]));
    }
  }

  app.use('/api', (req, _res, next) => next(new HttpError(404, `No API route for ${req.method} ${req.originalUrl}`)));

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
    if (status >= 500) log.error(`${req.method} ${req.originalUrl}:`, err);
    res.status(status).json({
      error: status >= 500 && config.production ? 'Something went wrong' : err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  });

  return { app, ctx };
}
