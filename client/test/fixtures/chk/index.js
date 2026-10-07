// Test-only module (client tests): a synced entity with a UNIQUE column, so the server can
// refuse a create the device had no way to check (constraint), the way C3a's real tables might.
import { fileURLToPath } from 'node:url';

export default {
  name: 'chk',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService({ services }) {
    services.sync.registerEntity({
      module: 'chk',
      entity: 'thing',
      table: 'chk_things',
      fields: { title: { type: 'text', required: true }, code: { type: 'text' }, n: { type: 'integer' } },
      ops: ['create', 'update', 'delete'],
    });
    return {};
  },
};
