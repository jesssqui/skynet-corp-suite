// Module shape (every module follows it):
//   name            URL prefix (/api/<name>) and the migrations key; lowercase, never renamed
//   migrationsDir   numbered .sql/.js files, applied once each (db/migrate.js)
//   createService   (ctx) => functions other modules may call via ctx.services.<name>
//   createRouter    (ctx, service) => express.Router mounted at /api/<name>, signed-in requests only
//   createPublicRouter  optional; (ctx, service) => express.Router for the few routes that work
//                   without a session (sign-in, this health check). Think twice before adding one.
// A module touches only its own tables; anything it needs from another module
// goes through that module's service.
import { fileURLToPath } from 'node:url';
import { createHealthService } from './service.js';
import { createHealthPublicRouter } from './routes.js';

export default {
  name: 'health',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createHealthService,
  createPublicRouter: createHealthPublicRouter,
};
