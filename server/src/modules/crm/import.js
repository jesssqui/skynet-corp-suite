// The accounting CSV import (C7): a customer list from QuickBooks, Wave, Xero or FreshBooks
// becomes clients, accounts, contacts and relationships — written through sync.applyLocal (the
// sync log, field versions and clash rules; devices receive them on their next pull), as the
// person who imported (actor), with a timeline note naming the file.
//
// Never overwrites, and creates nothing twice:
//  - every imported row is remembered by fingerprint (crm_import_rows: SHA-256 of its clean
//    values -> what it made); the same row again is "imported before" and skipped;
//  - a row whose customer (name key) was imported before with other values is "changed since
//    last import — not applied";
//  - a row whose email or phone is already on a live contact is "already here", a similar client
//    or account name "maybe the same" (@suite/shared/intake): skipped unless the person picks
//    "add only what's missing" (new contact / relationship / account on that client) or "create".
// Nothing is linked or merged automatically (that is D2's review list).
//
// A commit runs in the background in chunks (one transaction per chunk of rows, each row in its
// own savepoint, the event loop free between chunks), so a 10,000-row file doesn't stall the
// server; the page polls the batch for progress. One import at a time.
import crypto from 'node:crypto';
import { isId, newId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { readTable, CsvError } from '@suite/shared/csv';
import { RELATIONSHIP_KINDS } from '@suite/shared/crm';
import {
  cleanRow, buildMatchIndex, flagRows, planRow, actionsFor, fingerprintText, rowKey, detectMapping, checkMapping,
  rowFromCells, MAPPING_KEYS,
} from '@suite/shared/intake';
import { HttpError } from '../../lib/httpError.js';

export const IMPORT_LIMITS = Object.freeze({
  maxChars: 5 * 1024 * 1024, // the file's text (a 5 MB file); the route takes JSON bodies up to 8 MB
  maxRows: 10_000,
  chunkRows: 100,
  batchesShown: 20,
  problemsKept: 100,
});

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

class RowFailure extends Error {}

export function createImportService({ db, sync, log, limits: limitsIn = {} }) {
  const limits = { ...IMPORT_LIMITS, ...limitsIn };
  const q = {
    clients: db.prepare('SELECT id, name FROM crm_clients WHERE deleted_at IS NULL'),
    accounts: db.prepare('SELECT client_id, name FROM crm_accounts WHERE deleted_at IS NULL'),
    contacts: db.prepare('SELECT client_id, email, phone FROM crm_contacts WHERE deleted_at IS NULL AND (email IS NOT NULL OR phone IS NOT NULL)'),
    business: db.prepare('SELECT id, name FROM crm_businesses WHERE id = ? AND deleted_at IS NULL'),
    clientAny: db.prepare('SELECT id, name, deleted_at FROM crm_clients WHERE id = ?'),
    liveClient: db.prepare('SELECT id, name FROM crm_clients WHERE id = ? AND deleted_at IS NULL'),
    clientAccounts: db.prepare('SELECT id, client_id, name FROM crm_accounts WHERE client_id = ? AND deleted_at IS NULL'),
    clientContacts: db.prepare('SELECT id, client_id, name, email, phone FROM crm_contacts WHERE client_id = ? AND deleted_at IS NULL'),
    clientRelationships: db.prepare(`SELECT r.id, r.account_id, r.business_id, r.kind FROM crm_relationships r
      JOIN crm_accounts a ON a.id = r.account_id AND a.deleted_at IS NULL
      JOIN crm_businesses b ON b.id = r.business_id AND b.deleted_at IS NULL
      WHERE a.client_id = ? AND r.deleted_at IS NULL`),
    rowByFingerprint: db.prepare(`SELECT r.*, b.file_name, b.started_at FROM crm_import_rows r JOIN crm_import_batches b ON b.id = r.batch_id
      WHERE r.fingerprint = ?`),
    rowByKey: db.prepare(`SELECT r.*, b.file_name, b.started_at FROM crm_import_rows r JOIN crm_import_batches b ON b.id = r.batch_id
      WHERE r.row_key = ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`),
    insertRow: db.prepare(`INSERT OR IGNORE INTO crm_import_rows (fingerprint, row_key, batch_id, row_number, action, client_id, record_ids, created_at)
      VALUES (@fingerprint, @row_key, @batch_id, @row_number, @action, @client_id, @record_ids, @created_at)`),
    batch: db.prepare('SELECT * FROM crm_import_batches WHERE id = ?'),
    batches: db.prepare('SELECT * FROM crm_import_batches ORDER BY started_at DESC, id DESC LIMIT ?'),
    insertBatch: db.prepare(`INSERT INTO crm_import_batches (id, file_name, source, actor, business_id, kind, status, total_rows, started_at)
      VALUES (@id, @file_name, @source, @actor, @business_id, @kind, 'running', @total_rows, @started_at)`),
    progress: db.prepare(`UPDATE crm_import_batches SET processed = @processed, created_clients = @created_clients, added_to = @added_to,
      skipped = @skipped, failed = @failed, records = @records, problems = @problems WHERE id = @id`),
    finish: db.prepare('UPDATE crm_import_batches SET status = ?, error = ?, finished_at = ? WHERE id = ?'),
    interrupt: db.prepare("UPDATE crm_import_batches SET status = 'interrupted', finished_at = ? WHERE status = 'running'"),
  };

  let running = null; // the batch id being committed
  const businessName = (id) => q.business.get(id)?.name ?? 'our business';

  function batchView(b) {
    if (!b) return null;
    return {
      id: b.id,
      fileName: b.file_name,
      source: b.source,
      actor: b.actor,
      businessId: b.business_id,
      kind: b.kind,
      status: b.status,
      totalRows: b.total_rows,
      processed: b.processed,
      createdClients: b.created_clients,
      addedTo: b.added_to,
      skipped: b.skipped,
      failed: b.failed,
      records: b.records,
      problems: b.problems ? JSON.parse(b.problems) : [],
      error: b.error,
      startedAt: b.started_at,
      finishedAt: b.finished_at,
    };
  }

  /** After a restart: a batch that was running stopped part-way (its finished rows are remembered). */
  function markInterrupted() {
    const n = q.interrupt.run(nowIso()).changes;
    if (n) log?.warn(`${n} import(s) stopped part-way by a restart: importing the same file again finishes them`);
  }

  // ---- reading a request ---------------------------------------------------------------------
  function readRequest(body) {
    const { text, fileName = null, mapping = null, business = null, kind = null } = body ?? {};
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Choose a CSV file with your customer list');
    if (text.length > limits.maxChars) {
      throw new HttpError(413, `That file is too big (over ${Math.round(limits.maxChars / 1024 / 1024)} MB). Split it and import the parts.`, null, { code: 'too_big' });
    }
    let table;
    try {
      table = readTable(text, { maxRows: limits.maxRows });
    } catch (err) {
      if (err instanceof CsvError) {
        throw new HttpError(413, `That file has more than ${limits.maxRows.toLocaleString('en-CA')} rows. Split it and import the parts.`, null, { code: 'too_many_rows' });
      }
      throw err;
    }
    if (!table.rows.length) throw new HttpError(400, 'That file has no customer rows under its header row');
    const width = table.headers.length;
    const cols = mapping ? checkMapping(mapping, width) : detectMapping(table.headers).mapping;
    if (!['name', 'company', 'contact', 'first', 'last'].some((k) => cols[k] !== null)) {
      throw new HttpError(400, 'Pick the column that holds the client’s name', null, { code: 'no_name_column' });
    }
    let rel = null;
    if (business !== null && business !== '') {
      if (!isId(business) || !q.business.get(business)) throw new HttpError(400, 'business must be one of our businesses');
      if (!RELATIONSHIP_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${RELATIONSHIP_KINDS.join(', ')}`);
      rel = { business_id: business, kind };
    }
    const name = typeof fileName === 'string' ? fileName.replace(/[\\/]/g, ' ').trim().slice(0, 200) || null : null;
    return { table, mapping: cols, rel, fileName: name, source: detectMapping(table.headers).source };
  }

  function matchIndex() {
    return buildMatchIndex({ clients: q.clients.all(), accounts: q.accounts.all(), contacts: q.contacts.all() });
  }

  /** An existing client with what 'add' needs, or null when it is gone. */
  function target(clientId) {
    const client = clientId ? q.liveClient.get(clientId) : null;
    if (!client) return null;
    return {
      client,
      accounts: q.clientAccounts.all(clientId),
      contacts: q.clientContacts.all(clientId),
      relationships: q.clientRelationships.all(clientId),
    };
  }

  function previousOf(row) {
    if (!row) return null;
    const c = q.clientAny.get(row.client_id);
    return {
      batchId: row.batch_id, fileName: row.file_name, at: row.created_at, row: row.row_number,
      clientId: row.client_id, clientName: c?.name ?? null, live: Boolean(c && !c.deleted_at),
    };
  }

  /**
   * Every row with its state: invalid | imported | changed | same | similar | duplicate | new,
   * what may be done with it (`actions`, the first is the default) and what it would add.
   */
  function analyse(req) {
    const relationships = req.rel ? [req.rel] : [];
    const rows = req.table.rows.map((cells, i) => {
      const clean = cleanRow(rowFromCells(cells, req.mapping, { relationships }));
      return { rowNumber: i + 2, clean, fingerprint: sha256(fingerprintText(clean)), key: rowKey(clean) };
    });
    const flags = flagRows(rows.map((r) => r.clean), matchIndex());
    for (const [i, row] of rows.entries()) {
      const flag = flags[i];
      row.status = flag.state;
      row.match = flag.match ?? null;
      row.duplicateOf = flag.duplicateOf === undefined ? null : rows[flag.duplicateOf].rowNumber;
      row.previous = null;
      if (row.status !== 'invalid') {
        const same = q.rowByFingerprint.get(row.fingerprint);
        const changed = same ? null : q.rowByKey.get(row.key);
        if (same) {
          row.status = 'imported';
          row.previous = previousOf(same);
        } else if (changed) {
          row.status = 'changed';
          row.previous = previousOf(changed);
        }
      }
      row.targetId = row.status === 'changed' ? (row.previous.live ? row.previous.clientId : null)
        : ['same', 'similar'].includes(row.status) ? row.match.clientId : null;
      row.actions = actionsFor(row.status, { canAdd: Boolean(row.targetId) });
      row.action = row.actions[0];
    }
    return rows;
  }

  /** What "add only what's missing" would make for a row (null when it can't add). */
  function addsFor(row) {
    if (!row.actions.includes('add')) return null;
    const t = target(row.targetId);
    if (!t) return null;
    const plan = planRow(row.clean, { action: 'add', target: t, makeId: () => 'x' });
    return {
      account: plan.summary.account === 'new',
      contact: plan.summary.contact === 'new',
      relationships: plan.summary.relationships.filter((r) => r.state === 'new').map(({ business_id, kind }) => ({ business_id, kind })),
    };
  }

  function rowView(row) {
    const { client, account, contact } = row.clean;
    const address = [account.street, [account.city, account.region].filter(Boolean).join(', '), account.postal_code, account.country]
      .filter(Boolean).join(' · ');
    return {
      row: row.rowNumber,
      status: row.status,
      actions: row.actions,
      action: row.action,
      match: row.match,
      previous: row.previous,
      duplicateOf: row.duplicateOf,
      client: { name: client.name, tags: client.tags, notes: client.notes },
      account: { name: account.name, address: address || null, website: account.website },
      contact: contact ? { name: contact.name, email: contact.email, phone: contact.phone, notes: contact.notes } : null,
      relationships: row.clean.relationships.map(({ business_id, kind }) => ({ business_id, kind })),
      warnings: row.clean.warnings,
      problems: row.clean.problems,
      adds: addsFor(row),
    };
  }

  const COUNTED = ['new', 'same', 'similar', 'changed', 'imported', 'duplicate', 'invalid'];

  /** POST /import/preview: the rows as they would be imported, flagged; nothing is written. */
  function preview(body) {
    const req = readRequest(body);
    const rows = analyse(req);
    const counts = Object.fromEntries(COUNTED.map((s) => [s, 0]));
    for (const r of rows) counts[r.status] += 1;
    return {
      fileName: req.fileName,
      source: req.source,
      headers: req.table.headers,
      delimiter: req.table.delimiter,
      mapping: req.mapping,
      total: rows.length,
      counts,
      rows: rows.map(rowView),
      running: running ? batchView(q.batch.get(running)) : null,
    };
  }

  // ---- committing ------------------------------------------------------------------------------
  const KIND_WORDS = { website: 'website', social: 'social media', consulting: 'consulting', wholesale: 'wholesale' };

  function noteFor(batch, row, plan) {
    const file = batch.file_name ? `“${batch.file_name}”` : 'a CSV file';
    if (row.action === 'create') return `Imported from ${file} (accounting customer list).`;
    const parts = plan.ops.map((op) => {
      if (op.entity === 'relationship') return `${businessName(op.fields.business_id)} (${KIND_WORDS[op.fields.kind] ?? op.fields.kind})`;
      return `${op.entity} ${op.fields.name ?? ''}`.trim();
    });
    return `Added from ${file} (accounting customer list): ${parts.join(', ')}. Nothing existing was changed.`;
  }

  /** One row in its own savepoint: all its records, its note and its fingerprint, or none. */
  function commitRow(batch, row, tally) {
    if (row.action === 'skip' || row.status === 'invalid') {
      tally.skipped += 1;
      return;
    }
    try {
      db.transaction(() => {
        let t = null;
        if (row.action === 'add') {
          t = target(row.targetId);
          if (!t) throw new RowFailure('the client to add to was deleted');
        }
        const plan = planRow(row.clean, { action: row.action, target: t, makeId: () => newId() });
        const made = [];
        const apply = (entity, recordId, fields) => {
          const r = sync.applyLocal({ actor: batch.actor, entity, op: 'create', recordId, fields });
          if (r.status !== 'applied') throw new RowFailure(`${entity}: ${r.reason ?? r.code}`);
          made.push({ entity, id: recordId });
        };
        for (const op of plan.ops) apply(op.entity, op.id, op.fields);
        if (made.length) {
          apply('activity', newId(), {
            client_id: plan.clientId, account_id: plan.accountId, business_id: batch.business_id ?? null,
            type: 'note', body: noteFor(batch, row, plan), at: nowIso(),
          });
        }
        q.insertRow.run({
          fingerprint: row.fingerprint, row_key: row.key, batch_id: batch.id, row_number: row.rowNumber, action: row.action,
          client_id: plan.clientId, record_ids: JSON.stringify(made), created_at: nowIso(),
        });
        if (!plan.ops.length) tally.skipped += 1; // nothing was missing (remembered, so it's "imported before" next time)
        else if (row.action === 'create') tally.created_clients += 1;
        else tally.added_to += 1;
        tally.records += made.length;
      })();
    } catch (err) {
      if (!(err instanceof RowFailure)) throw err;
      tally.failed += 1;
      if (tally.problemList.length < limits.problemsKept) tally.problemList.push({ row: row.rowNumber, reason: err.message });
    }
  }

  async function run(batch, rows) {
    const tally = { processed: 0, created_clients: 0, added_to: 0, skipped: 0, failed: 0, records: 0, problemList: [] };
    const save = () => q.progress.run({
      id: batch.id, processed: tally.processed, created_clients: tally.created_clients, added_to: tally.added_to,
      skipped: tally.skipped, failed: tally.failed, records: tally.records,
      problems: tally.problemList.length ? JSON.stringify(tally.problemList) : null,
    });
    try {
      await new Promise((resolve) => setImmediate(resolve)); // the commit request is answered first
      for (let i = 0; i < rows.length; i += limits.chunkRows) {
        const chunk = rows.slice(i, i + limits.chunkRows);
        db.transaction(() => {
          for (const row of chunk) commitRow(batch, row, tally);
          tally.processed += chunk.length;
          save();
        })();
        // Let other requests (devices syncing, the page asking for progress) in between chunks.
        await new Promise((resolve) => setImmediate(resolve));
      }
      q.finish.run('done', null, nowIso(), batch.id);
      log?.info(`import ${batch.id} (${batch.file_name ?? 'no name'}): ${tally.created_clients} new clients, ${tally.added_to} added to, ${tally.skipped} skipped, ${tally.failed} failed`);
    } catch (err) {
      log?.error(`import ${batch.id} failed:`, err);
      q.finish.run('failed', String(err.message ?? err).slice(0, 500), nowIso(), batch.id);
    } finally {
      running = null;
    }
  }

  /**
   * POST /import/commit: start importing (202 + the batch), or the batch this id already started
   * (a retried request). `choices` = { [row]: { action, status } }: a choice counts only while the
   * row is still in the state it was made for — anything that changed since the preview gets
   * its default (skip, for anything flagged).
   * @returns {{ batch, started: boolean, done: Promise<void>|null }}
   */
  function commit({ actor, body }) {
    const batchId = body?.batchId;
    if (!isId(batchId)) throw new HttpError(400, 'batchId must be a record id made by the page');
    const existing = q.batch.get(batchId);
    if (existing) return { batch: batchView(existing), started: false, done: null };
    if (running) throw new HttpError(409, 'Another import is running. Wait for it to finish.', null, { code: 'import_running' });
    const req = readRequest(body);
    const rows = analyse(req);
    const choices = body.choices && typeof body.choices === 'object' ? body.choices : {};
    for (const row of rows) {
      const c = choices[row.rowNumber];
      if (c && c.status === row.status && row.actions.includes(c.action)) row.action = c.action;
    }
    const batch = {
      id: batchId, file_name: req.fileName, source: req.source, actor, business_id: req.rel?.business_id ?? null,
      kind: req.rel?.kind ?? null, total_rows: rows.length, started_at: nowIso(),
    };
    q.insertBatch.run(batch);
    running = batchId;
    const done = run(batch, rows);
    return { batch: batchView(q.batch.get(batchId)), started: true, done };
  }

  return {
    preview,
    commit,
    markInterrupted,
    getBatch: (id) => (isId(id) ? batchView(q.batch.get(id)) : null),
    listBatches: () => ({ batches: q.batches.all(limits.batchesShown).map(batchView), running }),
    limits,
    MAPPING_KEYS,
  };
}
