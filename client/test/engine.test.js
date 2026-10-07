// The browser sync engine (client/src/sync/engine.js) against a real suite server with the
// test-only syncdemo module: offline changes, merging, restores, refused steps, clashes,
// sign-out. IndexedDB is fake-indexeddb; everything else (HTTP, sign-in, SQLite) is real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { newId } from '@suite/shared/ids';
import { runBackup } from '../../server/src/backup/backup.js';
import { restoreBackup } from '../../server/src/backup/restore.js';
import { createSyncEngine, createLocalLocks, LIMITS, SyncError, storageError } from '../src/sync/engine.js';
import { openLocalDb } from '../src/sync/localdb.js';
import { transact } from '../src/sync/idb.js';
import { startServer, makeDevice, settle, row, count, tmpDir, testConfig } from './helpers.js';

const items = (db) => db.prepare('SELECT * FROM syncdemo_items WHERE deleted_at IS NULL ORDER BY id').all();
const notes = (db) => db.prepare('SELECT * FROM syncdemo_notes ORDER BY id').all();

async function storeContents(idbFactory) {
  const { db, close } = await openLocalDb(idbFactory);
  try {
    return await transact(db, ['records', 'outbox', 'sent', 'attention', 'meta', 'staging'], 'readonly', async (t) => ({
      records: await t.getAll('records'),
      outbox: await t.getAll('outbox'),
      sent: await t.getAll('sent'),
      attention: await t.getAll('attention'),
      staging: await t.getAll('staging'),
      meta: { hlc: await t.get('meta', 'hlc'), seen: await t.get('meta', 'seen'), pull: await t.get('meta', 'pull'), generation: await t.get('meta', 'generation') },
    }));
  } finally {
    close();
  }
}

test('offline: create and edit with no connection, see the changes at once, push them when back online', async (t) => {
  const server = await startServer(t);
  const phone = await makeDevice(t, server, 'owner');
  await settle(phone.engine);
  assert.equal(phone.engine.status().ready, true, 'one connection taught it the entity definitions');

  phone.online = false;
  phone.calls.length = 0;
  const itemId = await phone.engine.create('item', { title: 'Lefty’s', qty: 1 });
  assert.equal(await phone.engine.update('item', itemId, { qty: 3, done: true }), true);
  assert.equal(await phone.engine.update('item', itemId, { qty: 3 }), false, 'nothing changed: no step');
  const noteId = await phone.engine.create('note', { item_id: itemId, body: 'Called, wants a quote' });

  const [item] = await phone.engine.list('item');
  assert.equal(item.id, itemId);
  assert.equal(item.qty, 3);
  assert.equal(item.done, true);
  assert.equal(item.phone, null, 'fields not given are null');
  assert.deepEqual({ pending: item._sync.pending, local: item._sync.local }, { pending: true, local: true });
  assert.equal((await phone.engine.get('note', noteId)).body, 'Called, wants a quote');
  assert.equal(phone.engine.status().waiting, 3);

  await phone.engine.syncNow();
  assert.equal(phone.engine.status().phase, 'offline');
  assert.deepEqual(phone.calls, [], 'no request is even tried while offline');

  // The app is closed and opened again, still offline: everything is still there.
  phone.engine.stop();
  const reopened = phone.newEngine();
  await reopened.start();
  assert.equal(reopened.status().waiting, 3);
  assert.equal((await reopened.get('item', itemId)).qty, 3);

  phone.online = true;
  await reopened.syncNow();
  assert.equal(reopened.status().phase, 'idle');
  assert.equal(reopened.status().waiting, 0);
  const saved = row(server.db, 'syncdemo_items', itemId);
  assert.deepEqual([saved.title, saved.qty, saved.done], ['Lefty’s', 3, 1]);
  assert.equal(row(server.db, 'syncdemo_notes', noteId).body, 'Called, wants a quote');
  const after = await reopened.get('item', itemId);
  assert.deepEqual({ pending: after._sync.pending, local: after._sync.local }, { pending: false, local: false }, 'now from the pulled copy');

  // The steps are kept (30 days) and the clock was saved: new stamps sort after the old ones.
  const store = await storeContents(phone.idbFactory);
  assert.equal(store.sent.length, 3);
  assert.equal(store.outbox.length, 0);
  const lastHlc = store.meta.hlc;
  await reopened.update('item', itemId, { qty: 4 });
  const next = (await storeContents(phone.idbFactory)).outbox[0].step;
  assert.ok(next.hlc > lastHlc, 'stamps keep increasing across restarts');
  assert.equal(next.seen, store.meta.seen, 'seen = cursor of the last complete pull');
});

