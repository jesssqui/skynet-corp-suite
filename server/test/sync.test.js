import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { newId } from '@suite/shared/ids';
import { createHlc, parseHlc } from '@suite/shared/hlc';
import { openDb } from '../src/db/open.js';
import { createApp } from '../src/app.js';
import { modules } from '../src/modules/index.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup } from '../src/backup/restore.js';
import syncdemo from './fixtures/syncdemo/index.js';
import { tmpDir, testConfig, quietLog } from './helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function startApp(t, config) {
  const db = openDb(config.dbPath);
  const { app, ctx } = await createApp({ config, db, log: quietLog, modules: [...modules, syncdemo] });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  let closed = false;
  const close = () => new Promise((resolve) => {
    if (closed) return resolve();
    closed = true;
    server.close(() => { db.close(); resolve(); });
  });
  t.after(close);
  return { db, ctx, close, base: `http://127.0.0.1:${server.address().port}` };
}

async function setup(t) {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  return { dir, config, ...(await startApp(t, config)) };
}

/**
 * A pretend phone or Mac: its own device id, HLC clock (wall clock can be skewed),
 * pull cursor, and helpers to make steps and talk to the server.
 */
function makeDevice(base, actor, { offsetMs = 0, wall } = {}) {
  const id = newId();
  const clock = createHlc(id, { wallClock: wall ?? (() => Date.now() + offsetMs) });
  const d = {
    id,
    actor,
    base,
    cursor: null,
    clock,
    headers() {
      return { 'content-type': 'application/json', 'x-suite-device': id, 'x-suite-actor': actor };
    },
    step(op, entity, recordId, fields) {
      return {
        key: newId(), entity, recordId, op,
        ...(fields ? { fields } : {}),
        hlc: clock.now(),
        ...(d.cursor ? { seen: d.cursor } : {}),
      };
    },
    async push(steps, extra = {}) {
      const res = await fetch(`${d.base}/api/sync/push`, {
        method: 'POST', headers: d.headers(), body: JSON.stringify({ steps, ...extra }),
      });
      const body = await res.json();
      if (res.ok) clock.receive(body.hlc);
      return { status: res.status, body, results: body.results };
    },
    async pullPage(since, limit) {
      const qs = new URLSearchParams();
      if (since) qs.set('since', since);
      if (limit) qs.set('limit', String(limit));
      const res = await fetch(`${d.base}/api/sync/pull?${qs}`, { headers: d.headers() });
      return { status: res.status, body: await res.json() };
    },
    /** Pull every page; the cursor only moves once the last page is in (that is what `seen` means). */
    async pull(limit) {
      const records = new Map();
      const pages = [];
      let since = d.cursor;
      for (;;) {
        const { status, body } = await d.pullPage(since, limit);
        assert.equal(status, 200, JSON.stringify(body));
        pages.push(body);
        clock.receive(body.hlc);
        for (const c of body.changes) records.set(`${c.entity}/${c.id}`, c);
        since = body.cursor;
        if (!body.hasMore) break;
      }
      d.cursor = since;
      return { records, pages };
    },
  };
  return d;
}

const one = async (dev, step) => (await dev.push([step])).results[0];
const rowOf = (db, id) => db.prepare('SELECT * FROM syncdemo_items WHERE id = ?').get(id);
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}
async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/** Owner's phone makes an item; both devices pull so they start from the same state. */
async function sharedItem(t, opts = {}) {
  const env = await setup(t);
  const a = makeDevice(env.base, 'owner', opts.a);
  const b = makeDevice(env.base, 'partner', opts.b);
  const itemId = newId();
  const created = await one(a, a.step('create', 'item', itemId, { title: 'Lefty’s', phone: '5195550100', qty: 1 }));
  assert.equal(created.status, 'applied');
  await a.pull();
  await b.pull();
  return { ...env, a, b, itemId };
}

// ---------------------------------------------------------------- Done-when

test('a repeated step applies once (same push resent, and twice in one push)', async (t) => {
  const { base, db } = await setup(t);
  const a = makeDevice(base, 'owner');
  const itemId = newId();
  const create = a.step('create', 'item', itemId, { title: 'Box of tins', qty: 2 });
  const note = a.step('create', 'note', newId(), { item_id: itemId, body: 'Called, wants 3 more' });

  const first = await a.push([create, note]);
  assert.deepEqual(first.results.map((r) => r.status), ['applied', 'applied']);

  // The phone lost the response and sends the whole outbox again, plus the note a third time.
  const again = await a.push([create, note, note]);
  assert.deepEqual(again.results.map((r) => r.status), ['duplicate', 'duplicate', 'duplicate']);
  assert.equal(again.results[0].seq, first.results[0].seq);
  assert.equal(again.results[0].original, 'applied');
  assert.equal(again.body.seq, first.body.seq, 'no new changes');

  assert.equal(count(db, 'SELECT count(*) AS n FROM syncdemo_items'), 1);
  assert.equal(count(db, 'SELECT count(*) AS n FROM syncdemo_notes'), 1);
  assert.equal(count(db, 'SELECT count(*) AS n FROM sync_steps'), 2);

  // A repeated update doesn't apply twice either (it would otherwise re-stamp and re-clash).
  const upd = a.step('update', 'item', itemId, { qty: 5 });
  assert.equal((await one(a, upd)).status, 'applied');
  assert.equal((await one(a, upd)).status, 'duplicate');
  assert.equal(count(db, 'SELECT count(*) AS n FROM sync_steps'), 3);

  // The same key can't be reused for a different change.
  const reused = await one(a, { ...a.step('update', 'item', newId(), { qty: 1 }), key: create.key });
  assert.equal(reused.status, 'rejected');
  assert.equal(reused.code, 'key_reused');
});

