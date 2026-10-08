// Entity registry: which record types sync, which table holds them, which fields
// sync and which ops are allowed. Modules register from their createService:
//
//   ctx.services.sync.registerEntity({
//     module: 'crm', entity: 'task', table: 'crm_tasks',
//     fields: { title: { type: 'text', max: 300, required: true }, done: { type: 'boolean' },
//               client_id: { type: 'id', ref: 'client', parent: true }, email: { type: 'text', format: 'email' } },
//     ops: ['create', 'update', 'delete'],          // or appendOnly: true (create only)
//   });
//
// `ref` (id fields): the entity the id points to; a step naming a record that isn't there is
// refused `not_found` (devices park it and retry after their next pull).
// `parent: true` (with ref): the record belongs to that one (a task to its client). Deletes don't
// cascade — reads hide what belongs to a deleted record — and the delete-vs-edit rule follows the
// chain: a change under a record deleted concurrently keeps it (flagged), and a delete of a record
// whose subtree changed unseen is kept (flagged). See service.js, "belonging".
// `format` (text fields): the value is stored normalised (@suite/shared/normalize); see fields.js.
// `check({ op, recordId, fields, current, actor, server })` (optional): a module's own rule, run in
// the step's transaction before it is written (after the field and reference checks; for a delete,
// fields is null and `current` is the row — D1 added deletes, so the Order Manager's records can't
// be deleted by devices); return null,
// or { code, reason } to refuse the step (devices put it in Needs attention). Reads only.
// `actor` is who made the step (from the session, or 'system'); `server` is true for server code
// (sync.applyLocal) and false for a device's push (C8: alerts are made by the server only).
//
// The table needs `id TEXT PRIMARY KEY` and `deleted_at TEXT` (deletes are soft).
// Optional columns the sync module fills when present: created_at, created_by,
// updated_at, updated_by (step time and actor) and flagged (0/1, a delete clashed).
//
// The registry also installs per-connection TEMP triggers so a registered table
// can only be written while the sync module is applying a step: a stray
// `INSERT INTO crm_tasks` anywhere else fails loudly.
import { FIELD_TYPES as TYPES, FORMATS, DEFAULT_TEXT_MAX, checkFieldValue } from '@suite/shared/fields';

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const OPS = ['create', 'update', 'delete'];
// Columns the sync module fills itself when the table has them (never sent by devices).
export const STANDARD_COLUMNS = ['created_at', 'created_by', 'updated_at', 'updated_by', 'flagged'];
const META_COLUMNS = ['created_at', 'created_by', 'updated_at', 'updated_by'];
const RESERVED_FIELDS = new Set(['id', 'deleted_at', ...STANDARD_COLUMNS]);
// Field types and value checks live in @suite/shared/fields: devices check changes with the same rules.
export { DEFAULT_TEXT_MAX };

// The column affinity each field type needs, so values come back exactly as sent:
// a boolean in a TEXT column would be stored '1.0' and read back as a string, and
// "0123" in an INTEGER column would come back as 123.
const AFFINITY_FOR = {
  text: 'TEXT', date: 'TEXT', datetime: 'TEXT', id: 'TEXT', enum: 'TEXT',
  integer: 'INTEGER', boolean: 'INTEGER',
  number: 'REAL',
};

/** SQLite's column affinity for a declared type (https://sqlite.org/datatype3.html §3.1). */
export function affinityOf(declared) {
  const t = String(declared ?? '').toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t === '' || t.includes('BLOB')) return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

const q = (name) => `"${name}"`;