test('local checks: unknown fields, bad values, missing required fields and refused ops never reach the outbox', async (t) => {
  const server = await startServer(t);
  const phone = await makeDevice(t, server, 'owner');
  await settle(phone.engine);
  const e = phone.engine;
  const code = async (p) => {
    try {
      await p;
    } catch (err) {
      assert.ok(err instanceof SyncError, err.message);
      return err.code;
    }
    return 'no error';
  };
  assert.equal(await code(e.create('item', { title: 'x', nope: 1 })), 'unknown_field');
  assert.equal(await code(e.create('item', { qty: 1 })), 'invalid_value'); // title required
  assert.equal(await code(e.create('item', { title: 'x', qty: 1.5 })), 'invalid_value');
  assert.equal(await code(e.create('item', { title: 'x', status: 'maybe' })), 'invalid_value');
  assert.equal(await code(e.create('item', { title: 'x', due: '2026-02-30' })), 'invalid_value');
  assert.equal(await code(e.create('item', { title: 'x'.repeat(201) })), 'invalid_value');
  assert.equal(await code(e.create('nothing', { title: 'x' })), 'unknown_entity');
  const noteId = await e.create('note', { item_id: newId(), body: 'b' });
  assert.equal(await code(e.update('note', noteId, { body: 'c' })), 'op_not_allowed', 'notes are append-only');
  assert.equal(await code(e.update('item', newId(), { qty: 1 })), 'not_found');
  assert.equal(e.status().waiting, 1);

  // A device that never connected doesn't know what it may save.
  const fresh = await makeDevice(t, server, 'partner', { start: false });
  fresh.online = false;
  await fresh.engine.start();
  assert.equal(await code(fresh.engine.create('item', { title: 'x' })), 'not_ready');
});

test('two devices merge: different fields both apply, notes add up, and the same field clashes and can be settled', async (t) => {
  const server = await startServer(t);
  const a = await makeDevice(t, server, 'owner');
  const b = await makeDevice(t, server, 'partner');
  const itemId = await a.engine.create('item', { title: 'Lefty’s', qty: 1 });
  await settle(a.engine);
  await settle(b.engine);
  assert.equal((await b.engine.get('item', itemId)).title, 'Lefty’s');

  a.online = false;
  b.online = false;
  await a.engine.update('item', itemId, { phone: '5195550100' });
  await b.engine.update('item', itemId, { qty: 5 });
  await a.engine.create('note', { item_id: itemId, body: 'from the phone' });
  await b.engine.create('note', { item_id: itemId, body: 'from the Mac' });
  a.online = true;
  b.online = true;
  await a.engine.syncNow();
  await b.engine.syncNow();
  await a.engine.syncNow();
  for (const dev of [a, b]) {
    const item = await dev.engine.get('item', itemId);
    assert.deepEqual([item.phone, item.qty, item._sync.clashes.length], ['5195550100', 5, 0], dev.actor);
    assert.deepEqual((await dev.engine.list('note', { sort: 'body' })).map((n) => n.body), ['from the Mac', 'from the phone']);
  }

  // Both change the title without seeing each other's change: one wins, the other is kept for review.
  a.online = false;
  b.online = false;
  await a.engine.update('item', itemId, { title: 'Phone title' });
  await b.engine.update('item', itemId, { title: 'Mac title' });
  a.online = true;
  b.online = true;
  await a.engine.syncNow();
  await b.engine.syncNow();
  await a.engine.syncNow();
  const seenA = await a.engine.get('item', itemId);
  const seenB = await b.engine.get('item', itemId);
  assert.equal(seenA.title, seenB.title, 'both show the same winner');
  assert.equal(seenA._sync.clashes.length, 1, 'the clash is surfaced on the record');
  const clash = seenB._sync.clashes[0];
  assert.equal(clash.field, 'title');
  assert.deepEqual([clash.winner.value, clash.loser.value].sort(), ['Mac title', 'Phone title']);

  // Settling needs a connection.
  b.online = false;
  await assert.rejects(b.engine.resolveClash(clash.id, 'keep_loser'), (err) => err.code === 'offline');
  b.online = true;
  await b.engine.resolveClash(clash.id, 'keep_loser');
  await a.engine.syncNow();
  for (const dev of [a, b]) {
    const item = await dev.engine.get('item', itemId);
    assert.equal(item.title, clash.loser.value, dev.actor);
    assert.equal(item._sync.clashes.length, 0);
  }
});