test('steps from two devices merge: different fields both apply, notes add up', async (t) => {
  const { a, b, itemId, db } = await sharedItem(t);

  // Both offline, each changes a different detail of the same record and adds a note.
  const aSteps = [
    a.step('update', 'item', itemId, { title: 'Lefty’s Cannabis' }),
    a.step('create', 'note', newId(), { item_id: itemId, body: 'Owner: visited the shop' }),
  ];
  const bSteps = [
    b.step('update', 'item', itemId, { phone: '5195550199', done: true }),
    b.step('create', 'note', newId(), { item_id: itemId, body: 'Partner: packed order' }),
  ];
  assert.deepEqual((await b.push(bSteps)).results.map((r) => r.status), ['applied', 'applied']);
  assert.deepEqual((await a.push(aSteps)).results.map((r) => r.status), ['applied', 'applied']);

  const row = rowOf(db, itemId);
  assert.equal(row.title, 'Lefty’s Cannabis');
  assert.equal(row.phone, '5195550199');
  assert.equal(row.done, 1);
  assert.equal(row.updated_by, 'owner');
  assert.equal(count(db, 'SELECT count(*) AS n FROM syncdemo_notes WHERE item_id = ?', itemId), 2);
  assert.equal(count(db, 'SELECT count(*) AS n FROM sync_clashes'), 0);

  // Both devices converge on the same record when they pull.
  const fromA = (await a.pull()).records.get(`item/${itemId}`);
  const fromB = (await b.pull()).records.get(`item/${itemId}`);
  assert.deepEqual(fromA.fields, fromB.fields);
  assert.deepEqual(fromA.fields, { title: 'Lefty’s Cannabis', phone: '5195550199', qty: 1, done: true, due: null, status: null });
  assert.deepEqual(fromA.clashes, []);
});

test('same-field clash: the later change wins and the other is kept for review (either arrival order)', async (t) => {
  for (const order of ['earlier-first', 'later-first']) {
    // Owner's clock reads 10 s earlier than the partner's, so the partner's edit is "later".
    const { a, b, itemId, db, base } = await sharedItem(t, { a: { offsetMs: -10_000 } });
    const early = a.step('update', 'item', itemId, { phone: '5195550111' });
    const late = b.step('update', 'item', itemId, { phone: '5195550222' });
    const [first, second] = order === 'earlier-first' ? [[a, early], [b, late]] : [[b, late], [a, early]];

    assert.equal((await one(...first)).status, 'applied', order);
    const r = await one(...second);
    assert.equal(r.status, 'clash', order);
    assert.equal(r.clashes.length, 1);
    if (order === 'earlier-first') assert.deepEqual(r.applied, ['phone']);
    else assert.deepEqual(r.lost, ['phone']);

    assert.equal(rowOf(db, itemId).phone, '5195550222', `${order}: later change kept`);
    const { body } = await getJson(`${base}/api/sync/clashes`);
    assert.equal(body.clashes.length, 1);
    const c = body.clashes[0];
    assert.equal(c.kind, 'field');
    assert.equal(c.field, 'phone');
    assert.equal(c.winner.value, '5195550222');
    assert.equal(c.winner.actor, 'partner');
    assert.equal(c.loser.value, '5195550111');
    assert.equal(c.loser.actor, 'owner');
    assert.ok(c.loser.at < c.winner.at, 'both times kept');
    assert.equal(c.resolved, false);

    // The clash travels with the record, so each device can show it on the record.
    const pulled = (await a.pull()).records.get(`item/${itemId}`);
    assert.equal(pulled.fields.phone, '5195550222');
    assert.equal(pulled.clashes[0].loser.value, '5195550111');
  }
});

test('a clash can be settled: keep the other value, or keep what won', async (t) => {
  const { a, b, itemId, db, base } = await sharedItem(t, { a: { offsetMs: -10_000 } });
  await one(a, a.step('update', 'item', itemId, { phone: '111', title: 'A title' }));
  await one(b, b.step('update', 'item', itemId, { phone: '222', title: 'B title' }));
  const clashes = (await getJson(`${base}/api/sync/clashes`)).body.clashes;
  assert.equal(clashes.length, 2);
  const phone = clashes.find((c) => c.field === 'phone');
  const title = clashes.find((c) => c.field === 'title');
  const url = (c) => `${base}/api/sync/clashes/${c.id}/resolve`;

  const keepOther = await postJson(url(phone), { resolution: 'keep_loser' }, a.headers());
  assert.equal(keepOther.status, 200, JSON.stringify(keepOther.body));
  assert.equal(keepOther.body.clash.resolution, 'keep_loser');
  assert.equal(keepOther.body.clash.resolvedBy, 'owner');
  assert.equal(rowOf(db, itemId).phone, '111');

  const keep = await postJson(url(title), { resolution: 'keep_winner' }, b.headers());
  assert.equal(keep.status, 200);
  assert.equal(rowOf(db, itemId).title, 'B title');

  // Same answer again is fine; a different answer is refused.
  assert.equal((await postJson(url(title), { resolution: 'keep_winner' }, b.headers())).body.alreadyResolved, true);
  assert.equal((await postJson(url(title), { resolution: 'keep_loser' }, b.headers())).status, 409);
  assert.equal((await getJson(`${base}/api/sync/clashes`)).body.clashes.length, 0);
  assert.equal((await getJson(`${base}/api/sync/clashes?status=all`)).body.clashes.length, 2);

  // Devices see the settled value.
  const pulled = (await b.pull()).records.get(`item/${itemId}`);
  assert.equal(pulled.fields.phone, '111');
  assert.deepEqual(pulled.clashes, []);
});

