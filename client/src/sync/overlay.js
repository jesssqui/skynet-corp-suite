// How records are shown: the server's truth as last pulled, with this device's own
// changes replayed on top until a complete pull has brought them back from the server.
// Pure functions (no IndexedDB), so they are easy to test.

/** The seq part of a pull cursor ("<generation>.<seq>") if it is from `generation`, else 0. */
export function cursorSeq(cursor, generation) {
  if (typeof cursor !== 'string') return 0;
  const dot = cursor.lastIndexOf('.');
  if (dot < 0 || cursor.slice(0, dot) !== generation) return 0;
  const n = Number(cursor.slice(dot + 1));
  return Number.isSafeInteger(n) ? n : 0;
}

const byHlc = (a, b) => (a.step.hlc < b.step.hlc ? -1 : a.step.hlc > b.step.hlc ? 1 : 0);

/**
 * The changes to replay for one entity, oldest first (device order = HLC order):
 *  - outbox steps (not accepted yet, or waiting for their record): shown as "pending";
 *  - accepted steps whose effect a complete pull hasn't brought back yet (same generation,
 *    server seq after the `seen` cursor): only what the server applied (`applied` fields of a
 *    clash, a delete that wasn't kept), so a change that lost a clash isn't shown as if it won.
 */
export function changesFor(entity, { outbox = [], sent = [], generation = null, seen = null } = {}) {
  const seenSeq = cursorSeq(seen, generation);
  const out = [];
  for (const s of sent) {
    if (s.step.entity === entity && s.generation === generation && s.seq > seenSeq) out.push({ step: s.step, acked: s });
  }
  for (const o of outbox) if (o.step.entity === entity) out.push({ step: o.step, pending: true });
  return out.sort(byHlc);
}

function blankFields(fieldNames, fields) {
  const out = {};
  for (const name of fieldNames) out[name] = null;
  return Object.assign(out, fields);
}

/**
 * Apply changes to pulled records.
 * @param {Array<{id, fields, flagged?, clashes?}>} records  the pulled copy for one entity
 * @param {Array} changes  from changesFor()
 * @param {string[]} fieldNames  the entity's synced fields (a create shows every field, null when not given)
 * @returns {Map<string, {id, fields, flagged, clashes, pending, local}>}
 */
export function overlay(records, changes, fieldNames = []) {
  const map = new Map();
  for (const r of records) {
    map.set(r.id, { id: r.id, fields: { ...r.fields }, flagged: Boolean(r.flagged), clashes: r.clashes ?? [], pending: false, local: false });
  }
  for (const { step, acked, pending } of changes) {
    const rec = map.get(step.recordId);
    if (step.op === 'create') {
      if (rec) continue; // already in the pulled copy
      if (acked && acked.status !== 'applied') continue;
      map.set(step.recordId, {
        id: step.recordId, fields: blankFields(fieldNames, step.fields ?? {}),
        flagged: false, clashes: [], pending: Boolean(pending), local: true,
      });
      continue;
    }
    if (!rec) continue; // its record isn't here: deleted, or its create was refused
    if (step.op === 'update') {
      const fields = step.fields ?? {};
      const names = acked
        ? (acked.applied ?? (acked.status === 'applied' ? Object.keys(fields) : []))
        : Object.keys(fields);
      for (const name of names) if (Object.hasOwn(fields, name)) rec.fields[name] = fields[name];
      if (pending) rec.pending = true;
    } else if (step.op === 'delete') {
      if (acked && (acked.kept || acked.status !== 'applied')) continue; // the server kept it (clash)
      map.delete(step.recordId);
    }
  }
  return map;
}

/** What callers get: the fields at the top level, sync state under `_sync` (never a field name). */
export function toView(entity, rec) {
  return {
    id: rec.id,
    ...rec.fields,
    _sync: { entity, pending: rec.pending, local: rec.local, flagged: rec.flagged, clashes: rec.clashes },
  };
}