test('a delete against an unseen edit keeps the record, flagged, until someone settles it', async (t) => {
  const server = await startServer(t);
  const a = await makeDevice(t, server, 'owner');
  const b = await makeDevice(t, server, 'partner');
  const itemId = await a.engine.create('item', { title: 'Keep or delete?' });
  await settle(a.engine);
  await settle(b.engine);

  b.online = false;
  await b.engine.remove('item', itemId);
  assert.equal(await b.engine.get('item', itemId), null, 'gone at once on the device that deleted it');
  await a.engine.update('item', itemId, { phone: '555' });
  await a.engine.syncNow();
  b.online = true;
  await b.engine.syncNow();
  const kept = await b.engine.get('item', itemId);
  assert.ok(kept, 'the server kept it: the delete is not shown as done');
  assert.equal(kept._sync.flagged, true);
  assert.equal(kept._sync.clashes[0].kind, 'delete');
  assert.equal(kept.phone, '555');

  // Deleting after all, from the other device.
  await a.engine.syncNow();
  await a.engine.resolveClash((await a.engine.get('item', itemId))._sync.clashes[0].id, 'keep_loser');
  await b.engine.syncNow();
  assert.equal(await a.engine.get('item', itemId), null);
  assert.equal(await b.engine.get('item', itemId), null);
});

test('changes are shown on top of the pulled copy until a complete pull brings them back', async (t) => {
  const server = await startServer(t);
  const a = await makeDevice(t, server, 'owner');
  const b = await makeDevice(t, server, 'partner');
  const itemId = await a.engine.create('item', { title: 'T', qty: 1, phone: '1' });
  await settle(a.engine);
  await settle(b.engine);

  // B changes the phone; A changes qty, its push goes through but the pull fails.
  await b.engine.update('item', itemId, { phone: '2' });
  await b.engine.syncNow();
  await a.engine.update('item', itemId, { qty: 7 });
  a.failNext.push(null, null, { status: 503, message: 'pull failed' }); // info, push, then the pull
  await a.engine.syncNow();
  assert.equal(a.engine.status().phase, 'error');
  assert.equal(row(server.db, 'syncdemo_items', itemId).qty, 7, 'the push went through');
  const shown = await a.engine.get('item', itemId);
  assert.equal(shown.qty, 7, 'the accepted change is still shown, not the old pulled value');
  assert.equal(shown._sync.pending, false, 'and it is no longer waiting');
  assert.equal(shown.phone, '1', 'B’s change arrives with the next pull');

  await a.engine.syncNow();
  const after = await a.engine.get('item', itemId);
  assert.deepEqual([after.qty, after.phone], [7, '2']);
});