test('delete against an edit keeps the record, flags it and records a clash (either arrival order)', async (t) => {
  for (const order of ['delete-first', 'edit-first']) {
    const { a, b, itemId, db, base } = await sharedItem(t);
    const del = a.step('delete', 'item', itemId);
    const edit = b.step('update', 'item', itemId, { qty: 9 });

    if (order === 'delete-first') {
      assert.equal((await one(a, del)).status, 'applied');
      assert.ok(rowOf(db, itemId).deleted_at, 'deleted until the edit arrives');
      const r = await one(b, edit);
      assert.equal(r.status, 'clash');
      assert.deepEqual(r.applied, ['qty']);
    } else {
      assert.equal((await one(b, edit)).status, 'applied');
      const r = await one(a, del);
      assert.equal(r.status, 'clash');
      assert.equal(r.kept, true);
    }

    const row = rowOf(db, itemId);
    assert.equal(row.deleted_at, null, `${order}: record kept`);
    assert.equal(row.flagged, 1, `${order}: record flagged`);
    assert.equal(row.qty, 9, `${order}: the edit is in`);
    const clashes = (await getJson(`${base}/api/sync/clashes`)).body.clashes;
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0].kind, 'delete');
    assert.equal(clashes[0].loser.actor, 'owner', 'the delete is what lost');
    assert.equal(clashes[0].winner.actor, 'partner');

    const pulled = (await a.pull()).records.get(`item/${itemId}`);
    assert.equal(pulled.deleted, false);
    assert.equal(pulled.flagged, true);
    assert.equal(pulled.clashes[0].kind, 'delete');
  }
});

test('a flagged record can be kept (unflagged) or deleted after all', async (t) => {
  const { a, b, itemId, db, base } = await sharedItem(t);
  await one(a, a.step('delete', 'item', itemId));
  await one(b, b.step('update', 'item', itemId, { qty: 9 }));
  const [c] = (await getJson(`${base}/api/sync/clashes`)).body.clashes;
  const r = await postJson(`${base}/api/sync/clashes/${c.id}/resolve`, { resolution: 'keep_winner' }, a.headers());
  assert.equal(r.status, 200);
  assert.equal(rowOf(db, itemId).flagged, 0);
  assert.equal((await a.pull()).records.get(`item/${itemId}`).flagged, false);

  // Second time, delete after all.
  await b.pull();
  await one(a, a.step('delete', 'item', itemId));
  await one(b, b.step('update', 'item', itemId, { qty: 10 }));
  const [c2] = (await getJson(`${base}/api/sync/clashes`)).body.clashes;
  const r2 = await postJson(`${base}/api/sync/clashes/${c2.id}/resolve`, { resolution: 'keep_loser' }, b.headers());
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.ok(rowOf(db, itemId).deleted_at);
  const pulled = (await b.pull()).records.get(`item/${itemId}`);
  assert.equal(pulled.deleted, true);
});

// ---------------------------------------------------------------- ordering and clocks

test('an edit made after seeing the other change is not a clash; deleting what you have seen just deletes', async (t) => {
  const { a, b, itemId, db } = await sharedItem(t, { b: { offsetMs: -HOUR } }); // partner's clock is an hour slow
  await one(a, a.step('update', 'item', itemId, { phone: '111' }));
  await b.pull(); // partner sees it, then changes it again
  const r = await one(b, b.step('update', 'item', itemId, { phone: '222' }));
  assert.equal(r.status, 'applied', 'saw it first, so no clash, even with a slow clock');
  assert.equal(rowOf(db, itemId).phone, '222');

  await a.pull();
  assert.equal((await one(a, a.step('delete', 'item', itemId))).status, 'applied');
  assert.ok(rowOf(db, itemId).deleted_at);
  assert.equal(count(db, 'SELECT count(*) AS n FROM sync_clashes'), 0);
  // An edit from a device that already knew about the delete is refused (it goes to needs attention).
  await b.pull();
  const late = await one(b, b.step('update', 'item', itemId, { qty: 3 }));
  assert.equal(late.status, 'rejected');
  assert.equal(late.code, 'deleted');
});

test('ordering: steps apply in the order sent, each device in stamp order, a device offline for days loses to newer edits', async (t) => {
  const { base, db } = await setup(t);
  const a = makeDevice(base, 'owner');
  const itemId = newId();
  const create = a.step('create', 'item', itemId, { title: 'x' });
  const update = a.step('update', 'item', itemId, { qty: 1 });

  // Update before its create in one push: update rejected (not there yet), create applied.
  const res = await a.push([update, create]);
  assert.deepEqual(res.results.map((r) => r.status), ['rejected', 'applied']);
  assert.equal(res.results[0].code, 'not_found');

  // An older change from the same device arriving after a newer one doesn't overwrite that field
  // (it is "stale", not a clash), but its other fields still apply.
  const s1 = a.step('update', 'item', itemId, { qty: 2, phone: 'from s1' });
  const s2 = a.step('update', 'item', itemId, { qty: 3 });
  const r = await a.push([s2, s1]);
  assert.deepEqual(r.results.map((x) => x.status), ['applied', 'applied']);
  assert.deepEqual(r.results[1].stale, ['qty']);
  assert.deepEqual(r.results[1].applied, ['phone']);
  assert.equal(rowOf(db, itemId).qty, 3);
  assert.equal(rowOf(db, itemId).phone, 'from s1');
  assert.ok(r.results[0].seq > res.results[1].seq, 'server sequence increases');
  // A rejected step can be retried unchanged once it can apply (here: after its create arrives).
  const laterId = newId();
  const createLater = a.step('create', 'item', laterId, { title: 'later' });
  const early = a.step('update', 'item', laterId, { qty: 1 }); // made after the create, sent before it
  assert.equal((await one(a, early)).code, 'not_found');
  assert.equal((await one(a, createLater)).status, 'applied');
  const retried = await one(a, early);
  assert.equal(retried.status, 'applied');
  assert.equal(rowOf(db, laterId).qty, 1);

  // Offline for days: the owner's phone pulled and went offline two days ago and edited
  // then; the partner edited since. The phone reconnects today: the partner's edit is later, so it wins.
  const phone = makeDevice(base, 'owner');
  const mac = makeDevice(base, 'partner');
  await phone.pull();
  await mac.pull();
  const twoDaysAgo = createHlc(phone.id, { wallClock: () => Date.now() - 2 * DAY }).now();
  const offlineEdit = { ...phone.step('update', 'item', itemId, { title: 'Monday title' }), hlc: twoDaysAgo };
  assert.equal((await one(mac, mac.step('update', 'item', itemId, { title: 'Tuesday title' }))).status, 'applied');
  const late = await one(phone, offlineEdit);
  assert.equal(late.status, 'clash');
  assert.deepEqual(late.lost, ['title']);
  assert.equal(rowOf(db, itemId).title, 'Tuesday title');
  const c = (await getJson(`${base}/api/sync/clashes`)).body.clashes[0];
  assert.equal(c.loser.value, 'Monday title', 'the offline edit is kept for review, not dropped');
});

