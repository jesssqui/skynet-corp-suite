import { newId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { APP_VERSION } from '../../config.js';
import { readStatus } from '../../backup/backup.js';

const STALE_BACKUP_MS = 26 * 60 * 60 * 1000;

export function createHealthService({ db, config }) {
  const getMeta = db.prepare('SELECT value FROM health_meta WHERE key = ?');
  const setMetaOnce = db.prepare('INSERT OR IGNORE INTO health_meta (key, value) VALUES (?, ?)');

  // Name this database the first time it starts.
  db.transaction(() => {
    setMetaOnce.run('instance_id', newId());
    setMetaOnce.run('created_at', nowIso());
  })();

  function dbStatus() {
    try {
      const migrations = db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n;
      return {
        ok: true,
        instanceId: getMeta.get('instance_id')?.value ?? null,
        createdAt: getMeta.get('created_at')?.value ?? null,
        migrations,
        journalMode: db.pragma('journal_mode', { simple: true }),
        foreignKeys: db.pragma('foreign_keys', { simple: true }) === 1,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function backupStatus(now = new Date()) {
    const s = readStatus(config.backup.dir);
    const lastSuccessAt = s?.lastSuccessAt ?? null;
    const fresh = Boolean(lastSuccessAt) && now - Date.parse(lastSuccessAt) < STALE_BACKUP_MS;
    return {
      ok: fresh && s?.offsite === 'ok',
      scheduled: config.backup.enabled,
      time: config.backup.time,
      keepDays: config.backup.keepDays,
      offsiteConfigured: Boolean(config.backup.offsiteDir),
      lastSuccessAt,
      lastFile: s?.lastFile ?? null,
      offsite: s?.offsite ?? null,
      lastError: s?.lastError ?? null,
      lastErrorAt: s?.lastErrorAt ?? null,
    };
  }

  function getStatus() {
    const database = dbStatus();
    return {
      ok: database.ok,
      name: 'suite',
      version: APP_VERSION,
      commit: config.commit,
      time: nowIso(),
      uptimeSeconds: Math.round(process.uptime()),
      db: database,
      backup: backupStatus(),
    };
  }

  return { getStatus };
}