test('pulls page through with the cursor until hasMore is false; a pull from scratch replaces the copy in one go', async (t) => {
  const server = await startServer(t);
  const a = await makeDevice(t, server, 'owner');
  const b = await makeDevice(t, server, 'partner');
  await settle(b.engine);
  for (let i = 0; i < 5; i += 1) await b.engine.create('item', { title: `item ${i}` });
  await b.engine.syncNow();

  const limit = LIMITS.pullLimit;
  LIMITS.pullLimit = 2;
  t.after(() => { LIMITS.pullLimit = limit; });
  a.calls.length = 0;
  await a.engine.syncNow();
  assert.equal(a.calls.filter((c) => c === 'GET /api/sync/pull').length, 3);
  assert.equal((await a.engine.list('item')).length, 5);
  const store = await storeContents(a.idbFactory);
  assert.equal(store.meta.seen, store.meta.pull);
  assert.equal(store.staging.length, 0);

  // Download everything again: the old copy stays readable until the new one is complete.
  const removed = (await b.engine.list('item'))[0].id;
  await b.engine.remove('item', removed);
  await b.engine.syncNow();
  a.failNext.push(null, null, null, { status: 0, message: 'connection dropped' }); // info, page 1, page 2, then page 3 fails
  await a.engine.refetchAll();
  assert.equal(a.engine.status().phase, 'offline');
  assert.equal((await a.engine.list('item')).length, 5, 'half a download never replaces the copy');
  await a.engine.syncNow();
  assert.equal((await a.engine.list('item')).length, 4);
  assert.equal(await a.engine.get('item', removed), null);
});

test('one push in flight per device: two tabs sharing the device and its database never push at once', async (t) => {
  const server = await startServer(t);
  const idbFactory = new IDBFactory();
  const tab1 = await makeDevice(t, server, 'owner', { idbFactory });
  await settle(tab1.engine);
  // A second tab: same device id and database, same lock (navigator.locks is per browser profile).
  const locks = createLocalLocks();
  let inFlight = 0;
  let maxInFlight = 0;
  const slow = {
    get: (p) => tab1.transport.get(p),
    post: async (p, body) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 20));
        return await tab1.transport.post(p, body);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const mk = () => createSyncEngine({ deviceId: tab1.id, transport: slow, idbFactory, locks, autoSync: false, isOnline: () => true });
  const e1 = mk();
  const e2 = mk();
  t.after(() => { e1.stop(); e2.stop(); });
  tab1.engine.stop();
  await Promise.all([e1.start(), e2.start()]);
  const ids = await Promise.all([
    e1.create('item', { title: 'tab 1 a' }), e2.create('item', { title: 'tab 2 a' }),
    e1.create('item', { title: 'tab 1 b' }), e2.create('item', { title: 'tab 2 b' }),
  ]);
  await Promise.all([e1.syncNow(), e2.syncNow(), e1.syncNow(), e2.syncNow()]);
  assert.equal(maxInFlight, 1);
  assert.equal(items(server.db).length, 4);
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM sync_steps'), 4, 'each change applied once');
  const stamps = (await storeContents(idbFactory)).sent.map((s) => s.step.hlc);
  assert.equal(new Set(stamps).size, 4, 'no two changes share a stamp');
  assert.deepEqual((await e2.list('item')).map((i) => i.id).sort(), [...ids].sort());
});

test('retries: network errors and 5xx back off and resend the same steps, which apply once', async (t) => {
  const server = await startServer(t);
  const timers = [];
  const fake = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  };
  const phone = await makeDevice(t, server, 'owner', { engine: { autoSync: true, timers: fake, retryBaseMs: 1000 } });
  await settle(phone.engine);
  timers.length = 0;
  const id = await phone.engine.create('item', { title: 'retry me' });
  assert.equal(timers.length, 1, 'a change asks for a sync soon');
  assert.equal(timers[0].ms, 1500);

  // The push reaches the server but the answer is lost; then a 503.
  const realPost = phone.transport.post;
  let lostOnce = false;
  phone.transport.post = async (p, b) => {
    const res = await realPost(p, b);
    if (p === '/api/sync/push' && !lostOnce) {
      lostOnce = true;
      throw Object.assign(new Error('connection reset'), { status: 0 });
    }
    return res;
  };
  timers.shift().fn();
  await settle(phone.engine);
  assert.equal(phone.engine.status().phase, 'offline');
  assert.equal(phone.engine.status().waiting, 1);
  const first = timers.at(-1);
  assert.ok(first.ms >= 800 && first.ms <= 1200, `first retry after ~1 s (${first.ms})`);

  phone.failNext.push({ status: 503, message: 'busy' });
  timers.pop().fn();
  await settle(phone.engine);
  assert.equal(phone.engine.status().phase, 'error');
  const second = timers.at(-1);
  assert.ok(second.ms >= 1600 && second.ms <= 2400, `then ~2 s (${second.ms})`);

  timers.pop().fn();
  await settle(phone.engine);
  assert.equal(phone.engine.status().phase, 'idle');
  assert.equal(phone.engine.status().waiting, 0);
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM syncdemo_items WHERE id = ?', id), 1);
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM sync_steps'), 1, 'resent step was a duplicate, not a second change');
  const [sent] = (await storeContents(phone.idbFactory)).sent;
  assert.equal(sent.status, 'applied', 'a duplicate answer records the original outcome');
});