test('a device clock set far in the future is clamped to server time and cannot win every clash', async (t) => {
  const { a, itemId, db, base } = await sharedItem(t, { a: { offsetMs: 365 * DAY } });
  const c = makeDevice(base, 'partner');
  await c.pull();
  const future = await one(a, a.step('update', 'item', itemId, { phone: 'future' }));
  assert.equal(future.status, 'applied');
  assert.ok(future.hlc, 'stamp was replaced');
  assert.ok(Math.abs(parseHlc(future.hlc).ms - Date.now()) < 60_000);
  assert.equal(parseHlc(future.hlc).node, a.id);

  await new Promise((r) => setTimeout(r, 5));
  const now = await one(c, c.step('update', 'item', itemId, { phone: 'now' }));
  assert.equal(now.status, 'clash');
  assert.deepEqual(now.applied, ['phone'], 'a correct clock made later wins');
  assert.equal(rowOf(db, itemId).phone, 'now');
  const skew = await a.push([], { deviceTime: new Date(Date.now() + 365 * DAY).toISOString() });
  assert.match(skew.body.clockWarning, /clock is off/);
});

// ---------------------------------------------------------------- pull, paging, bookmarks

test('pull pages through changes with a cursor and returns only what changed since', async (t) => {
  const { base, db } = await setup(t);
  const a = makeDevice(base, 'owner');
  const b = makeDevice(base, 'partner');
  const ids = Array.from({ length: 25 }, () => newId());
  const res = await a.push(ids.map((id, i) => a.step('create', 'item', id, { title: `Item ${i}` })));
  assert.ok(res.results.every((r) => r.status === 'applied'));

  // Page 1 of 3, then something changes mid-way: the changed record moves to a later page, never lost.
  const p1 = await b.pullPage(null, 10);
  assert.equal(p1.body.reset, true);
  assert.equal(p1.body.hasMore, true);
  assert.equal(p1.body.changes.length, 10);
  assert.equal((await one(a, a.step('update', 'item', ids[0], { qty: 7 }))).status, 'applied');
  const p2 = await b.pullPage(p1.body.cursor, 10);
  const p3 = await b.pullPage(p2.body.cursor, 10);
  assert.equal(p2.body.reset, false);
  assert.equal(p3.body.hasMore, false);
  const seen = [...p1.body.changes, ...p2.body.changes, ...p3.body.changes];
  assert.equal(new Set(seen.map((c) => c.id)).size, 25);
  const latest = [...seen].reverse().find((c) => c.id === ids[0]);
  assert.equal(latest.fields.qty, 7, 'the changed record arrived again with its new value');
  const seqs = seen.map((c) => c.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));

  // The device's bookmark is stored.
  const dev = db.prepare('SELECT * FROM sync_devices WHERE device_id = ?').get(b.id);
  assert.equal(dev.last_pull_cursor, p3.body.cursor);
  assert.equal(dev.actor, 'partner');

  // Nothing new: empty page, same cursor.
  const empty = await b.pullPage(p3.body.cursor);
  assert.deepEqual(empty.body.changes, []);
  assert.equal(empty.body.cursor, p3.body.cursor);

  // A change and a delete show up, nothing else.
  await one(a, a.step('update', 'item', ids[3], { status: 'won' }));
  await one(a, a.step('delete', 'item', ids[4]));
  const next = await b.pullPage(p3.body.cursor);
  assert.deepEqual(next.body.changes.map((c) => [c.id, c.deleted]), [[ids[3], false], [ids[4], true]]);
  assert.equal(next.body.changes[0].fields.status, 'won');
  assert.equal(next.body.changes[1].fields, undefined, 'a delete carries no data');

  assert.equal((await b.pullPage('nonsense')).status, 400);
  assert.equal((await b.pullPage(null, 5000)).status, 400);
});

test('server code writes through the same path (applyLocal) and devices pull it', async (t) => {
  const { ctx, db, base } = await setup(t);
  const made = ctx.services.sync.applyLocal({ actor: 'owner', entity: 'item', op: 'create', fields: { title: 'Imported' } });
  assert.equal(made.status, 'applied');
  assert.equal(rowOf(db, made.recordId).created_by, 'owner');
  const dev = makeDevice(base, 'partner');
  const { records } = await dev.pull();
  assert.equal(records.get(`item/${made.recordId}`).fields.title, 'Imported');
  assert.deepEqual(ctx.services.sync.recordState('item', made.recordId), { deleted: false, flagged: false, clashes: [] });
});

