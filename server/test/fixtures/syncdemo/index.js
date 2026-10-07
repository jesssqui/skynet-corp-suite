// A test-only module that registers two synced entities, the way C3a's modules will.
import { fileURLToPath } from 'node:url';

export default {
  name: 'syncdemo',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService({ db, services }) {
    services.sync.registerEntity({
      module: 'syncdemo',
      entity: 'item',
      table: 'syncdemo_items',
      fields: {
        title: { type: 'text', max: 200, required: true },
        phone: { type: 'text', max: 40 },
        qty: { type: 'integer' },
        done: { type: 'boolean' },
        due: { type: 'date' },
        status: { type: 'enum', values: ['open', 'won', 'lost'] },
      },
      ops: ['create', 'update', 'delete'],
    });
    services.sync.registerEntity({
      module: 'syncdemo',
      entity: 'note',
      table: 'syncdemo_notes',
      fields: { item_id: { type: 'id', required: true }, body: { type: 'text', max: 2000, required: true } },
      appendOnly: true,
    });
    // Module reads go straight to its own tables, skipping soft-deleted rows.
    const getItem = db.prepare('SELECT * FROM syncdemo_items WHERE id = ? AND deleted_at IS NULL');
    return { getItem: (id) => getItem.get(id) };
  },
};
