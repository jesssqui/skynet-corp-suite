import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/lib/log.js';

export function tmpDir(t, prefix = 'suite-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function testConfig(dir, env = {}) {
  return loadConfig({
    DATA_DIR: path.join(dir, 'data'),
    BACKUP_OFFSITE_DIR: path.join(dir, 'offsite'),
    CLIENT_DIST: path.join(dir, 'no-client-build'),
    ...env,
  });
}

export const quietLog = createLogger('test', 'silent');

/** Every table's schema and rows, for comparing two databases. */
export function dumpDb(file) {
  const db = new Database(file, { readonly: true });
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all();
    const out = { schema: tables, rows: {}, userVersion: db.pragma('user_version', { simple: true }) };
    for (const { name } of tables.filter((t) => t.sql?.startsWith('CREATE TABLE'))) {
      out.rows[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all();
    }
    return out;
  } finally {
    db.close();
  }
}
