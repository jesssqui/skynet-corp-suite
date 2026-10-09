// Matching and suggestions (D2), the server side: the automatic links, the review list (Order Manager
// customers waiting for a client beside the clients they may be, and possible duplicate clients inside
// the CRM), and people's decisions ("Not the same"). The rules are pure in matching.js; this reads
// the CRM (crm.matchingRecords), the holding area (own tables) and the decisions, once per change —
// the result is kept until something changes (the sync log's seq, the held customers, a decision).
// See CLAUDE.md, "Matching (D2)".
//
//  pass()        links what matches strongly and unambiguously, through the automation
//                'wholesale-auto-link' (on, alert: one in-app alert per pass that linked anything),
//                then attaches the customers (reconcile). Runs after each request from the Order
//                Manager (its customers), every minute after the reconciler (clients changed on a
//                device), and at start.
//  suggestions() / duplicates() / counts() / dismissed()   the review page and the Friday review.
//  notSame() / clearNotSame() / markUndone()               the decisions (wholesale_match_decisions).
import { newId, isId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { HttpError } from '../../lib/httpError.js';
import { buildCrmIndex, matchCustomer, duplicateClients, clientSummary, customerContact, pairKey, demoteShared } from './matching.js';

export const AUTO_LINK_ID = 'wholesale-auto-link';
export const AUTO_LINK_EVENT = 'wholesale.auto_link';
const APP = 'wom';
const RECONCILE_ONLY_MAX = 50; // more links at once than this are attached by the chunked reconcileAll
const ALERT_LINES = 5;

const parse = (s) => {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function createMatchService({ db, log, clock, crm, sync, services, figuresOf, reconcile, reconcileAll }) {
  const now = () => nowIso(new Date(clock()));
  const q = {
    waiting: db.prepare('SELECT * FROM wholesale_held_customers WHERE account_id IS NULL AND gone = 0 AND link_problem IS NULL ORDER BY uid'),
    customer: db.prepare('SELECT * FROM wholesale_held_customers WHERE uid = ?'),
    held: db.prepare(`SELECT count(*) AS n, max(updated_at) AS u, sum(account_id IS NULL) AS w, max(attached_at) AS t,
      sum(link_problem IS NOT NULL) AS p FROM wholesale_held_customers`),
    decisions: db.prepare('SELECT * FROM wholesale_match_decisions'),
    notSame: db.prepare(`INSERT INTO wholesale_match_decisions (kind, a, b, not_same_at, not_same_by, not_same_device)
      VALUES (@kind, @a, @b, @at, @actor, @device)
      ON CONFLICT (kind, a, b) DO UPDATE SET not_same_at = excluded.not_same_at, not_same_by = excluded.not_same_by,
        not_same_device = excluded.not_same_device`),
    undone: db.prepare(`INSERT INTO wholesale_match_decisions (kind, a, b, undone_at, undone_by) VALUES ('customer', @a, @b, @at, @actor)
      ON CONFLICT (kind, a, b) DO UPDATE SET undone_at = excluded.undone_at, undone_by = excluded.undone_by`),
    clearNotSame: db.prepare(`UPDATE wholesale_match_decisions SET not_same_at = NULL, not_same_by = NULL, not_same_device = NULL
      WHERE kind = ? AND a = ? AND b = ?`),
    prune: db.prepare('DELETE FROM wholesale_match_decisions WHERE not_same_at IS NULL AND undone_at IS NULL'),
    dismissed: db.prepare('SELECT * FROM wholesale_match_decisions WHERE not_same_at IS NOT NULL ORDER BY not_same_at DESC, a, b LIMIT ?'),
  };

  /** A held customer as matching sees it (the address and contact problems are in its snapshot). */
  function customerOf(row) {
    const s = parse(row.snapshot) ?? {};
    return {
      uid: row.uid, number: row.number, businessName: row.business_name, contactName: row.contact_name,
      email: row.email, phone: row.phone, contactProblems: s.contact_problems ?? [], address: s.address ?? null,
      gone: row.gone === 1, linkProblem: row.link_problem,
    };
  }

  // ---- the matching state, kept until something changes ------------------------------------------
  let decisionsVersion = 0;
  let cache = null;
  const fingerprint = () => {
    const h = q.held.get();
    return `${sync.info().seq}|${h.n}|${h.u}|${h.w}|${h.t}|${h.p}|${decisionsVersion}`;
  };

  function state() {
    const fp = fingerprint();
    if (cache?.fp === fp) return cache;
    const started = performance.now();
    const index = buildCrmIndex(crm.matchingRecords());
    const decided = new Map(q.decisions.all().map((r) => [`${r.kind}|${r.a}|${r.b}`, { notSame: Boolean(r.not_same_at), undone: Boolean(r.undone_at) }]));
    const linkedAccounts = new Set(crm.liveAccountLinks(APP).map((l) => l.account_id));
    // Two customers matching one client automatically: neither is linked (demoteShared).
    const results = demoteShared(q.waiting.all().map(customerOf).map((customer) => ({
      customer,
      ...matchCustomer(customer, index, { decision: (clientId) => decided.get(`customer|${customer.uid}|${clientId}`) ?? null, linkedAccounts }),
    })));
    const duplicates = duplicateClients(index, { notSame: (a, b) => decided.get(`clients|${a}|${b}`)?.notSame });
    cache = { fp, index, results, duplicates, ms: Math.round(performance.now() - started) };
    return cache;
  }

  // ---- the automatic links -----------------------------------------------------------------------
  const autoEnabled = () => Boolean(services.automations?.get?.(AUTO_LINK_ID)?.enabled);

  function planOf(result, index) {
    const client = index.clientsById.get(result.auto.clientId);
    const account = index.accountsById.get(result.auto.accountId);
    const who = result.customer.businessName || result.customer.contactName || `Customer #${result.customer.number ?? '?'}`;
    return {
      uid: result.customer.uid, clientId: client.id, accountId: account.id, reason: result.auto.reason,
      label: `${who} → ${client.name}${account.name !== client.name ? ` (${account.name})` : ''}`,
    };
  }

  function currentPlans(only = null) {
    const st = state();
    return st.results.filter((r) => r.auto && (!only || only.has(r.customer.uid))).map((r) => planOf(r, st.index));
  }

  /** Attach freshly linked customers: a few at once now, many in the chunked background pass. */
  function afterLinks(uids) {
    if (!uids.length) return;
    try {
      if (uids.length <= RECONCILE_ONLY_MAX) reconcile({ only: uids, actor: 'system' });
      else reconcileAll({ actor: 'system' }).catch((err) => log?.error?.('attaching the automatic links failed (tried again within a minute):', err));
    } catch (err) {
      log?.error?.('attaching the automatic links failed (tried again within a minute):', err);
    }
  }

  /**
   * One pass: link every waiting customer (or those in `only`) that matches strongly and unambiguously,
   * through the automation (its switch, run log and alert), then attach them. → { linked: uids }.
   */
  function pass({ only = null } = {}) {
    if (!services.automations?.emit || !autoEnabled()) return { linked: [] };
    let onlySet = null;
    if (only) {
      // Cheap first look: only a waiting customer with a clean email or phone can be linked automatically.
      onlySet = new Set([...only].filter((uid) => {
        const row = q.customer.get(uid);
        if (!row || row.account_id || row.gone || row.link_problem) return false;
        const c = customerContact(customerOf(row));
        return Boolean(c.email || c.phone);
      }));
      if (!onlySet.size) return { linked: [] };
    }
    const plans = currentPlans(onlySet);
    if (!plans.length) return { linked: [] };
    services.automations.emit(AUTO_LINK_EVENT, { key: newId(), name: AUTO_LINK_EVENT, plans });
    const linked = plans.filter((p) => crm.liveLinks(APP, p.uid).some((l) => l.account_id === p.accountId && l.matched_by === 'auto')).map((p) => p.uid);
    afterLinks(linked);
    return { linked };
  }

  if (services.automations) {
    services.automations.register({
      id: AUTO_LINK_ID,
      name: 'Link Order Manager customers automatically',
      module: 'wholesale',
      description: 'Links an Order Manager customer waiting for a client to the client one of whose contacts has the same email or '
        + 'phone — only when exactly one active client of Wholesale, Great White North Design or Business consulting has it, the '
        + 'account is clear and no other waiting customer matches that client too. Anything weaker — a similar name, the same address, '
        + 'two clients with the same email, a client with no business yet — waits on Wholesale → Suggestions. Every link can be undone '
        + '(Wholesale → Linked, or the client’s account).',
      trigger: {
        type: 'event',
        event: AUTO_LINK_EVENT,
        label: 'When the Order Manager sends a customer, and within a minute of a client’s contacts changing',
        key: (data) => data.key,
        accept: (data) => Array.isArray(data?.plans) && data.plans.length > 0,
      },
      defaults: { enabled: true, alert: true },
      alertLink: '/wholesale?tab=linked',
      run(_ctx, { data, create }) {
        const manual = !data?.plans;
        const plans = manual ? currentPlans() : data.plans;
        const made = [];
        // Accounts with an Order Manager link now (as matchCustomer's rule), and the accounts and clients this
        // run links: never two customers at once (state() already makes such pairs suggestions; this is the guard).
        const taken = new Set(crm.liveAccountLinks(APP).map((l) => l.account_id));
        for (const p of plans) {
          // As things are now: still waiting, not linked meanwhile, the account still the client's and free.
          const row = q.customer.get(p.uid);
          if (!row || row.account_id || row.gone || row.link_problem || crm.liveLinks(APP, p.uid).length) continue;
          const account = crm.liveAccount(p.accountId);
          if (!account || account.client_id !== p.clientId || taken.has(p.accountId) || taken.has(p.clientId)) continue;
          taken.add(p.accountId);
          taken.add(p.clientId);
          create('link', { account_id: p.accountId, app: APP, external_id: p.uid, matched_by: 'auto', match_reason: p.reason }, { key: p.uid });
          made.push(p);
        }
        if (manual && made.length) setImmediate(() => afterLinks(made.map((p) => p.uid)));
        if (!made.length) return { summary: manual ? 'No customer to link automatically' : 'Nothing to link: linked meanwhile' };
        const title = `Linked ${plural(made.length, 'Order Manager customer')} automatically`;
        const lines = made.slice(0, ALERT_LINES).map((p) => `${p.label} · ${p.reason}`);
        if (made.length > ALERT_LINES) lines.push(`and ${made.length - ALERT_LINES} more`);
        lines.push('Undo any of them on Wholesale → Linked.');
        return { summary: title, alert: { title, body: lines.join('\n'), link: '/wholesale?tab=linked' } };
      },
    });
  }

  // ---- the review list ---------------------------------------------------------------------------
  function customerView(c) {
    const f = figuresOf(c.uid);
    return {
      uid: c.uid, number: c.number, businessName: c.businessName, contactName: c.contactName, email: c.email, phone: c.phone,
      address: c.address, contactProblems: c.contactProblems, orders: f.order_count, lastOrderDate: f.last_order_date,
      spendCents: f.spend_cents,
    };
  }

  /** Every suggested pair (customer, client), strongest first. */
  function pairs() {
    const st = state();
    const enabled = autoEnabled();
    const out = [];
    for (const r of st.results) {
      if (r.auto) {
        out.push({
          customer: r.customer, clientId: r.auto.clientId, accountId: r.auto.accountId, strong: true, auto: true,
          reasons: r.auto.reasons,
          why: enabled ? 'Links automatically within a minute' : 'Linking automatically is switched off (System → Automations)',
        });
      }
      for (const s of r.suggestions) out.push({ customer: r.customer, ...s, auto: false });
    }
    const name = (p) => String(p.customer.businessName ?? '');
    return out.sort((x, y) => (y.strong - x.strong) || (y.reasons.length - x.reasons.length) || name(x).localeCompare(name(y)));
  }

  /** The review list's customers tab: { suggestions: [{ customer, client, accountId, strong, auto, reasons, why }], total }. */
  function suggestions({ limit = 50, offset = 0 } = {}) {
    const st = state();
    const all = pairs();
    return {
      suggestions: all.slice(offset, offset + limit).map((p) => ({
        customer: customerView(p.customer),
        client: clientSummary(st.index, p.clientId),
        accountId: p.accountId,
        strong: p.strong,
        auto: p.auto,
        reasons: p.reasons,
        why: p.why,
      })),
      total: all.length,
      limit,
      offset,
    };
  }

  /** Possible duplicate clients: { duplicates: [{ a, b, reasons }], total } (a, b: client summaries). */
  function duplicates({ limit = 50, offset = 0 } = {}) {
    const st = state();
    return {
      duplicates: st.duplicates.slice(offset, offset + limit).map((d) => ({
        a: clientSummary(st.index, d.a), b: clientSummary(st.index, d.b), reasons: d.reasons,
      })),
      total: st.duplicates.length,
      limit,
      offset,
    };
  }

  /** For the Friday review and the tab: customers with a suggestion, pairs, duplicate clients. */
  function counts() {
    const st = state();
    const all = pairs();
    return {
      customers: new Set(all.map((p) => p.customer.uid)).size,
      pairs: all.length,
      duplicates: st.duplicates.length,
      total: new Set(all.map((p) => p.customer.uid)).size + st.duplicates.length,
      autoLinking: autoEnabled(),
    };
  }

  /** "Not the same" decisions, newest first, with names (for "Show dismissed" → "Suggest again"). */
  function dismissed({ limit = 200 } = {}) {
    const rows = q.dismissed.all(limit);
    const clientIds = rows.flatMap((r) => (r.kind === 'customer' ? [r.b] : [r.a, r.b]));
    const names = crm.clientNames(clientIds);
    const label = (id) => names.get(id)?.name ?? 'A client no longer here';
    return {
      dismissed: rows.map((r) => {
        const c = r.kind === 'customer' ? q.customer.get(r.a) : null;
        return {
          kind: r.kind, a: r.a, b: r.b, at: r.not_same_at, by: r.not_same_by,
          first: r.kind === 'customer' ? (c?.business_name || c?.contact_name || `Order Manager customer #${c?.number ?? '?'}`) : label(r.a),
          second: label(r.b),
        };
      }),
    };
  }

  // ---- decisions -----------------------------------------------------------------------------------
  function pairOf({ kind, a, b }) {
    if (kind === 'customer') {
      if (!isId(a) || !q.customer.get(a)) throw new HttpError(404, 'No such Order Manager customer here', undefined, { code: 'not_found' });
      if (!isId(b)) throw new HttpError(400, 'b must be a client id', undefined, { code: 'bad_pair' });
      return { kind, a, b };
    }
    if (kind === 'clients') {
      if (!isId(a) || !isId(b) || a === b) throw new HttpError(400, 'a and b must be two client ids', undefined, { code: 'bad_pair' });
      const [x, y] = pairKey(a, b);
      return { kind, a: x, b: y };
    }
    throw new HttpError(400, 'kind must be customer or clients', undefined, { code: 'bad_pair' });
  }

  /** "Not the same": the pair is never suggested again (nor linked automatically) until cleared. */
  function notSame(pair, { actor, deviceId = null }) {
    const p = pairOf(pair);
    q.notSame.run({ ...p, at: now(), actor, device: deviceId });
    decisionsVersion += 1;
    log?.info?.(`not the same (${p.kind}): ${p.a} / ${p.b}, by ${actor}`);
    return p;
  }

  /** "Suggest again": forget a "Not the same" (an undone link still keeps them from linking automatically). */
  function clearNotSame(pair) {
    const p = pairOf(pair);
    db.transaction(() => {
      q.clearNotSame.run(p.kind, p.a, p.b);
      q.prune.run();
    })();
    decisionsVersion += 1;
    return p;
  }

  /** A link between them was undone (inside the undo's transaction): never linked automatically again. */
  function markUndone(customerUid, clientId, actor) {
    q.undone.run({ a: customerUid, b: clientId, at: now(), actor });
    decisionsVersion += 1;
  }

  return { pass, state, suggestions, duplicates, counts, dismissed, notSame, clearNotSame, markUndone };
}
