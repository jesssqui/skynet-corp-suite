// The files module's synced record type (D10): one entry on a Files tab — an uploaded file, a link
// or a password pointer. Registered with the sync module at start-up; devices learn it from
// GET /api/sync/info, so the list is on every device offline. The bytes of an upload are not part
// of the record: they are fetched online (GET /api/files/:id/download).
//
// It belongs to (`parent`) exactly one of a client, an account or a task: deleting that hides it
// with it (deletes never cascade; undone through a clash, it comes back). New fields are nullable
// and never renamed (CLAUDE.md, rule 5).
import {
  FILE_KINDS, FILE_NAME_MAX, FILE_NOTES_MAX, FILE_URL_MAX, VAULT_MAX, VAULT_ITEM_MAX,
} from '@suite/shared/files';

export const FILE_ENTITY = {
  entity: 'file',
  table: 'files_items',
  // Delete is soft (sync tombstone); an upload's bytes are kept FILES_PURGE_DAYS after that.
  ops: ['create', 'update', 'delete'],
  fields: {
    kind: { type: 'enum', values: FILE_KINDS, required: true },
    name: { type: 'text', max: FILE_NAME_MAX, required: true },
    client_id: { type: 'id', ref: 'client', parent: true },
    account_id: { type: 'id', ref: 'account', parent: true },
    task_id: { type: 'id', ref: 'task', parent: true },
    notes: { type: 'text', max: FILE_NOTES_MAX },
    url: { type: 'text', max: FILE_URL_MAX },
    vault: { type: 'text', max: VAULT_MAX },
    vault_item: { type: 'text', max: VAULT_ITEM_MAX },
    // Set by the server's upload route only (the module's check refuses them from devices).
    blob_id: { type: 'id' },
    size: { type: 'integer' },
    content_type: { type: 'text', max: 120 },
    sha256: { type: 'text', max: 64 },
  },
};

/** Fields only the upload route writes. */
export const BLOB_FIELDS = ['blob_id', 'size', 'content_type', 'sha256'];
/** Fields that say where a file is; fixed once made. */
export const FIXED_FIELDS = ['kind', 'client_id', 'account_id', 'task_id'];
