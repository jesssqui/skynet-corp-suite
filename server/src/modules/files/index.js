// Files (D10): a Files tab on each client and account — uploads, links and password-manager pointers —
// with files added to a task listed there too. The list is a synced record type (`file`, offline on
// every device); an upload's bytes live in this module's own tables in the database, so the nightly
// backup holds them and a restore brings them back with their records. Uploading and downloading need
// a connection. See CLAUDE.md, "Files (D10)".
import { fileURLToPath } from 'node:url';
import { createFilesService } from './service.js';
import { createFilesRouter } from './routes.js';

export default {
  name: 'files',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createFilesService,
  createRouter: createFilesRouter,
  // The one request body that isn't JSON: POST /api/files/upload (application/octet-stream, signed in).
  rawUploads: ['/upload'],
  start(ctx, service) {
    try {
      service.purge();
    } catch (err) {
      ctx.log.warn(`couldn't purge deleted files' bytes: ${err.message}`);
    }
  },
};
