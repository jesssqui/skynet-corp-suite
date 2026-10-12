// Importing leads from a research / outreach export (D8b): each row becomes a lead in the pipeline
// for Great White North Design, with its outreach history on the lead's timeline and a task when the
// file dates a next step. The rules for one row are pure and shared (@suite/shared/leadImport); this
// file reads the file, compares every row with what is already here, and writes through
// sync.applyLocal (the sync log, field versions and clash rules; devices receive the records on their
// next pull), as the person who imported.
//
// Never overwrites, and creates nothing twice:
//  - every imported row is remembered by its source key (crm_lead_import_rows: the file's lead_id; else a
//    hash of name, email and town), so the same file again — or a newer export that still lists the same
//    leads — skips them ("imported before");
//  - a row whose email or business name matches a live lead is "already in the pipeline", one that
//    matches a client (same email or phone on a contact, or a similar client / account name) is "already
//    a client" — both skipped, nothing is linked or merged;
//  - a row repeated in the same file (same key or email) is made once.
// Rows the export excluded are made as LOST (not a fit), so they are remembered and never offered again.
//
// A commit runs in the request, in chunks of 100 rows (one transaction per chunk, each row in its own
// savepoint: its lead, timeline entries, task and remembered key all land, or none) — at most 2,000
// rows a file, which takes a second or two.
import crypto from 'node:crypto';
import { isId, newId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { readTable, CsvError } from '@suite/shared/csv';
import { buildMatchIndex, findMatch, nameKey } from '@suite/shared/intake';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { CAMPAIGN_IDS } from '@suite/shared/campaigns';
import { LEAD_IMPORT_LIMITS, leadRowsFromTable, cleanLeadRow } from '@suite/shared/leadImport';
import { HttpError } from '../../lib/httpError.js';

export const LEAD_IMPORT_CHUNK = 100;
const PROBLEMS_KEPT = 100;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

class RowFailure extends Error {}

export const LEAD_ROW_STATES = Object.freeze(['new', 'imported', 'exists', 'client', 'duplicate', 'invalid']);

export function createLeadImportService({ db, sync, log, limits: limitsIn = {} }) {
  const limits = { ...LEAD_IMPORT_LIMITS, ...limitsIn };
  const campaignLive = () => Boolean(db.prepare('SELECT 1 FROM crm_campaigns WHERE id = ? AND deleted_at IS NULL').get(CAMPAIGN_IDS.email_outreach));
  const q = {
    clients: db.prepare('SELECT id, name FROM crm_clients WHERE deleted_at IS NULL'),
    accounts: db.prepare('SELECT id, client_id, name FROM crm_accounts WHERE deleted_at IS NULL'),
    contacts: db.prepare('SELECT client_id, email, phone FROM crm_contacts WHERE deleted_at IS NULL AND (email IS NOT NULL OR phone IS NOT NULL)'),
    leads: db.prepare('SELECT name, email FROM crm_leads WHERE deleted_at IS NULL'),
    importedKeys: db.prepare('SELECT source_key FROM crm_lead_import_rows'),
    insertRow: db.prepare(`INSERT OR IGNORE INTO crm_lead_import_rows (source_key, batch_id, row_number, lead_id, record_ids, created_at)
      VALUES (@source_key, @batch_id, @row_number, @lead_id, @record_ids, @created_at)`),
    batch: db.prepare('SELECT * FROM crm_lead_import_batches WHERE id = ?'),
    insertBatch: db.prepare(`INSERT INTO crm_lead_import_batches (id, file_name, actor, request_hash, total_rows, started_at)
      VALUES (@id, @file_name, @actor, @request_hash, @total_rows, @started_at)`),
    progress: db.prepare(`UPDATE crm_lead_import_batches SET imported = @imported, lost = @lost, skipped = @skipped, failed = @failed,
      tasks = @tasks, records = @records, problems = @problems WHERE id = @id`),
    finish: db.prepare('UPDATE crm_lead_import_batches SET finished_at = ? WHERE id = ?'),
  };

  function batchView(b) {
    if (!b) return null;
    return {
      id: b.id, fileName: b.file_name, actor: b.actor, totalRows: b.total_rows, imported: b.imported, lost: b.lost,
      skipped: b.skipped, failed: b.failed, tasks: b.tasks, records: b.records,
      problems: b.problems ? JSON.parse(b.problems) : [], startedAt: b.started_at, finishedAt: b.finished_at,
    };
  }

  // ---- reading a request -----------------------------------------------------------------------
  function readRequest(body) {
    const { text, fileName = null } = body ?? {};
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Choose a CSV file with your leads');
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
    let rows;
    try {
      rows = leadRowsFromTable(table);
    } catch (err) {
      if (err.code === 'no_name_column') throw new HttpError(400, err.message, null, { code: 'no_name_column' });
      throw err;
    }
    if (!rows.length) throw new HttpError(400, 'The file has no rows', null, { code: 'empty' });
    return { text, fileName: typeof fileName === 'string' ? fileName.slice(0, 200) : null, table, rows };
  }

  /** The row's key in crm_lead_import_rows: the file's lead_id, else a hash of what identifies it. */
  const sourceKey = (clean, cells) => (clean.sourceId
    ? `id:${clean.sourceId}`
    : `h:${sha256([clean.nameKey, clean.email ?? '', (cells.city ?? '').toLowerCase()].join('|')).slice(0, 32)}`);

  /** Every row cleaned and flagged against the file itself, the pipeline, the clients and earlier imports. */
  function analyse(req) {
    const imported = new Set(q.importedKeys.all().map((r) => r.source_key));
    const leadEmails = new Set();
    const leadNames = new Set();
    for (const l of q.leads.all()) {
      if (l.email) leadEmails.add(l.email);
      const k = nameKey(l.name);
      if (k) leadNames.add(k);
    }
    const index = buildMatchIndex({ clients: q.clients.all(), accounts: q.accounts.all(), contacts: q.contacts.all() });
    const seenKeys = new Set();
    const seenEmails = new Set();
    return req.rows.map(({ rowNumber, cells }) => {
      const clean = cleanLeadRow(cells, { fileName: req.fileName, rowNumber });
      const key = sourceKey(clean, cells);
      const base = { rowNumber, key, clean };
      if (clean.problems.length) return { ...base, status: 'invalid', reason: clean.problems.join('; ') };
      if (imported.has(key)) return { ...base, status: 'imported', reason: 'Imported before' };
      if (seenKeys.has(key) || (clean.email && seenEmails.has(clean.email))) {
        return { ...base, status: 'duplicate', reason: 'Listed earlier in this file' };
      }
      seenKeys.add(key);
      if (clean.email) seenEmails.add(clean.email);
      if ((clean.email && leadEmails.has(clean.email)) || leadNames.has(clean.nameKey)) {
        return { ...base, status: 'exists', reason: 'Already in the pipeline' };
      }
      const match = findMatch({ client: { name: clean.name }, account: { name: clean.name }, contact: { email: clean.email, phone: clean.phone } }, index);
      if (match) {
        return {
          ...base, status: 'client',
          reason: match.state === 'same' ? `Already a client: ${match.clientName} (same ${match.by})` : `Maybe already a client: ${match.clientName}`,
        };
      }
      return { ...base, status: 'new', reason: null };
    });
  }

  const COUNT_KEYS = ['new', 'imported', 'exists', 'client', 'duplicate', 'invalid'];

  function rowView(r) {
    return {
      row: r.rowNumber,
      name: r.clean.name,
      status: r.status,
      reason: r.reason,
      stage: r.clean.fields.stage,
      email: r.clean.email,
      phone: r.clean.phone,
      nextStep: r.clean.task?.due_date ?? null,
      emailed: r.clean.activities.some((a) => a.type === 'email'),
      warnings: r.clean.warnings,
    };
  }

  /** POST /leads/import/preview { text, fileName? } — every row flagged; nothing written. */
  function preview(body) {
    const req = readRequest(body);
    const rows = analyse(req);
    const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
    let lost = 0;
    let tasks = 0;
    let emailed = 0;
    let warnings = 0;
    for (const r of rows) {
      counts[r.status] += 1;
      warnings += r.clean.warnings.length ? 1 : 0;
      if (r.status === 'new') {
        if (r.clean.fields.stage === 'lost') lost += 1;
        if (r.clean.task) tasks += 1;
        if (r.clean.activities.some((a) => a.type === 'email')) emailed += 1;
      }
    }
    return { fileName: req.fileName, total: rows.length, counts, willBeLost: lost, willMakeTasks: tasks, alreadyEmailed: emailed, rowsWithWarnings: warnings, rows: rows.map(rowView) };
  }

  // ---- committing ------------------------------------------------------------------------------
  function commitRow(batch, row, tally, at) {
    try {
      db.transaction(() => {
        const made = [];
        const apply = (entity, fields) => {
          const recordId = newId();
          const r = sync.applyLocal({ actor: batch.actor, entity, op: 'create', recordId, fields });
          if (r.status !== 'applied') throw new RowFailure(`${entity}: ${r.reason ?? r.code}`);
          made.push({ entity, id: recordId });
          return recordId;
        };
        const f = { ...row.clean.fields, owner: batch.actor };
        const lost = f.stage === 'lost';
        f.stage_changed_at = f.stage_changed_at ?? at;
        if (lost) f.closed_at = at;
        const leadId = apply('lead', f);
        // D8c: every imported lead goes in Email Outreach (the research and outreach history), unless that
        // campaign was deleted since.
        if (campaignLive()) apply('lead_campaign', { lead_id: leadId, campaign_id: CAMPAIGN_IDS.email_outreach });
        for (const a of row.clean.activities) {
          apply('lead_activity', {
            lead_id: leadId, type: a.type, body: a.body, at: a.at ?? at,
            ...(a.stage_from ? { stage_from: a.stage_from, stage_to: a.stage_to } : {}),
          });
        }
        if (row.clean.task) {
          apply('task', {
            title: row.clean.task.title, notes: row.clean.task.notes, owner: batch.actor, business_id: BUSINESS_IDS.agency,
            due_date: row.clean.task.due_date, lead_id: leadId,
          });
          tally.tasks += 1;
        }
        q.insertRow.run({
          source_key: row.key, batch_id: batch.id, row_number: row.rowNumber, lead_id: leadId,
          record_ids: JSON.stringify(made), created_at: nowIso(),
        });
        tally.imported += 1;
        if (lost) tally.lost += 1;
        tally.records += made.length;
      })();
    } catch (err) {
      if (!(err instanceof RowFailure)) throw err;
      tally.failed += 1;
      if (tally.problemList.length < PROBLEMS_KEPT) tally.problemList.push({ row: row.rowNumber, reason: err.message });
    }
  }

  /**
   * POST /leads/import/commit { batchId, text, fileName? } -> the batch (what was made, skipped, failed).
   * The same batch id with the same file again (a lost answer) returns that batch; another file under that id is refused.
   * @returns {{ batch: object, started: boolean }}
   */
  function commit({ actor, body }) {
    const batchId = body?.batchId;
    if (!isId(batchId)) throw new HttpError(400, 'batchId must be a record id made by the page');
    const hash = sha256(JSON.stringify([typeof body?.text === 'string' ? sha256(body.text) : null, body?.fileName ?? null]));
    const existing = q.batch.get(batchId);
    if (existing) {
      if (existing.request_hash !== hash) {
        throw new HttpError(409, 'This import was started with another file. Preview again, then import.', null, { code: 'batch_mismatch' });
      }
      return { batch: batchView(existing), started: false };
    }
    const req = readRequest(body);
    const rows = analyse(req);
    const batch = { id: batchId, file_name: req.fileName, actor, request_hash: hash, total_rows: rows.length, started_at: nowIso() };
    q.insertBatch.run(batch);
    const tally = { imported: 0, lost: 0, skipped: 0, failed: 0, tasks: 0, records: 0, problemList: [] };
    const save = () => q.progress.run({
      id: batchId, imported: tally.imported, lost: tally.lost, skipped: tally.skipped, failed: tally.failed, tasks: tally.tasks,
      records: tally.records, problems: tally.problemList.length ? JSON.stringify(tally.problemList) : null,
    });
    const at = nowIso();
    try {
      for (let i = 0; i < rows.length; i += LEAD_IMPORT_CHUNK) {
        db.transaction(() => {
          for (const row of rows.slice(i, i + LEAD_IMPORT_CHUNK)) {
            if (row.status === 'new') commitRow(batch, row, tally, at);
            else tally.skipped += 1;
          }
          save();
        })();
      }
    } finally {
      q.finish.run(nowIso(), batchId);
    }
    log?.info(`lead import ${batchId} (${req.fileName ?? 'no name'}): ${tally.imported} leads (${tally.lost} lost), ${tally.tasks} tasks, ${tally.skipped} skipped, ${tally.failed} failed`);
    return { batch: batchView(q.batch.get(batchId)), started: true };
  }

  return { preview, commit, getBatch: (id) => (isId(id) ? batchView(q.batch.get(id)) : null), limits };
}