// ---------------------------------------------------------------- restore generation

test('restoring a backup starts a new generation: old cursors reset, resent steps apply once', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  const first = await startApp(t, config);
  const a = makeDevice(first.base, 'owner');
  const keep = a.step('create', 'item', newId(), { title: 'In the backup' });
  await a.push([keep]);
  const info1 = (await getJson(`${first.base}/api/sync/info`)).body;

  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: null, keepDays: 30 });
  const lost = a.step('create', 'item', newId(), { title: 'After the backup' });
  await a.push([lost]);
  await a.pull();
  const oldCursor = a.cursor;
  await first.close();

  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  const second = await startApp(t, config);
  a.base = second.base;
  const info2 = (await getJson(`${second.base}/api/sync/info`)).body;
  assert.notEqual(info2.generation, info1.generation);
  assert.ok(info2.lastRestoreAt);
  assert.equal(second.db.prepare("SELECT count(*) AS n FROM sync_meta WHERE key = 'restore_pending'").get().n, 0);

  // The device's old cursor no longer means anything: it is told to start again.
  const page = await a.pullPage(oldCursor);
  assert.equal(page.body.reset, true);
  assert.equal(page.body.generation, info2.generation);
  assert.equal(page.body.changes.length, 1);

  // It re-sends the steps it kept: the one in the backup is a duplicate, the lost one applies again.
  const resent = await a.push([keep, lost]);
  assert.deepEqual(resent.results.map((r) => r.status), ['duplicate', 'applied']);
  assert.equal(count(second.db, 'SELECT count(*) AS n FROM syncdemo_items'), 2);

  // A restart without a restore keeps the generation.
  await second.close();
  const third = await startApp(t, config);
  assert.equal((await getJson(`${third.base}/api/sync/info`)).body.generation, info2.generation);
});

// ---------------------------------------------------------------- validation

test('validation: unknown entities and fields, bad ids, bad values, oversized payloads', async (t) => {
  const { base, db } = await setup(t);
  const a = makeDevice(base, 'owner');
  const itemId = newId();
  await one(a, a.step('create', 'item', itemId, { title: 'ok' }));

  const cases = [
    ['unknown entity', a.step('create', 'gizmo', newId(), { title: 'x' }), 'unknown_entity'],
    ['another module table name', a.step('create', 'health_meta', newId(), { key: 'x', value: 'y' }), 'unknown_entity'],
    ['unknown field', a.step('update', 'item', itemId, { title: 'x', is_admin: true }), 'unknown_field'],
    ['sync-owned column', a.step('update', 'item', itemId, { deleted_at: null }), 'unknown_field'],
    ['standard column', a.step('update', 'item', itemId, { created_by: 'partner' }), 'unknown_field'],
    ['record id not a UUIDv7', a.step('create', 'item', '42', { title: 'x' }), 'invalid_step'],
    ['uppercase id', a.step('create', 'item', newId().toUpperCase(), { title: 'x' }), 'invalid_step'],
    ['key not a UUIDv7', { ...a.step('update', 'item', itemId, { qty: 1 }), key: 'abc' }, 'invalid_step'],
    ['wrong type', a.step('update', 'item', itemId, { qty: '3' }), 'invalid_value'],
    ['not a whole number', a.step('update', 'item', itemId, { qty: 1.5 }), 'invalid_value'],
    ['bad date', a.step('update', 'item', itemId, { due: '2026-02-30' }), 'invalid_value'],
    ['bad enum', a.step('update', 'item', itemId, { status: 'maybe' }), 'invalid_value'],
    ['text too long', a.step('update', 'item', itemId, { title: 'x'.repeat(201) }), 'invalid_value'],
    ['required missing', a.step('create', 'item', newId(), { qty: 1 }), 'invalid_value'],
    ['required cleared', a.step('update', 'item', itemId, { title: null }), 'invalid_value'],
    ['empty update', a.step('update', 'item', itemId, {}), 'invalid_step'],
    ['fields on delete', a.step('delete', 'item', itemId, { title: 'x' }), 'invalid_step'],
    ['append-only update', a.step('update', 'note', newId(), { body: 'x' }), 'op_not_allowed'],
    ['bad op', { ...a.step('update', 'item', itemId, { qty: 1 }), op: 'drop' }, 'invalid_step'],
    ['extra property', { ...a.step('update', 'item', itemId, { qty: 1 }), table: 'health_meta' }, 'invalid_step'],
    ['stamp from another device', { ...a.step('update', 'item', itemId, { qty: 1 }), hlc: createHlc(newId()).now() }, 'invalid_step'],
    ['seen from another generation', { ...a.step('update', 'item', itemId, { qty: 1 }), seen: `${newId()}.1` }, null],
    ['oversized step', a.step('create', 'note', newId(), { item_id: itemId, body: 'x'.repeat(70_000) }), 'too_large'],
    ['note on missing item (foreign key)', a.step('create', 'note', newId(), { item_id: newId(), body: 'x' }), 'constraint'],
    ['create twice', a.step('create', 'item', itemId, { title: 'again' }), 'already_exists'],
    ['not an object', 'step', 'invalid_step'],
  ];
  const res = await a.push(cases.map((c) => c[1]));
  assert.equal(res.status, 200);
  res.results.forEach((r, i) => {
    const [name, , code] = cases[i];
    if (code === null) {
      // A cursor from another generation is treated as "saw nothing", not an error.
      assert.equal(r.status, 'applied', name);
    } else {
      assert.equal(r.status, 'rejected', `${name}: ${JSON.stringify(r)}`);
      assert.equal(r.code, code, `${name}: ${r.reason}`);
      assert.ok(r.reason);
    }
  });
  const sameGenAhead = (await getJson(`${base}/api/sync/info`)).body.generation;
  const ahead = await one(a, { ...a.step('update', 'item', itemId, { qty: 2 }), seen: `${sameGenAhead}.99999` });
  assert.equal(ahead.code, 'invalid_step');
  assert.equal(rowOf(db, itemId).title, 'ok', 'nothing rejected was written');

  // Request-level problems.
  const push = (body, headers) => postJson(`${base}/api/sync/push`, body, headers);
  assert.equal((await push({ steps: [] }, { 'x-suite-actor': 'owner' })).status, 400, 'no device id');
  assert.equal((await push({ steps: [] }, { 'x-suite-device': 'phone-1', 'x-suite-actor': 'owner' })).status, 400, 'device id not a UUIDv7');
  assert.equal((await push({ steps: [] }, { 'x-suite-device': newId(), 'x-suite-actor': 'stranger' })).status, 400, 'unknown actor');
  assert.equal((await push({ steps: [], deviceId: newId() }, a.headers())).status, 400, 'two different device ids');
  assert.equal((await push({ steps: 'x' }, a.headers())).status, 400);
  assert.equal((await push({ steps: [] }, { ...a.headers(), 'x-suite-actor': 'partner' })).status, 403, 'a device belongs to one person');
  const tooMany = Array.from({ length: 501 }, () => a.step('update', 'item', itemId, { qty: 1 }));
  assert.equal((await push({ steps: tooMany }, a.headers())).status, 413);
  const huge = await fetch(`${base}/api/sync/push`, {
    method: 'POST', headers: a.headers(), body: JSON.stringify({ steps: [], pad: 'x'.repeat(1_100_000) }),
  });
  assert.equal(huge.status, 413);
  const serverDevice = db.prepare("SELECT value FROM sync_meta WHERE key = 'server_device_id'").get().value;
  assert.equal((await push({ steps: [] }, { 'x-suite-device': serverDevice, 'x-suite-actor': 'owner' })).status, 403);
  // The same identity can come in the body instead of headers (until C1).
  const viaBody = await postJson(`${base}/api/sync/push`, { deviceId: newId(), actor: 'partner', steps: [] });
  assert.equal(viaBody.status, 200);
});

