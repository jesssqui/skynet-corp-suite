import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { tmpDir } from './helpers.js';

function makeModule(root, name, files) {
  const dir = path.join(root, name, 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), body);
  return { name, migrationsDir: dir };
}

test('openDb turns on WAL and foreign keys', (t) => {
  const dir = tmpDir(t);
  const db = openDb(path.join(dir, 'x.db'));
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.close();
});

test('runs each module\'s migrations once, in order, and records them', async (t) => {
  const dir = tmpDir(t);
  const a = makeModule(dir, 'alpha', {
    '001_create_a.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY);',
    '002_seed_a.js': "export function up(db) { db.prepare(\"INSERT INTO a VALUES ('x')\").run(); }",
  });
  const b = makeModule(dir, 'beta', {
    '001_create_b.sql': 'CREATE TABLE b (id TEXT PRIMARY KEY, a_id TEXT REFERENCES a(id));',
  });
  const db = openDb(path.join(dir, 'm.db'));
  t.after(() => db.close());

  const first = await runMigrations(db, [a, b]);
  assert.deepEqual(first.map((m) => `${m.module}/${m.name}`), ['alpha/001_create_a.sql', 'alpha/002_seed_a.js', 'beta/001_create_b.sql']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM a').get().n, 1);

  const second = await runMigrations(db, [a, b]);
  assert.deepEqual(second, []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 3);

  // foreign keys are enforced across migrated tables
  assert.throws(() => db.prepare("INSERT INTO b VALUES ('1', 'missing')").run(), /FOREIGN KEY/);
});

test('a failing migration is rolled back and not recorded', async (t) => {
  const dir = tmpDir(t);
  const mod = makeModule(dir, 'gamma', {
    '001_ok.sql': 'CREATE TABLE g (id TEXT PRIMARY KEY);',
    '002_broken.sql': "INSERT INTO g VALUES ('kept-out'); THIS IS NOT SQL;",
  });
  const db = openDb(path.join(dir, 'f.db'));
  t.after(() => db.close());
  await assert.rejects(runMigrations(db, [mod]), /syntax error/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM g').get().n, 0);
  const names = db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name);
  assert.deepEqual(names, ['001_ok.sql']);
});

test('rejects badly named migration files', async (t) => {
  const dir = tmpDir(t);
  const mod = makeModule(dir, 'delta', { 'create-table.sql': 'SELECT 1;' });
  const db = openDb(path.join(dir, 'n.db'));
  t.after(() => db.close());
  await assert.rejects(runMigrations(db, [mod]), /Bad migration file name/);
});
