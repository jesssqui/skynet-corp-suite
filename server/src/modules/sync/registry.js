// Entity registry: which record types sync, which table holds them, which fields
// sync and which ops are allowed. Modules register from their createService:
//
//   ctx.services.sync.registerEntity({
//     module: 'crm', entity: 'task', table: 'crm_tasks',
//     fields: { title: { type: 'text', max: 300, required: true }, done: { type: 'boolean' } },
//     ops: ['create', 'update', 'delete'],          // or appendOnly: true (create only)
//   });
//
// The table needs `id TEXT PRIMARY KEY` and `deleted_at TEXT` (deletes are soft).
// Optional columns the sync module fills when present: created_at, created_by,
// updated_at, updated_by (step time and actor) and flagged (0/1, a delete clashed).
//
// The registry also installs per-connection TEMP triggers so a registered table
// can only be written while the sync module is applying a step: a stray
// `INSERT INTO crm_tasks` anywhere else fails loudly.
import { FIELD_TYPES as TYPES, DEFAULT_TEXT_MAX, checkFieldValue } from '@suite/shared/fields';

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const OPS = ['create', 'update', 'delete'];
// Columns the sync module fills itself when the table has them (never sent by devices).
export const STANDARD_COLUMNS = ['created_at', 'created_by', 'updated_at', 'updated_by', 'flagged'];
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
    const { module, entity, table, fields = {}, appendOnly = false } = def ?? {};
    const where = `sync.registerEntity(${entity})`;
    if (!NAME_RE.test(module ?? '')) throw new Error(`${where}: module must be a module name`);
    if (!NAME_RE.test(entity ?? '')) throw new Error(`${where}: entity must match ${NAME_RE}`);
    if (entities.has(entity)) throw new Error(`${where}: entity already registered by ${entities.get(entity).module}`);
    if (!NAME_RE.test(table ?? '')) throw new Error(`${where}: bad table name`);
    // A module syncs only its own tables (table names start with the module name).
    if (!table.startsWith(`${module}_`)) throw new Error(`${where}: table ${table} does not belong to module ${module}`);
    if (table.startsWith('sync_') || table === 'schema_migrations') throw new Error(`${where}: ${table} can't be synced`);

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
      fieldDefs.set(name, { name, type: f.type, required: Boolean(f.required), max: f.max, values: f.values });
    }
    if (!fieldDefs.size) throw new Error(`${where}: no fields`);

    const entry = {
      module, entity, table, fields: fieldDefs, ops, appendOnly: Boolean(appendOnly),
      standard: new Set(STANDARD_COLUMNS.filter((c) => columns.includes(c))),
      inserts: new Map(), // column list -> statement
      selectRow: db.prepare(`SELECT ${['id', 'deleted_at', ...fieldDefs.keys()].map(q).join(', ')} FROM ${q(table)} WHERE id = ?`),
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
      }])),
    }));
  }

  return {
    registerEntity, get, asWriter, checkValue, encode, decode, decodeRow, standardValues, insertRow, updateRow, describe,
  };
}