test('module tables are written only through sync, and only a module\'s own tables can be registered', async (t) => {
  const { ctx, db } = await setup(t);
  const item = ctx.services.sync.applyLocal({ entity: 'item', op: 'create', fields: { title: 'real' } });
  ctx.services.sync.applyLocal({ entity: 'note', op: 'create', fields: { item_id: item.recordId, body: 'n' } });
  assert.equal(rowOf(db, item.recordId).created_by, 'system');
  assert.throws(() => db.prepare("INSERT INTO syncdemo_items (id, title) VALUES (?, 'sneaky')").run(newId()),
    /written only through the sync module/);
  assert.throws(() => db.prepare("UPDATE syncdemo_items SET title = 'x'").run(), /only through the sync module/);
  assert.throws(() => db.prepare('DELETE FROM syncdemo_notes').run(), /only through the sync module/);

  const sync = ctx.services.sync;
  const base = { module: 'syncdemo', entity: 'thing', fields: { title: { type: 'text' } } };
  assert.throws(() => sync.registerEntity({ ...base, table: 'health_meta' }), /does not belong to module/);
  assert.throws(() => sync.registerEntity({ ...base, module: 'sync', table: 'sync_steps' }), /can't be synced/);
  assert.throws(() => sync.registerEntity({ ...base, entity: 'item', table: 'syncdemo_items' }), /already registered/);
  assert.throws(() => sync.registerEntity({ ...base, table: 'syncdemo_missing' }), /does not exist/);
  assert.throws(() => sync.registerEntity({ ...base, table: 'syncdemo_items', fields: { nope: { type: 'text' } } }), /no column nope/);
  assert.throws(() => sync.registerEntity({ ...base, table: 'syncdemo_items', fields: { title: { type: 'blob' } } }), /unknown type/);
  assert.throws(() => sync.registerEntity({ ...base, table: 'syncdemo_items', fields: { flagged: { type: 'boolean' } } }), /bad field name/);
  assert.throws(() => sync.registerEntity({ ...base, table: 'syncdemo_items', ops: ['update'] }), /'create' must be allowed/);

  const info = sync.info();
  assert.deepEqual(info.entities.map((e) => e.entity), ['item', 'note']);
  assert.deepEqual(info.entities[1].ops, ['create']);
  assert.equal(info.entities[1].appendOnly, true);
});

// ---------------------------------------------------------------- review regressions (C2a review probes)

test('P1: a delete by a device that never saw a concurrent edit is flagged, even when that edit lost a field clash', async (t) => {
  const { a, b, itemId, db, base } = await sharedItem(t);
  const bStep = b.step('update', 'item', itemId, { phone: 'B-phone', qty: 7 });
  await new Promise((r) => setTimeout(r, 5));
  const aStep = a.step('update', 'item', itemId, { phone: 'A-phone', qty: 9 });
  assert.equal((await one(a, aStep)).status, 'applied');
  const bRes = await one(b, bStep);
  assert.equal(bRes.status, 'clash');
  assert.deepEqual(bRes.lost.sort(), ['phone', 'qty'], 'B lost every field: no field version of B survives');

  // A deletes without pulling: it never saw B's edit.
  const del = await one(a, a.step('delete', 'item', itemId));
  assert.equal(del.status, 'clash');
  assert.equal(del.kept, true);
  const row = rowOf(db, itemId);
  assert.equal(row.deleted_at, null);
  assert.equal(row.flagged, 1);
  const open = (await getJson(`${base}/api/sync/clashes`)).body.clashes;
  assert.deepEqual(open.map((c) => c.kind).sort(), ['delete', 'field', 'field'], 'B\'s field clashes stay open');
  const d = open.find((c) => c.kind === 'delete');
  assert.equal(d.winner.actor, 'partner');
  assert.equal(d.winner.step, bStep.key);
});

test('a delete that applies after seeing every edit settles the record\'s delete clashes', async (t) => {
  const { a, b, itemId, db, base } = await sharedItem(t);
  const c = makeDevice(base, 'partner');
  await c.pull();
  assert.equal((await one(c, c.step('update', 'item', itemId, { qty: 5 }))).status, 'applied');
  await a.pull(); // A sees C's edit, not B's delete below
  const bDel = await one(b, b.step('delete', 'item', itemId)); // B never saw C's edit: kept + flagged
  assert.equal(bDel.status, 'clash');
  const aDel = await one(a, a.step('delete', 'item', itemId));
  assert.equal(aDel.status, 'applied', 'A had seen every edit, so the delete goes through');
  assert.ok(rowOf(db, itemId).deleted_at);
  const clashes = (await getJson(`${base}/api/sync/clashes?status=all`)).body.clashes;
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].kind, 'delete');
  assert.equal(clashes[0].resolution, 'superseded', 'the record is deleted either way, so B\'s delete clash is moot');
});

