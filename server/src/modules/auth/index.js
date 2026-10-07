// Sign-in: two accounts (made by the CLI), password + authenticator-app code,
// sessions in an HttpOnly cookie, devices that either person can sign out.
// Its service provides guard/requireSession, which app.js puts in front of every
// module's routes. CLAUDE.md, "Sign-in (auth module)".
import { fileURLToPath } from 'node:url';
import { createAuthService } from './service.js';
import { createAuthPublicRouter, createAuthRouter } from './routes.js';

export default {
  name: 'auth',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createAuthService,
  start: (_ctx, service) => service.afterStart(),
  createPublicRouter: createAuthPublicRouter,
  createRouter: createAuthRouter,
};
