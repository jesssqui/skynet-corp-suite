// The Stockroom side of scripts/stockroom-e2e.mjs (D16): a REAL Stockroom (an Inventory Hub checkout's own
// code, run with that checkout's tsx) on a throwaway database, listening on 127.0.0.1. Never run on its own:
// stockroom-e2e.mjs starts it as
//   <hub>/node_modules/.bin/tsx scripts/stockroom-hub.mjs      (env HUB_DIR, HUB_DB, HUB_PORT)
// It seeds live-sized data with the hub's own generator (sales history → order-soon suggestions), two suppliers,
// a purchase order confirmed as placed and a count with a difference, makes the suite's reader through the admin
// API (Settings → Connections → Connect the suite: the connection code, shown once), prints
// {"ready": {...}} on stdout, then takes one JSON command per line on stdin and answers one JSON line:
//   {"cmd":"confirm_po","supplier":"<name>"}   a purchase order to that supplier, confirmed as placed
//   {"cmd":"receive_po","po_id":1}             receive what is still to come on it (fully received)
//   {"cmd":"cancel_po","po_id":2}
//   {"cmd":"investigate","id":1}               mark a count difference investigated
//   {"cmd":"spot_check"}                       apply a spot check (no differences)
//   {"cmd":"revoke"}                           Disconnect the suite (admin API)
// These are the hub's OWN admin actions, done here to move its state — the suite never makes them.
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const HUB_DIR = process.env.HUB_DIR;
const hub = (p) => import(pathToFileURL(path.join(HUB_DIR, p)).href);
process.env.SECRETS_KEY ||= 'stockroom-e2e-secrets-key-not-for-production';
const ADMIN = 'stockroom-e2e-admin-token';

const { openDb } = await hub('src/db/index.ts');
const { buildApp } = await hub('src/app.ts');
const { generateLiveSized } = await hub('scripts/suite-bench.ts');
const purchasing = await hub('src/core/purchasing.ts');
const counts = await hub('src/core/counts.ts');
const followups = await hub('src/core/followups.ts');
const suite = await hub('src/core/suite.ts');

const db = openDb(process.env.HUB_DB);
generateLiveSized(db, { skus: 40, ledgerRows: 6000, days: 120, seed: 11 });
const actor = 'user:e2e';
// The generator's spot checks of the last 8 days moved a week further back, so this week has none yet (the suite
// then makes the week's spot-check task, and finishes it once {"cmd":"spot_check"} applies one).
const eightDays = 8 * 86_400_000;
for (const c of db.sqlite.prepare(`SELECT id, applied_at FROM counts WHERE type = 'spot' AND applied_at >= ?`).all(new Date(Date.now() - eightDays).toISOString())) {
  db.sqlite.prepare('UPDATE counts SET applied_at = ? WHERE id = ?').run(new Date(Date.parse(c.applied_at) - eightDays).toISOString(), c.id);
}
const north = purchasing.createSupplier(db, { name: 'Northern Pouch Supply', lead_time_days: 7 }, actor);
const east = purchasing.createSupplier(db, { name: 'Eastern Tins', lead_time_days: 5 }, actor);
// The products Stockroom suggests ordering: half from Northern, a few from Eastern, the rest with no supplier.
const soon = suite.suiteOrderSoon(db).items.filter((i) => i.suggested_qty > 0);
if (soon.length < 4) throw new Error(`the generated data suggests only ${soon.length} products to order`);
const northSkus = soon.filter((_, k) => k % 2 === 0).map((i) => i.sku_id);
const eastSkus = soon.filter((_, k) => k % 4 === 1).map((i) => i.sku_id);
purchasing.assignSupplier(db, northSkus, north.id);
purchasing.assignSupplier(db, eastSkus, east.id);
// A purchase order to Eastern, confirmed as placed (expected in 5 days).
const firstPo = purchasing.createPurchaseOrder(db, { supplier_id: east.id, lines: [{ sku_id: eastSkus[0], qty: 40 }] }, actor);
purchasing.confirmPurchaseOrder(db, firstPo.id, actor);
// A partial count of two products, one off by 6 tins: a difference to investigate.
const all = suite.suiteStock(db).items ?? [];
const [a, b] = soon.slice(-2);
const c1 = counts.startCount(db, { type: 'partial', sku_ids: [a.sku_id, b.sku_id] }, actor);
counts.setLine(db, c1.id, a.sku_id, { counted: Math.max(0, a.on_hand - 6), reason: 'missing' }, actor);
counts.setLine(db, c1.id, b.sku_id, { counted: b.on_hand }, actor);
counts.apply(db, c1.id, {}, actor);

const app = buildApp({ db, adminToken: ADMIN });
const port = Number(process.env.HUB_PORT || 0);
await app.listen({ port, host: '127.0.0.1' });
const url = `http://127.0.0.1:${app.server.address().port}`;
const admin = async (method, p, body) => {
  const res = await fetch(`${url}/api/admin${p}`, {
    method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const reader = await admin('POST', '/readers', { name: 'Skynet Corp Suite' });
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
out({ ready: { url, code: reader.connection_code, key: reader.key, stockSkus: all.length, suppliers: { north: north.id, east: east.id }, firstPo: firstPo.id } });

const handlers = {
  confirm_po({ supplier }) {
    const su = purchasing.listSuppliers(db).find((s) => s.name === supplier);
    const sku = suite.suiteOrderSoon(db).items.find((i) => i.supplier_id === su.id && i.suggested_qty > 0);
    const p = purchasing.createPurchaseOrder(db, { supplier_id: su.id, lines: [{ sku_id: sku.sku_id, qty: sku.suggested_qty }] }, actor);
    purchasing.confirmPurchaseOrder(db, p.id, actor);
    return { po_id: p.id };
  },
  receive_po({ po_id }) {
    const po = purchasing.getPurchaseOrder(db, po_id);
    const lines = po.lines.filter((l) => l.remaining > 0).map((l) => ({ sku_id: l.sku_id, tins: l.remaining }));
    purchasing.receiveAgainstPo(db, po_id, { lines }, actor);
    return { status: purchasing.getPurchaseOrder(db, po_id).status };
  },
  cancel_po({ po_id }) {
    purchasing.cancelPurchaseOrder(db, po_id, 'e2e', actor);
    return { status: purchasing.getPurchaseOrder(db, po_id).status };
  },
  investigate({ id }) {
    return { status: followups.markInvestigated(db, id, 'Found the case behind the shelf', actor).status };
  },
  spot_check() {
    const s = suite.suiteCounts(db).spot_check_suggestions[0];
    const c = counts.startCount(db, { type: 'spot', sku_ids: [s.sku_id] }, actor);
    counts.setLine(db, c.id, s.sku_id, { counted: s.on_hand }, actor);
    counts.apply(db, c.id, {}, actor);
    return { applied: c.id };
  },
  async revoke() {
    return admin('POST', `/readers/${reader.key}/revoke`, {});
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    out({ ok: await handlers[msg.cmd](msg) });
  } catch (err) {
    out({ error: String(err?.message ?? err) });
  }
});
rl.on('close', async () => {
  await app.close();
  process.exit(0);
});