test('refused steps go to "needs attention": fix as a new step, retry unchanged, or discard', async (t) => {
  const server = await startServer(t);
  const a = await makeDevice(t, server, 'owner');
  const b = await makeDevice(t, server, 'partner');
  const itemId = await a.engine.create('item', { title: 'Real item' });
  await settle(a.engine);

  // A note for an item the server doesn't have: refused (foreign key), not kept as pending.
  const ghost = newId();
  const noteId = await a.engine.create('note', { item_id: ghost, body: 'lost note' });
  await a.engine.syncNow();
  assert.equal(a.engine.status().attention, 1);
  assert.equal(a.engine.status().waiting, 0);
  assert.equal(await a.engine.get('note', noteId), null, 'a refused change is not shown as if saved');
  const [refused] = await a.engine.attentionList();
  assert.equal(refused.code, 'constraint');
  assert.equal(refused.step.recordId, noteId);

  // Fixed: a new step with a new key and stamp, same record id.
  const fixed = await a.engine.fixAttention(refused.n, { item_id: itemId, body: 'found note' });
  assert.notEqual(fixed.key, refused.step.key);
  assert.ok(fixed.hlc > refused.step.hlc);
  await a.engine.syncNow();
  assert.equal(a.engine.status().attention, 0);
  assert.equal(row(server.db, 'syncdemo_notes', noteId).body, 'found note');

  // Retried unchanged once its item exists (the server never recorded the refused step).
  const bItem = await b.engine.create('item', { title: 'Not pushed yet' });
  await settle(a.engine);
  await a.engine.create('note', { item_id: bItem, body: 'early note' });
  await a.engine.syncNow();
  const [early] = await a.engine.attentionList();
  await b.engine.syncNow();
  await a.engine.retryAttention(early.n);
  await a.engine.syncNow();
  assert.equal(a.engine.status().attention, 0);
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM syncdemo_notes WHERE id = ?', early.step.recordId), 1);
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM sync_steps WHERE key = ?', early.step.key), 1, 'same key');

  // Discarded.
  await a.engine.create('note', { item_id: newId(), body: 'never mind' });
  await a.engine.syncNow();
  const [drop] = await a.engine.attentionList();
  assert.equal(await a.engine.discardAttention(drop.n), 1);
  assert.equal(a.engine.status().attention, 0);
  assert.equal(notes(server.db).length, 2);
});