test('Q3: a delete that applies settles open delete clashes on the record, even ones it had not seen', async (t) => {
  const { a, b, itemId, db, base } = await sharedItem(t);
  const bDel = b.step('delete', 'item', itemId);
  assert.equal((await one(a, a.step('update', 'item', itemId, { phone: 'A' }))).status, 'applied');
  assert.equal((await one(b, bDel)).status, 'clash'); // B's delete loses to A's edit: kept + flagged
  const aDel = await one(a, a.step('delete', 'item', itemId)); // A never saw B's delete
  assert.equal(aDel.status, 'applied');
  assert.ok(rowOf(db, itemId).deleted_at);
  assert.deepEqual((await getJson(`${base}/api/sync/clashes`)).body.clashes, [], 'no unresolvable clash left open');
  const [c] = (await getJson(`${base}/api/sync/clashes?status=all`)).body.clashes;
  assert.equal(c.kind, 'delete');
  assert.equal(c.resolution, 'superseded');
});

test('Q6: a late older change from a device whose clock runs ahead does not overwrite its newer one', async (t) => {
  const { itemId, db, base } = await sharedItem(t);
  const f = makeDevice(base, 'owner', { offsetMs: HOUR }); // ahead: every stamp gets clamped on arrival
  await f.pull();
  const s1 = f.step('update', 'item', itemId, { phone: 'f-one' });
  const s2 = f.step('update', 'item', itemId, { phone: 'f-two' });
  const r2 = await one(f, s2);
  assert.equal(r2.status, 'applied');
  assert.ok(r2.hlc, 'clamped');
  await new Promise((r) => setTimeout(r, 5));
  const r1 = await one(f, s1); // clamped to a later server time than s2 was
  assert.equal(r1.status, 'applied');
  assert.deepEqual(r1.stale, ['phone']);
  assert.equal(rowOf(db, itemId).phone, 'f-two');
});

test('P2: the same step pushed twice at the same moment applies once', async (t) => {
  const { base, db } = await setup(t);
  const a = makeDevice(base, 'owner');
  const s = a.step('create', 'item', newId(), { title: 'x' });
  const [r1, r2] = await Promise.all([a.push([s]), a.push([s])]);
  assert.deepEqual([r1.results[0].status, r2.results[0].status].sort(), ['applied', 'duplicate']);
  assert.equal(count(db, 'SELECT count(*) AS n FROM syncdemo_items'), 1);
});

async function restoredPair(t) {
  const env = await setup(t);
  const x = makeDevice(env.base, 'owner');
  const y = makeDevice(env.base, 'partner');
  const pre = newId();
  await one(x, x.step('create', 'item', pre, { title: 'pre', phone: '1' }));
  await x.pull();
  await y.pull();
  const backup = await runBackup({ db: env.db, dir: env.config.backup.dir, offsiteDir: null, keepDays: 30 });
  return { env, x, y, pre, backup };
}

async function restore(t, env, backup, devices) {
  await env.close();
  await restoreBackup({ from: backup.file, dbPath: env.config.dbPath, backupDir: env.config.backup.dir });
  const env2 = await startApp(t, env.config);
  for (const d of devices) d.base = env2.base;
  return env2;
}

test('P7: after a restore, re-sent edits and deletes made with an old cursor are not clashes', async (t) => {
  const { env, x, y, pre } = await restoredPair(t);
  const other = newId();
  await one(x, x.step('create', 'item', other, { title: 'other' }));
  await x.pull();
  await y.pull();
  const backup2 = await runBackup({ db: env.db, dir: env.config.backup.dir, offsiteDir: null, keepDays: 30 });
  const sy = [y.step('update', 'item', pre, { phone: 'y' }), y.step('delete', 'item', other)];
  assert.deepEqual((await y.push(sy)).results.map((r) => r.status), ['applied', 'applied']);

  const env2 = await restore(t, env, backup2, [x, y]);
  const resent = await y.push(sy);
  assert.deepEqual(resent.results.map((r) => r.status), ['applied', 'applied'], JSON.stringify(resent.results));
  assert.equal(rowOf(env2.db, pre).phone, 'y');
  assert.ok(rowOf(env2.db, other).deleted_at, 'the re-sent delete of the other person\'s record is not flagged');
  assert.equal(count(env2.db, 'SELECT count(*) AS n FROM sync_clashes'), 0);

  // The replaced generation and how far the restored copy goes are remembered.
  const prev = JSON.parse(env2.db.prepare("SELECT value FROM sync_meta WHERE key = 'previous_generations'").get().value);
  assert.equal(Object.keys(prev).length, 1);
});

