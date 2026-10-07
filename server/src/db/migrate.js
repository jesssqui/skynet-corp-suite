// Per-module migrations, tracked in one schema_migrations table.
//
// Each module keeps numbered files in its own migrations/ folder:
//   001_create_things.sql     plain SQL, run as-is
//   002_backfill_things.js    exports `up(db)` for anything SQL can't do
// Files run in name order, once each, each inside its own transaction. Never
// edit a migration that has shipped — add a new one.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nowIso } from '@suite/shared/time';

const FILE_RE = /^\d{3,}_[a-z0-9_]+\.(sql|js)$/;

export function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      module     TEXT NOT NULL,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (module, name)
    ) WITHOUT ROWID;
  `);
}

export function listMigrationFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
  for (const f of files) {
    if (!FILE_RE.test(f)) throw new Error(`Bad migration file name ${path.join(dir, f)} (expected 001_snake_name.sql|js)`);
  }
  return files;
}

/**
 * Apply every pending migration for the given modules, in module order then file order.
 * @param {import('better-sqlite3').Database} db
 * @param {{ name: string, migrationsDir?: string }[]} modules
 * @returns {Promise<{ module: string, name: string }[]>} the migrations applied now
 */
export async function runMigrations(db, modules, { log = () => {} } = {}) {
  ensureMigrationsTable(db);
  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE module = ? AND name = ?');
  const record = db.prepare('INSERT INTO schema_migrations (module, name, applied_at) VALUES (?, ?, ?)');
  const applied = [];

  for (const mod of modules) {
    for (const file of listMigrationFiles(mod.migrationsDir)) {
      if (isApplied.get(mod.name, file)) continue;
      const full = path.join(mod.migrationsDir, file);
      let up;
      if (file.endsWith('.sql')) {
        const sql = fs.readFileSync(full, 'utf8');
        up = (d) => d.exec(sql);
      } else {
        const m = await import(pathToFileURL(full).href);
        if (typeof m.up !== 'function') throw new Error(`${full} must export up(db)`);
        up = m.up;
      }
      // better-sqlite3 transactions are synchronous: `up` must not be async.
      db.transaction(() => {
        const result = up(db);
        if (result && typeof result.then === 'function') throw new Error(`${full}: up(db) must be synchronous`);
        record.run(mod.name, file, nowIso());
      })();
      applied.push({ module: mod.name, name: file });
      log(`migrated ${mod.name}/${file}`);
    }
  }
  return applied;
}