export function createRegistry(db) {
  const entities = new Map();
  let writing = 0;
  db.function('sync_writing', { deterministic: false }, () => (writing > 0 ? 1 : 0));

  function tableColumns(table) {
    return db.prepare('SELECT name, type FROM pragma_table_info(?)').all(table);
  }

  function installGuard(table) {
    for (const ev of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${q(`sync_guard_${table}_${ev.toLowerCase()}`)}
        BEFORE ${ev} ON main.${q(table)} WHEN sync_writing() = 0
        BEGIN SELECT RAISE(ABORT, '${table} is written only through the sync module'); END`);
    }
  }

  /**
   * Register an entity type. Throws on any mistake — registration happens at start-up,
   * so a bad definition stops the server instead of half-working.
   */
  function registerEntity(def) {
    const { module, entity, table, fields = {}, appendOnly = false, check = null } = def ?? {};
    const where = `sync.registerEntity(${entity})`;
    if (!NAME_RE.test(module ?? '')) throw new Error(`${where}: module must be a module name`);
    if (!NAME_RE.test(entity ?? '')) throw new Error(`${where}: entity must match ${NAME_RE}`);
    if (entities.has(entity)) throw new Error(`${where}: entity already registered by ${entities.get(entity).module}`);
    if (!NAME_RE.test(table ?? '')) throw new Error(`${where}: bad table name`);
    // A module syncs only its own tables (table names start with the module name).
    if (!table.startsWith(`${module}_`)) throw new Error(`${where}: table ${table} does not belong to module ${module}`);
    if (table.startsWith('sync_') || table === 'schema_migrations') throw new Error(`${where}: ${table} can't be synced`);

    if (check !== null && typeof check !== 'function') throw new Error(`${where}: check must be a function`);
    const ops = new Set(appendOnly ? ['create'] : (def.ops ?? OPS));
    for (const op of ops) if (!OPS.includes(op)) throw new Error(`${where}: unknown op ${op}`);
    if (!ops.has('create')) throw new Error(`${where}: 'create' must be allowed`);

    const columnInfo = tableColumns(table);
    if (!columnInfo.length) throw new Error(`${where}: table ${table} does not exist (migrations run before services)`);
    const columns = columnInfo.map((c) => c.name);
    const affinity = Object.fromEntries(columnInfo.map((c) => [c.name, affinityOf(c.type)]));
    for (const col of ['id', 'deleted_at']) {
      if (!columns.includes(col)) throw new Error(`${where}: table ${table} needs an "${col}" column`);
      if (affinity[col] !== 'TEXT') throw new Error(`${where}: ${table}.${col} must be a TEXT column`);
    }
    const STANDARD_AFFINITY = { created_at: 'TEXT', created_by: 'TEXT', updated_at: 'TEXT', updated_by: 'TEXT', flagged: 'INTEGER' };
    for (const [col, want] of Object.entries(STANDARD_AFFINITY)) {
      if (columns.includes(col) && affinity[col] !== want) throw new Error(`${where}: ${table}.${col} must be a ${want} column`);
    }

    const fieldDefs = new Map();
    for (const [name, f] of Object.entries(fields)) {
      if (!NAME_RE.test(name) || RESERVED_FIELDS.has(name)) throw new Error(`${where}: bad field name ${name}`);
      if (!columns.includes(name)) throw new Error(`${where}: table ${table} has no column ${name}`);
      if (!TYPES[f?.type]) throw new Error(`${where}: field ${name} has unknown type ${f?.type}`);
      if (affinity[name] !== AFFINITY_FOR[f.type]) {
        throw new Error(`${where}: field ${name} is ${f.type} but ${table}.${name} has ${affinity[name]} affinity `
          + `(declare it ${AFFINITY_FOR[f.type]})`);
      }
      if (f.type === 'enum' && !(Array.isArray(f.values) && f.values.length)) {
        throw new Error(`${where}: enum field ${name} needs values`);
      }
      if (f.format !== undefined && (f.type !== 'text' || !Object.hasOwn(FORMATS, f.format))) {
        throw new Error(`${where}: field ${name}: format ${f.format} needs a text field and one of ${Object.keys(FORMATS).join(', ')}`);
      }
      if (f.ref !== undefined && (f.type !== 'id' || !NAME_RE.test(f.ref ?? ''))) {
        throw new Error(`${where}: field ${name}: ref needs an id field and an entity name`);
      }
      if (f.parent !== undefined && (f.parent !== true || f.ref === undefined)) {
        throw new Error(`${where}: field ${name}: parent (true) needs a ref`);
      }
      fieldDefs.set(name, {
        name, type: f.type, required: Boolean(f.required), max: f.max, values: f.values, format: f.format, ref: f.ref,
        parent: f.parent === true,
      });
    }
    if (!fieldDefs.size) throw new Error(`${where}: no fields`);

    const parents = [...fieldDefs.values()].filter((f) => f.parent);
    const entry = {
      module, entity, table, fields: fieldDefs, ops, appendOnly: Boolean(appendOnly), parents, check,
      selectParents: parents.length ? db.prepare(`SELECT ${parents.map((f) => q(f.name)).join(', ')} FROM ${q(table)} WHERE id = ?`) : null,
      liveChildren: new Map(), // field name -> statement: live ids whose field names a record
      standard: new Set(STANDARD_COLUMNS.filter((c) => columns.includes(c))),
      inserts: new Map(), // column list -> statement
      // The synced fields plus who/when (created_*/updated_*, those the table has) for pulls.
      selectRow: db.prepare(`SELECT ${['id', 'deleted_at', ...fieldDefs.keys(), ...META_COLUMNS.filter((c) => columns.includes(c))]
        .map(q).join(', ')} FROM ${q(table)} WHERE id = ?`),
      setDeleted: db.prepare(`UPDATE ${q(table)} SET deleted_at = ? WHERE id = ?`),
      updates: new Map(), // column list -> statement
    };
    entities.set(entity, entry);
    installGuard(table);
    return entry;
  }

  function get(entity) {
    return entities.get(entity) ?? null;
  }

  /** Every ref field must point at a registered entity (checked once all modules registered). */
  function checkRefs() {
    for (const e of entities.values()) {
      for (const f of e.fields.values()) {
        if (f.ref && !entities.has(f.ref)) throw new Error(`sync: ${e.entity}.${f.name} points to ${f.ref}, which is not registered`);
      }
    }
  }

  /** The `parent` fields (of any entity) that point at `entity`: [{ entry, field }] — what belongs to it. */
  function children(entity) {
    const out = [];
    for (const e of entities.values()) for (const f of e.parents) if (f.ref === entity) out.push({ entry: e, field: f });
    return out;
  }

  /** Ids of live `entry` records whose parent `field` is `id`. */
  function liveChildren(entry, field, id) {
    let stmt = entry.liveChildren.get(field.name);
    if (!stmt) {
      stmt = db.prepare(`SELECT id FROM ${q(entry.table)} WHERE ${q(field.name)} = ? AND deleted_at IS NULL`).pluck();
      entry.liveChildren.set(field.name, stmt);
    }
    return stmt.all(id);
  }

  /** A record's parents as [{ field, id }] (non-null parent refs, from its row). */
  function parentsOf(entry, id) {
    if (!entry.selectParents) return [];
    const row = entry.selectParents.get(id);
    return row ? entry.parents.filter((f) => row[f.name] !== null).map((f) => ({ field: f, id: row[f.name] })) : [];
  }

  /** Run fn with the guard triggers relaxed (only the sync apply path does this). */
  function asWriter(fn) {
    writing += 1;
    try {
      return fn();
    } finally {
      writing -= 1;
    }
  }

  /** null when valid, else a message. */
  function checkValue(field, value) {
    return checkFieldValue(field, value);
  }

  function encode(field, value) {
    if (value === null || value === undefined) return null;
    return field.type === 'boolean' ? (value ? 1 : 0) : value;
  }

  function decode(field, value) {
    if (value === null || value === undefined) return null;
    return field.type === 'boolean' ? value === 1 : value;
  }

  function decodeRow(entry, row) {
    const out = {};
    for (const f of entry.fields.values()) out[f.name] = decode(f, row[f.name]);
    return out;
  }

  /** Keep only the standard columns this table has. */
  function standardValues(entry, values) {
    const out = {};
    for (const [k, v] of Object.entries(values)) if (entry.standard.has(k)) out[k] = v;
    return out;
  }

  function insertRow(entry, id, values) {
    const cols = ['id', ...Object.keys(values)];
    const k = cols.join(',');
    let stmt = entry.inserts.get(k);
    if (!stmt) {
      stmt = db.prepare(`INSERT INTO ${q(entry.table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      entry.inserts.set(k, stmt);
    }
    stmt.run(id, ...Object.values(values));
  }

  function updateRow(entry, id, values) {
    const cols = Object.keys(values);
    if (!cols.length) return;
    const k = cols.join(',');
    let stmt = entry.updates.get(k);
    if (!stmt) {
      stmt = db.prepare(`UPDATE ${q(entry.table)} SET ${cols.map((c) => `${q(c)} = ?`).join(', ')} WHERE id = ?`);
      entry.updates.set(k, stmt);
    }
    stmt.run(...Object.values(values), id);
  }

  function describe() {
    return [...entities.values()].map((e) => ({
      entity: e.entity,
      module: e.module,
      ops: [...e.ops],
      appendOnly: e.appendOnly,
      fields: Object.fromEntries([...e.fields.values()].map((f) => [f.name, {
        type: f.type,
        ...(f.required ? { required: true } : {}),
        ...(f.type === 'text' ? { max: f.max ?? DEFAULT_TEXT_MAX } : {}),
        ...(f.values ? { values: f.values } : {}),
        ...(f.format ? { format: f.format } : {}),
        ...(f.ref ? { ref: f.ref } : {}),
        ...(f.parent ? { parent: true } : {}),
      }])),
    }));
  }

  return {
    registerEntity, get, checkRefs, children, liveChildren, parentsOf, asWriter, checkValue, encode, decode, decodeRow, standardValues, insertRow, updateRow, describe,
  };
}