test('P3: after a restore, edits re-sent before their record is re-created can be retried and apply', async (t) => {
  const { env, x, y, pre, backup } = await restoredPair(t);
  const R = newId();
  const sx = [x.step('create', 'item', R, { title: 'R' })];
  await x.push(sx);
  await y.pull();
  const sy = [y.step('update', 'item', R, { phone: 'y-edit' }), y.step('update', 'item', pre, { phone: 'y-pre' })];
  await y.push(sy);

  const env2 = await restore(t, env, backup, [x, y]);
  const ry = await y.push(sy); // Y reconnects first and re-sends what it kept
  assert.deepEqual(ry.results.map((r) => [r.status, r.code]), [['rejected', 'not_found'], ['applied', undefined]]);
  assert.equal((await x.push(sx)).results[0].status, 'applied');
  const retry = await y.push([sy[0]]); // the rejected step, retried unchanged
  assert.notEqual(retry.results[0].status, 'rejected', JSON.stringify(retry.results[0]));
  assert.deepEqual(retry.results[0].applied, ['phone']);
  assert.equal(rowOf(env2.db, R).phone, 'y-edit');
  assert.equal(rowOf(env2.db, pre).phone, 'y-pre');
});

test('P5: the clash list answers 400 to bad limits and repeated filters', async (t) => {
  const { base } = await setup(t);
  for (const qs of ['limit=5.5', 'limit=0', 'limit=abc', 'limit=5000', 'entity=a&entity=b', 'recordId=x&recordId=y', 'status=open&status=all']) {
    const r = await getJson(`${base}/api/sync/clashes?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.ok(r.body.error, qs);
  }
  assert.equal((await getJson(`${base}/api/sync/clashes?limit=5&entity=item`)).status, 200);
});

test('P6: paging while other devices keep pushing misses nothing and ends on the latest values', async (t) => {
  const { base } = await setup(t);
  const a = makeDevice(base, 'owner');
  const b = makeDevice(base, 'partner');
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const id = newId();
    ids.push(id);
    await one(a, a.step('create', 'item', id, { title: `t${i}` }));
  }
  const seen = new Map();
  let since = null;
  for (let i = 0; ; i++) {
    const { body } = await b.pullPage(since, 2);
    for (const c of body.changes) seen.set(c.id, c.fields?.title);
    if (i < 3) {
      await one(a, a.step('update', 'item', ids[0], { title: `edit${i}` }));
      await one(a, a.step('update', 'item', ids[9], { title: `edit9-${i}` }));
      const id = newId();
      ids.push(id);
      await one(a, a.step('create', 'item', id, { title: `new${i}` }));
    }
    since = body.cursor;
    if (!body.hasMore) break;
  }
  assert.deepEqual(ids.filter((id) => !seen.has(id)), []);
  assert.equal(seen.get(ids[0]), 'edit2');
  assert.equal(seen.get(ids[9]), 'edit9-2');
});

test('registration refuses a field whose column type would change its values', async (t) => {
  const { ctx, db, base } = await setup(t);
  db.exec(`CREATE TABLE syncdemo_typed (id TEXT PRIMARY KEY, deleted_at TEXT, flag TEXT, code INTEGER, amount NUMERIC,
    untyped, price REAL, label VARCHAR(20), ok_bool INTEGER)`);
  db.exec('CREATE TABLE syncdemo_strict (id TEXT PRIMARY KEY, deleted_at TEXT, n INTEGER, s TEXT) STRICT');
  db.exec('CREATE TABLE syncdemo_badid (id INTEGER PRIMARY KEY, deleted_at TEXT, s TEXT)');
  const reg = (entity, table, fields) => ctx.services.sync.registerEntity({ module: 'syncdemo', entity, table, fields });
  assert.throws(() => reg('t1', 'syncdemo_typed', { flag: { type: 'boolean' } }), /flag is boolean but .* TEXT affinity/);
  assert.throws(() => reg('t2', 'syncdemo_typed', { code: { type: 'text' } }), /INTEGER affinity/);
  assert.throws(() => reg('t3', 'syncdemo_typed', { amount: { type: 'number' } }), /NUMERIC affinity/);
  assert.throws(() => reg('t4', 'syncdemo_typed', { untyped: { type: 'text' } }), /BLOB affinity/);
  assert.throws(() => reg('t5', 'syncdemo_typed', { code: { type: 'number' } }), /declare it REAL/);
  assert.throws(() => reg('t6', 'syncdemo_badid', { s: { type: 'text' } }), /id must be a TEXT column/);
  reg('t7', 'syncdemo_typed', { price: { type: 'number' }, label: { type: 'text' }, ok_bool: { type: 'boolean' } });
  reg('t8', 'syncdemo_strict', { n: { type: 'integer' }, s: { type: 'text' } });

  // Values round-trip exactly.
  const a = makeDevice(base, 'owner');
  const id = newId();
  assert.equal((await one(a, a.step('create', 't7', id, { price: 2.5, label: '0123', ok_bool: false }))).status, 'applied');
  assert.equal((await one(a, a.step('create', 'item', newId(), { title: '0123', phone: '0123', done: false }))).status, 'applied');
  const { records } = await a.pull();
  assert.deepEqual(records.get(`t7/${id}`).fields, { price: 2.5, label: '0123', ok_bool: false });
  const item = [...records.values()].find((r) => r.entity === 'item');
  assert.equal(item.fields.phone, '0123');
  assert.equal(item.fields.done, false);
});