test('fixing a refused create keeps the edits made to it afterwards (folded in, not dropped as stale)', async (t) => {
  const server = await startServer(t);
  const mac = await makeDevice(t, server, 'partner');
  const phone = await makeDevice(t, server, 'owner');
  await mac.engine.create('thing', { title: 'mac', code: 'X' });
  await mac.engine.syncNow();

  // Offline, the phone makes a thing whose code the server already has, then edits it twice.
  phone.online = false;
  const id = await phone.engine.create('thing', { title: 'phone', code: 'X' });
  await phone.engine.update('thing', id, { n: 5 });
  await phone.engine.update('thing', id, { title: 'phone edited' });
  phone.online = true;
  await phone.engine.syncNow();
  assert.equal(phone.engine.status().attention, 1, 'the create is refused (UNIQUE)');
  assert.equal(phone.engine.status().parked, 2, 'its edits wait for it');
  const [refused] = await phone.engine.attentionList();
  assert.equal(refused.code, 'constraint');
  assert.deepEqual(refused.latest, { title: 'phone edited', code: 'X', n: 5 }, 'the Fix form starts from the latest values');
  assert.equal(refused.laterChanges, 2);

  // Fixed (only the code changes): one new create carrying the later edits; they leave the outbox.
  const fixed = await phone.engine.fixAttention(refused.n, { code: 'Y' });
  assert.deepEqual(fixed.fields, { title: 'phone edited', code: 'Y', n: 5 });
  assert.equal(phone.engine.status().waiting, 1);
  const shown = await phone.engine.get('thing', id);
  assert.deepEqual([shown.title, shown.code, shown.n, shown._sync.pending], ['phone edited', 'Y', 5, true]);

  await phone.engine.syncNow();
  assert.deepEqual([phone.engine.status().waiting, phone.engine.status().attention], [0, 0]);
  const saved = server.db.prepare('SELECT title, code, n FROM chk_things WHERE id = ?').get(id);
  assert.deepEqual({ ...saved }, { title: 'phone edited', code: 'Y', n: 5 });
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM sync_steps WHERE record_id = ?', id), 1);

  // An update fix also starts from (and keeps) later edits of its own fields.
  phone.online = false;
  await phone.engine.update('thing', id, { code: 'X' }); // refused: taken
  await phone.engine.update('thing', id, { n: 6 });
  phone.online = true;
  await phone.engine.syncNow();
  const [badUpdate] = await phone.engine.attentionList();
  assert.deepEqual(badUpdate.latest, { code: 'X' });
  await phone.engine.fixAttention(badUpdate.n, { code: 'Z' });
  await phone.engine.syncNow();
  assert.deepEqual({ ...server.db.prepare('SELECT code, n FROM chk_things WHERE id = ?').get(id) }, { code: 'Z', n: 6 });
});

test('restore: a new generation re-sends the kept steps first, parks edits whose record is missing, pulls from scratch', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  const first = await startServer(t, config);
  const x = await makeDevice(t, first, 'owner');
  const y = await makeDevice(t, first, 'partner');
  const pre = await x.engine.create('item', { title: 'in the backup' });
  await settle(x.engine);
  await settle(y.engine);
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: null, keepDays: 30 });

  // After the backup: X makes an item, Y edits it; both are accepted (and kept on the devices).
  const after = await x.engine.create('item', { title: 'after the backup' });
  await x.engine.syncNow();
  await y.engine.syncNow();
  await y.engine.update('item', after, { phone: 'y-edit' });
  await y.engine.syncNow();
  // And X has a change it never got to send.
  x.online = false;
  const unsent = await x.engine.create('item', { title: 'made offline' });
  const oldGeneration = x.engine.status().generation;

  await first.close();
  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  const second = await startServer(t, config);
  x.server = second;
  y.server = second;

  // The restore ended every session: told so, the engine stops but keeps everything.
  await y.engine.syncNow();
  assert.equal(y.engine.status().phase, 'stopped');
  assert.deepEqual(y.lost, ['session_expired']);
  assert.equal((await storeContents(y.idbFactory)).sent.length, 1, 'kept steps survive a session_expired');

  // Y signs in again first (same device): its re-sent edit has no record yet, so it waits.
  y.signInAgain(second);
  const y2 = y.newEngine();
  await y2.start();
  await settle(y2);
  assert.notEqual(y2.status().generation, oldGeneration);
  assert.equal(y2.status().waiting, 1);
  assert.equal(y2.status().parked, 1);
  assert.equal((await y2.waitingList())[0].parked.code, 'not_found');
  assert.equal(y2.status().attention, 0, 'not_found is not a problem for the person yet');

  // X comes back: kept steps first (one duplicate, one applied again), then its unsent change.
  x.engine.stop();
  x.online = true;
  x.signInAgain(second);
  const x2 = x.newEngine();
  const pushed = [];
  const realPost = x.transport.post;
  x.transport.post = async (p, body) => {
    if (p === '/api/sync/push') pushed.push(...body.steps.map((s) => s.recordId));
    return realPost(p, body);
  };
  await x2.start();
  await settle(x2);
  assert.deepEqual(pushed, [pre, after, unsent], 'kept sent steps in order, then the outbox');
  assert.deepEqual(items(second.db).map((i) => i.title).sort(), ['after the backup', 'in the backup', 'made offline']);
  assert.equal((await x2.list('item')).length, 3);
  const xs = await storeContents(x.idbFactory);
  assert.equal(xs.outbox.length, 0);
  assert.ok(xs.sent.every((s) => s.generation === x2.status().generation));
  assert.ok(xs.meta.seen.startsWith(x2.status().generation));

  // Y's parked edit is retried after its next pull and applies.
  await y2.syncNow();
  assert.equal(y2.status().waiting, 0);
  assert.equal(row(second.db, 'syncdemo_items', after).phone, 'y-edit');
  assert.equal((await y2.get('item', after)).phone, 'y-edit');
});

