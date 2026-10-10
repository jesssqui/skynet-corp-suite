#!/usr/bin/env node
// End-to-end check of D16: a REAL Stockroom (an Inventory Hub checkout, run from its own code) and a real suite.
//   node scripts/stockroom-e2e.mjs [path to an inventory-hub checkout]      (npm run test:stockroom -- <path>)
// Needs `npm install` in that checkout (its tsx, fastify, better-sqlite3) and `npm ci` here. Both use throwaway
// databases: the suite in this process (createApp on a temporary database), Stockroom as its own process
// (scripts/stockroom-hub.mjs under the checkout's tsx: live-sized data from its own generator, suppliers, a purchase
// order confirmed as placed, a count with a difference; the suite's reader made through its admin API). Walks
// through: the connection code pasted and checked, the first pull (every read signed, a fresh nonce each, answers
// stored), the tasks made (reorders by supplier, the delivery, the difference, the weekly spot check), unchanged
// answers (304), then Stockroom's own actions — a purchase order confirmed to a supplier with a reorder task, the
// first one received in full, the second cancelled, the difference marked investigated, a spot check applied — and
// the tasks finished at the next pull (with how each order ended, from a Stockroom with B10), nothing made twice, and finally "Disconnect" in Stockroom (401 revoked: no more
// calls). A POST to Stockroom's suite API is refused 405 (it is read-only on its side too); the suite never sends one.
process.env.TZ ||= 'America/Toronto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/src/config.js';
import { createLogger } from '../server/src/lib/log.js';
import { openDb } from '../server/src/db/open.js';
import { createApp } from '../server/src/app.js';
import { DELIVERY_GONE, DIFFERENCE_GONE } from '../server/src/modules/stockroom/plans.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB_DIR = path.resolve(process.argv[2] || process.env.HUB_DIR || path.join(ROOT, '..', 'inventory-hub'));
const TSX = path.join(HUB_DIR, 'node_modules', '.bin', 'tsx');
if (!fs.existsSync(TSX)) {
  console.error(`No tsx in ${HUB_DIR}/node_modules: run npm install there first.`);
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockroom-e2e-'));
let pass = 0;
let fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

// ───────── Stockroom (its own process, its own code) ─────────
console.log(`Stockroom from ${HUB_DIR}`);
const hubProc = spawn(TSX, [path.join(ROOT, 'scripts', 'stockroom-hub.mjs')], {
  cwd: HUB_DIR, env: { ...process.env, HUB_DIR, HUB_DB: path.join(tmp, 'hub', 'hub.db') }, stdio: ['pipe', 'pipe', 'inherit'],
});
const lines = readline.createInterface({ input: hubProc.stdout });
const waiting = [];
lines.on('line', (l) => {
  let msg;
  try { msg = JSON.parse(l); } catch { console.log(`  [stockroom] ${l}`); return; }
  waiting.shift()?.(msg);
});
const next = () => new Promise((resolve) => waiting.push(resolve));
const ready = (await Promise.race([next(), new Promise((_, rej) => setTimeout(() => rej(new Error('Stockroom didn’t start in 60 s')), 60_000))])).ready;
const hubCmd = async (cmd, args = {}) => {
  const answer = next();
  hubProc.stdin.write(`${JSON.stringify({ cmd, ...args })}\n`);
  const r = await answer;
  if (r.error) throw new Error(`Stockroom ${cmd}: ${r.error}`);
  return r.ok;
};
console.log(`  Stockroom on ${ready.url}, reader ${ready.key}`);

// ───────── the suite (in this process) ─────────
const config = loadConfig({ DATA_DIR: path.join(tmp, 'suite'), CLIENT_DIST: path.join(tmp, 'no-client'), AUTH_SCRYPT_N: '1024' });
fs.mkdirSync(config.dataDir, { recursive: true });
const sdb = openDb(config.dbPath);
const { ctx } = await createApp({ config, db: sdb, log: createLogger('suite', 'warn') });
const svc = ctx.services.stockroom;
const tasks = (where = '1', ...args) => sdb.prepare(`SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND created_by = 'system' AND ${where} ORDER BY created_at, id`).all(...args);
const open = (where = '1', ...args) => tasks(`done_at IS NULL AND ${where}`, ...args);
const pulls = () => Object.fromEntries(sdb.prepare('SELECT * FROM stockroom_pulls').all().map((p) => [p.endpoint, p]));

try {
  console.log('1. Connect with Stockroom’s code (checked with a signed GET before it is saved)');
  const info = await svc.connect({ code: ready.code }, { actor: 'owner' });
  ok(info.connected && info.hubUrl === ready.url && info.readerKey === ready.key, 'connected with the code from Settings → Connections → Connect the suite');
  ok(!JSON.stringify(sdb.prepare('SELECT * FROM stockroom_connection').get()).includes(Buffer.from(ready.code.slice(5), 'base64url').toString().match(/"s":"([0-9a-f]+)"/)[1]), 'the secret is stored only encrypted');
  await svc.pullRound();

  console.log('2. The first pull: every read answered, the tasks made');
  const p1 = pulls();
  ok(['deliveries', 'differences', 'counts', 'order-soon'].every((e) => p1[e]?.body && !p1[e].last_error), 'deliveries, differences, counts, order-soon read', Object.values(p1).map((p) => [p.endpoint, p.last_error]));
  const soon = svc.snapshot('order-soon').body;
  ok(soon.version === 1 && Array.isArray(soon.items), 'order-soon is version 1 with items');
  const lists = svc.lists();
  const reorders = open("title LIKE 'Reorder%'");
  ok(reorders.length === lists.reorderSuppliers && lists.reorderSuppliers >= 2, `one reorder task per supplier (${reorders.length})`, reorders.map((t) => t.title));
  const north = reorders.find((t) => t.title.startsWith('Reorder from Northern Pouch Supply'));
  const northItems = soon.items.filter((i) => i.supplier_id === ready.suppliers.north && i.suggested_qty > 0);
  ok(north && north.title === `Reorder from Northern Pouch Supply: ${northItems.length} product${northItems.length === 1 ? '' : 's'}`, `Northern’s task lists its ${northItems.length} products`, north?.title);
  ok(north && northItems.every((i) => north.notes.includes(i.name) && north.notes.includes(`order ${i.suggested_qty} tin`)), 'with each product’s suggested quantity');
  ok(reorders.some((t) => / with no supplier in Stockroom$/.test(t.title)), 'products with no supplier share one task');
  const [delivery] = open("title LIKE 'Receive delivery%'");
  const firstPo = svc.snapshot('deliveries').body.items[0];
  ok(delivery && delivery.title === `Receive delivery ${firstPo.number} from Eastern Tins: ${firstPo.remaining_tins} tins` && delivery.due_date === firstPo.expected_on,
    `“${delivery?.title}” due on its expected day (${firstPo.expected_on})`);
  const diffs = svc.snapshot('differences').body;
  const over = diffs.items.filter((d) => Math.abs(d.variance) >= diffs.threshold_tins);
  const ours = diffs.items.find((d) => d.count_type === 'partial' && d.variance === -6);
  const diffTasks = open("title LIKE 'Investigate count difference%'");
  ok(diffTasks.length === Math.min(over.length, 10), `one task per open difference at or over Stockroom’s limit (${diffTasks.length} of ${diffs.items.length} open, limit ${diffs.threshold_tins} tins)`);
  const diffTask = diffTasks.find((x) => x.title.includes(`(${ours?.sku}), -6 tins`));
  ok(Boolean(ours && diffTask), `“${diffTask?.title}”`);
  const [spot] = open("title LIKE 'Weekly spot check%'");
  ok(spot && spot.owner === 'shared', `“${spot?.title}” on the shared list`);
  const made = tasks().length;

  console.log('3. Pulled again with nothing changed: 304s, nothing new');
  await svc.pullRound({ force: true });
  ok(Object.values(pulls()).every((p) => p.etag && !p.last_error), 'every read has its ETag');
  ok(tasks().length === made, 'no task made twice');

  console.log('4. Stockroom’s own actions → the tasks follow at the next pull');
  const po2 = await hubCmd('confirm_po', { supplier: 'Northern Pouch Supply' });
  await svc.pullRound({ force: true });
  const n = sdb.prepare('SELECT * FROM planner_tasks WHERE id = ?').get(north.id);
  ok(n.done_at && /Ordered: purchase order PO-\d+ confirmed in Stockroom/.test(n.notes), 'a purchase order to Northern confirmed: its reorder task finished');
  ok(open("title LIKE 'Receive delivery%'").length === 2, 'and a task to receive it');
  await hubCmd('receive_po', { po_id: ready.firstPo });
  await svc.pullRound({ force: true });
  // A Stockroom with B10 lists ended orders (`ended`): the tasks say how each ended; an older one: the general reason.
  const b10 = Array.isArray(svc.snapshot('deliveries').body.ended);
  console.log(`  (Stockroom ${b10 ? 'with' : 'without'} B10's ended orders)`);
  if (b10) ok(svc.snapshot('deliveries').body.purchase_orders_truncated === false, 'B10: the open list isn’t cut (purchase_orders_truncated false)');
  const deliveryNotes = (id) => sdb.prepare('SELECT done_at, notes FROM planner_tasks WHERE id = ?').get(id);
  ok(deliveryNotes(delivery.id).done_at && deliveryNotes(delivery.id).notes.includes(b10 ? 'Received in full in Stockroom' : DELIVERY_GONE), 'the first order received in full: its task finished, saying so');
  const second = open("title LIKE 'Receive delivery%'")[0];
  const cancelled = await hubCmd('cancel_po', { po_id: po2.po_id });
  await svc.pullRound({ force: true });
  ok(cancelled.status === 'cancelled' && open("title LIKE 'Receive delivery%'").length === 0, 'the second cancelled: its task finished too');
  ok(deliveryNotes(second.id).notes.includes(b10 ? 'Cancelled in Stockroom: e2e' : DELIVERY_GONE), b10 ? '…with “Cancelled in Stockroom: e2e”' : '…with the general reason');
  await hubCmd('investigate', { id: ours.id });
  await svc.pullRound({ force: true });
  ok(sdb.prepare('SELECT notes FROM planner_tasks WHERE id = ?').get(diffTask.id).notes.includes(DIFFERENCE_GONE), 'the difference marked investigated: its task finished');
  await hubCmd('spot_check');
  await svc.pullRound({ force: true });
  ok(/Spot check applied in Stockroom/.test(sdb.prepare('SELECT notes FROM planner_tasks WHERE id = ?').get(spot.id).notes), 'a spot check applied: the week’s task finished');
  const before = tasks().length;
  await svc.pullRound({ force: true });
  await svc.pullRound({ force: true });
  ok(tasks().length === before, 'pulled again twice: nothing new');
  const errors = sdb.prepare("SELECT automation_id, error FROM automations_runs WHERE status <> 'ok'").all();
  ok(errors.length === 0, 'no automation run failed', errors);

  console.log('5. Read-only on both sides');
  const post = await fetch(`${ready.url}/v1/suite/deliveries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok(post.status === 405 && post.headers.get('allow') === 'GET', 'Stockroom refuses anything but GET (405)');

  console.log('6. Disconnected in Stockroom: 401 revoked, no more calls');
  await hubCmd('revoke');
  await svc.pullRound({ force: true });
  const card = ctx.services.connections.get('stockroom');
  ok(card.queueLabel === 'Disconnected' && /Disconnected in Stockroom/.test(card.lastError), 'the card says so', card);
  ok((await svc.pullRound({ force: true })).skipped === 'revoked', 'no more calls');
} catch (err) {
  fail++;
  console.error(err);
} finally {
  hubProc.stdin.end();
  sdb.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
