// What linking an Order Manager customer changed, and undoing it (D2). Every link — made by a person
// (Link, Create a client), automatically (matching) or on a device — records here, in the same
// transaction as each change, what it did besides the link itself: the account it made (and the
// client and contact for "Create a client"), the age-restricted mark it set, the wholesale
// relationship it made. Undo deletes the link, detaches the customer (its records leave the timeline;
// the holding area keeps them) and puts each of those back — but only what is still as the link left
// it and that nothing else uses since; whatever stays is said, with why. See CLAUDE.md, "Matching (D2)".
import { newId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { HttpError } from '../../lib/httpError.js';

const CHANGES = Object.freeze(['attached', 'age_restricted', 'relationship_created', 'account_created', 'client_created', 'contact_created']);
const PEOPLE = new Set(['owner', 'partner']);
const json = (v) => (v === undefined ? null : JSON.stringify(v));
const parse = (s) => {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
};
const quote = (s) => `“${s}”`;

export function createLinkChanges({ db, crm, planner, sync, clock }) {
  const now = () => nowIso(new Date(clock()));
  const q = {
    insert: db.prepare(`INSERT INTO wholesale_link_changes (id, customer_uid, link_id, account_id, change, entity, record_id, before, after, at, actor)
      VALUES (@id, @customer_uid, @link_id, @account_id, @change, @entity, @record_id, @before, @after, @at, @actor)`),
    setLink: db.prepare('UPDATE wholesale_link_changes SET link_id = ? WHERE customer_uid = ? AND link_id IS NULL AND undone_at IS NULL'),
    ofLinks: db.prepare(`SELECT * FROM wholesale_link_changes WHERE undone_at IS NULL
      AND link_id IN (SELECT value FROM json_each(?)) ORDER BY at, id`),
    done: db.prepare('UPDATE wholesale_link_changes SET undone_at = ?, undone_by = ?, outcome = ? WHERE id = ?'),
    attachedElsewhere: db.prepare('SELECT count(*) AS n FROM wholesale_held_customers WHERE account_id = ? AND uid <> ?'),
    // A link with no 'attached' row was attached before D2 kept track (or isn't attached yet).
    tracked: db.prepare("SELECT 1 FROM wholesale_link_changes WHERE link_id = ? AND change = 'attached' LIMIT 1"),
  };

  /**
   * Remember one change a link made (call it inside the change's own transaction). `after` is read
   * back from the record as stored, so "still as the link left it" compares like with like.
   */
  function record({ customerUid, linkId = null, accountId = null, change, entity, recordId, before = undefined, after = undefined, actor = 'system' }) {
    if (!CHANGES.includes(change)) throw new Error(`unknown link change ${change}`);
    const stored = after === undefined && entity !== 'link' ? crm.liveRecord(entity, recordId) : after;
    q.insert.run({
      id: newId(), customer_uid: customerUid, link_id: linkId, account_id: accountId, change, entity, record_id: recordId,
      before: json(before), after: json(stored ? fieldsOnly(stored) : stored), at: now(), actor,
    });
  }

  /** Changes recorded before their link existed ("Create a client": the client comes first) get its id. */
  const setLink = (customerUid, linkId) => q.setLink.run(linkId, customerUid);

  function fieldsOnly(rec) {
    const { id, created_at: _ca, created_by: _cb, updated_at: _ua, updated_by: _ub, _sync, ...fields } = rec; // eslint-disable-line no-unused-vars
    return fields;
  }

  /** Is the live record still as written (ignoring fields a later change of this link set)? */
  function asMade(row, ignore = []) {
    const current = crm.liveRecord(row.entity, row.record_id);
    if (!current) return { live: false };
    const after = parse(row.after) ?? {};
    const fields = fieldsOnly(current);
    for (const [k, v] of Object.entries(fields)) {
      if (ignore.includes(k)) continue;
      if ((after[k] ?? null) !== (v ?? null)) return { live: true, same: false, current };
    }
    return { live: true, same: true, current };
  }

  const peopleTasks = (who) => (planner?.tasksNaming ? planner.tasksNaming(who).filter((t) => PEOPLE.has(t.created_by)) : []);
  const subset = (ids, allowed) => ids.every((id) => allowed.has(id));

  /**
   * What undoing `links` (the customer's live account links) would do, without doing it:
   * { tracked, steps: [{ kind: 'restore_age' | 'delete', entity, id, value?, row }], restore: [text], keep: [text], rows }.
   */
  function plan(customerUid, links) {
    const linkIds = links.map((l) => l.id);
    const rows = q.ofLinks.all(JSON.stringify(linkIds));
    const tracked = linkIds.some((id) => q.tracked.get(id));
    const of = (change) => rows.filter((r) => r.change === change);
    const steps = [];
    const restore = [];
    const keep = [];
    const linkSet = new Set(linkIds);
    const madeAccounts = new Set(of('account_created').map((r) => r.record_id));
    const madeContacts = new Set(of('contact_created').map((r) => r.record_id));
    const madeRels = new Set(of('relationship_created').map((r) => r.record_id));
    const ageOn = new Set(of('age_restricted').map((r) => r.record_id));
    const otherCustomer = (accountId) => q.attachedElsewhere.get(accountId, customerUid).n > 0;
    const deleting = new Set(); // ids removed by this undo (their children go with them)

    // An account the link made: removed when still as made, nothing else added to it, no other
    // Order Manager customer on it and no task of yours naming it. Its relationship goes with it.
    const accountVerdict = (row) => {
      const st = asMade(row, ageOn.has(row.record_id) ? ['age_restricted'] : []);
      if (!st.live) return { gone: true };
      const name = st.current.name;
      if (!st.same) return { keep: `The account ${quote(name)} the link made stays: it was changed since` };
      if (otherCustomer(row.record_id)) return { keep: `The account ${quote(name)} the link made stays: another Order Manager customer is linked to it` };
      const u = crm.usageOf('account', row.record_id);
      if (u.activities.length || u.services.length || !subset(u.contacts, madeContacts) || !subset(u.relationships, madeRels) || !subset(u.links, linkSet)) {
        return { keep: `The account ${quote(name)} the link made stays: contacts, notes, services or links were added to it` };
      }
      if (peopleTasks({ accountId: row.record_id }).length) return { keep: `The account ${quote(name)} the link made stays: a task names it` };
      return { remove: `The account ${quote(name)} the link made is removed`, name };
    };

    const clientRow = of('client_created')[0];
    let clientRemoved = false;
    if (clientRow) {
      const st = asMade(clientRow);
      if (st.live) {
        const name = st.current.name;
        const u = crm.usageOf('client', clientRow.record_id);
        const accounts = of('account_created').filter((r) => u.accounts.includes(r.record_id)).map(accountVerdict);
        let why = null;
        if (!st.same) why = 'it was changed since';
        else if (u.activities.length || u.services.length || u.consents.length) why = 'notes, services or consent were added to it';
        else if (!subset(u.accounts, madeAccounts) || !subset(u.contacts, madeContacts)) why = 'accounts or contacts were added to it';
        else if (!subset(u.relationships, madeRels) || !subset(u.links, linkSet)) why = 'relationships or links were added to it';
        else if (accounts.some((v) => v.keep)) why = 'its account was changed or used since';
        else if (peopleTasks({ clientId: clientRow.record_id }).length) why = 'a task names it';
        else {
          for (const id of madeContacts) {
            const c = rows.find((r) => r.record_id === id);
            if (c && !asMade(c).same) { why = 'its contact was changed since'; break; }
          }
        }
        if (why) keep.push(`The client ${quote(name)} the link made stays: ${why}`);
        else {
          clientRemoved = true;
          deleting.add(clientRow.record_id);
          for (const id of [...madeAccounts, ...madeContacts, ...madeRels]) deleting.add(id);
          steps.push({ kind: 'delete', entity: 'client', id: clientRow.record_id, row: clientRow });
          restore.push(`The client ${quote(name)} the link made is removed, with its account and contact`);
        }
      }
    }

    if (!clientRemoved) {
      for (const row of of('account_created')) {
        const v = accountVerdict(row);
        if (v.gone) continue;
        if (v.keep) { keep.push(v.keep); continue; }
        deleting.add(row.record_id);
        for (const r of of('relationship_created')) if (r.account_id === row.record_id) deleting.add(r.record_id);
        steps.push({ kind: 'delete', entity: 'account', id: row.record_id, row });
        restore.push(v.remove);
      }
      // "Create a client" kept its client (something was added): its contact goes when untouched and unused.
      for (const row of of('contact_created')) {
        const st = asMade(row);
        if (!st.live) continue;
        const u = crm.usageOf('contact', row.record_id);
        if (!st.same || u.consents.length || u.links.length) {
          keep.push(`The contact ${quote(st.current.name)} the link made stays: it was changed or used since`);
          continue;
        }
        steps.push({ kind: 'delete', entity: 'contact', id: row.record_id, row });
        restore.push(`The contact ${quote(st.current.name)} the link made is removed`);
      }
    }

    for (const row of of('relationship_created')) {
      if (deleting.has(row.record_id) || deleting.has(row.account_id)) continue;
      const st = asMade(row);
      if (!st.live) continue;
      const account = crm.liveRecord('account', row.account_id);
      const what = `The wholesale relationship of ${quote(account?.name ?? 'the account')}`;
      let why = null;
      if (!st.same) why = 'it was changed since';
      else if (otherCustomer(row.account_id)) why = 'another Order Manager customer is still linked to the account';
      else if (crm.usageOf('relationship', row.record_id).services.length) why = 'it has a service now';
      else if (peopleTasks({ relationshipId: row.record_id }).length) why = 'a task of yours names it';
      if (why) keep.push(`${what} stays: ${why}`);
      else {
        steps.push({ kind: 'delete', entity: 'relationship', id: row.record_id, row });
        restore.push(`${what}, made by the link, is removed`);
      }
    }

    for (const row of of('age_restricted')) {
      if (deleting.has(row.record_id)) continue;
      const account = crm.liveRecord('account', row.record_id);
      if (!account) continue;
      const before = parse(row.before)?.age_restricted ?? null;
      if (account.age_restricted !== true) {
        keep.push(`The age-restricted mark of ${quote(account.name)} was changed since: left as it is`);
      } else if (otherCustomer(row.record_id)) {
        keep.push(`${quote(account.name)} stays age-restricted: another Order Manager customer is still linked to it`);
      } else {
        steps.push({ kind: 'restore_age', entity: 'account', id: row.record_id, value: before, row });
        restore.push(`${quote(account.name)} is no longer marked age-restricted (as before the link)`);
      }
    }

    if (!tracked) {
      keep.push('Only the link is undone: it was made before the suite kept track of what linking changes, so the account keeps its age-restricted mark and wholesale relationship');
    }
    return { tracked, steps, restore, keep, rows };
  }

  /**
   * Carry out a plan (inside the caller's transaction, after the links are deleted and the customer is
   * detached): each step through sync as `actor`, every recorded change of these links marked undone.
   */
  function apply(planned, { actor }) {
    const write = (args) => {
      const r = sync.applyLocal({ actor, ...args });
      if (!['applied', 'clash'].includes(r.status)) throw new HttpError(409, r.reason ?? `${args.entity}: ${r.code}`, undefined, { code: r.code });
    };
    const outcome = new Map();
    for (const s of planned.steps) {
      if (s.kind === 'restore_age') write({ entity: 'account', op: 'update', recordId: s.id, fields: { age_restricted: s.value } });
      else write({ entity: s.entity, op: 'delete', recordId: s.id });
      outcome.set(s.row.id, s.kind === 'restore_age' ? 'put back' : 'removed');
    }
    const at = now();
    for (const r of planned.rows) q.done.run(at, actor, outcome.get(r.id) ?? 'left as it is', r.id);
  }

  return { record, setLink, plan, apply };
}