test('device_signed_out: syncing stops and clearLocalData deletes everything, unsent changes included', async (t) => {
  const server = await startServer(t);
  const phone = await makeDevice(t, server, 'owner');
  await settle(phone.engine);
  phone.online = false;
  await phone.engine.create('item', { title: 'unsent 1' });
  await phone.engine.create('item', { title: 'unsent 2' });

  // The partner signs the phone out from the Devices page.
  server.ctx.services.auth.signOutDevice({ deviceId: phone.id, by: server.users.partner });
  phone.online = true;
  await phone.engine.syncNow();
  assert.equal(phone.engine.status().phase, 'stopped');
  assert.equal(phone.engine.status().stoppedBy, 'device_signed_out');
  assert.deepEqual(phone.lost, ['device_signed_out']);
  assert.equal(items(server.db).length, 0, 'nothing from the signed-out device was applied');
  const calls = phone.calls.length;
  await phone.engine.syncNow();
  assert.equal(phone.calls.length, calls, 'and it does not try again');

  // What the app does on that answer (auth/session.jsx): clearLocalData().
  const stored = new Map([['suite.deviceId', phone.id], ['suite.session', '{}'], ['suite.theme', 'dark']]);
  const deleted = [];
  const globals = {
    indexedDB: phone.idbFactory,
    localStorage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v), removeItem: (k) => stored.delete(k) },
    caches: { keys: async () => ['suite-shell-abc', 'suite-data-1'], delete: async (k) => deleted.push(k) },
  };
  const saved = Object.fromEntries(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  t.after(() => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  });
  // A second tab (offline) still has the database open: it is asked to close and does.
  phone.online = false;
  const otherTab = phone.newEngine();
  await otherTab.start();
  assert.equal(otherTab.status().phase, 'offline');
  const { clearLocalData } = await import('../src/auth/device.js');
  await clearLocalData();
  assert.equal(otherTab.status().phase, 'stopped', 'the other tab let go of the database');
  const store = await storeContents(phone.idbFactory);
  assert.deepEqual([store.records.length, store.outbox.length, store.sent.length, store.attention.length], [0, 0, 0, 0]);
  assert.deepEqual(store.meta, { hlc: undefined, seen: undefined, pull: undefined, generation: undefined });
  assert.deepEqual([...stored.keys()], ['suite.theme'], 'device id and remembered session gone, theme kept');
  assert.deepEqual(deleted, ['suite-data-1'], 'every cache but the public app shell');
});

test('session_expired: syncing stops but everything is kept, and after signing in again the outbox goes out', async (t) => {
  const server = await startServer(t);
  const phone = await makeDevice(t, server, 'owner');
  await settle(phone.engine);
  phone.online = false;
  const id = await phone.engine.create('item', { title: 'made while the session ran out' });
  server.db.prepare("UPDATE auth_sessions SET ended_at = ?, end_reason = 'expired' WHERE device_id = ?").run(new Date().toISOString(), phone.id);
  phone.online = true;
  await phone.engine.syncNow();
  assert.equal(phone.engine.status().stoppedBy, 'session_expired');
  assert.equal((await storeContents(phone.idbFactory)).outbox.length, 1);

  phone.signInAgain();
  const again = phone.newEngine();
  await again.start();
  await settle(again);
  assert.equal(again.status().waiting, 0);
  assert.equal(row(server.db, 'syncdemo_items', id).title, 'made while the session ran out');
});

test('a database left by another device id is dropped before use', async (t) => {
  const server = await startServer(t);
  const idbFactory = new IDBFactory();
  const owner = await makeDevice(t, server, 'owner', { idbFactory });
  await settle(owner.engine);
  owner.online = false;
  await owner.engine.create('item', { title: 'owner’s unsent change' });
  owner.engine.stop();
  // The partner signs in on the same browser (a new device id) without the old copy having been cleared.
  const partner = await makeDevice(t, server, 'partner', { idbFactory });
  await settle(partner.engine);
  assert.equal(partner.engine.status().waiting, 0);
  assert.deepEqual(await partner.engine.list('item'), []);
  assert.equal(items(server.db).length, 0);
});

test('a full disk is a SyncError (storage_full) and leaves nothing half-written', async (t) => {
  const server = await startServer(t);
  const phone = await makeDevice(t, server, 'owner');
  const before = await storeContents(phone.idbFactory);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function quota(...args) {
    if (this.name === 'outbox') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return put.apply(this, args);
  };
  try {
    await assert.rejects(phone.engine.create('item', { title: 'no room' }), (err) => err instanceof SyncError && err.code === 'storage_full');
  } finally {
    IDBObjectStore.prototype.put = put;
  }
  const after = await storeContents(phone.idbFactory);
  assert.equal(after.outbox.length, 0);
  assert.equal(after.meta.hlc, before.meta.hlc, 'the clock was not moved either (one transaction)');
  assert.equal(phone.engine.status().waiting, 0);
  assert.equal(storageError(new DOMException('x', 'DataError')).code, 'storage_error');
  const apiError = Object.assign(new Error('offline'), { status: 0 });
  assert.equal(storageError(apiError), apiError, 'API errors pass through');
});

test('change events name the record types that changed, so pages re-read only what they show', async (t) => {
  const server = await startServer(t);
  const a = await makeDevice(t, server, 'owner');
  const b = await makeDevice(t, server, 'partner');
  const seen = [];
  a.engine.subscribe((e) => e.type === 'data' && seen.push(e.entities));
  const itemId = await a.engine.create('item', { title: 'x' });
  assert.deepEqual(seen.at(-1), ['item']);
  seen.length = 0;
  await a.engine.syncNow();
  assert.ok(seen.length && seen.every((x) => Array.isArray(x) && x.every((n) => n === 'item')), JSON.stringify(seen));
  seen.length = 0;
  await a.engine.syncNow();
  assert.deepEqual(seen, [], 'a sync that brings nothing redraws nothing');
  await b.engine.syncNow();
  await b.engine.create('note', { item_id: itemId, body: 'n' });
  await b.engine.syncNow();
  await a.engine.syncNow();
  assert.deepEqual(seen, [['note']]);
  seen.length = 0;
  await a.engine.refetchAll();
  assert.ok(seen.includes(null), 'a pull from scratch can change anything');
});

test('the device clock being far off shows up in the status (and the sync bar)', async (t) => {
  const server = await startServer(t);
  const phone = await makeDevice(t, server, 'owner', { engine: { wallClock: () => Date.now() + 3_600_000 } });
  await phone.engine.create('item', { title: 'from the future' });
  await phone.engine.syncNow();
  assert.match(phone.engine.status().clockWarning ?? '', /clock is off by 3600 s/);
});

test('a connection lost while a sync finishes ends as offline, not "saved"', async (t) => {
  const server = await startServer(t);
  const phone = await makeDevice(t, server, 'owner');
  const get = phone.transport.get;
  phone.transport.get = async (path) => {
    const res = await get(path);
    if (path.startsWith('/api/sync/pull')) phone.online = false; // the 'offline' event arrives mid-cycle
    return res;
  };
  await phone.engine.syncNow();
  assert.equal(phone.engine.status().phase, 'offline');
});
