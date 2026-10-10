// Wholesale (/wholesale, D1): the Order Manager's customers the suite has heard of.
//   Waiting for a client: customers with no link yet — everything they send is kept on the server
//     and attached the moment they are linked. Link one to an existing client (one of its accounts,
//     or a new account under it), or make a client from it.
//   Linked: customers attached to an account — how (D2: "Linked automatically (same email)", or by
//     whom) — with Undo link (its records leave the timeline; the server keeps them, so linking again
//     brings them all back; what linking changed is put back).
//   Suggestions (D2): customers that may be a client already, side by side, with Link… / Not the same,
//     and possible duplicate clients (MatchesTab.jsx).
// The lists come from the server (the holding area isn't synced), so this page needs a connection;
// picking a client uses this device's own copy of the CRM.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatPhone } from '@suite/shared/normalize';
import { PageHeader, Card, Button, Badge, Notice, EmptyState, Segmented, SelectField, Sheet, TextField, Icon } from '../../ui/index.js';
import { formatDate } from '../../ui/format.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { store } from '../../sync/index.js';
import { useClientListData } from '../crm/data.js';
import { buildClientIndex, filterClients, formatMoney } from '../crm/logic.js';
import { useAuth } from '../../auth/session.jsx';
import { linkHowText } from './logic.js';
import MatchesTab from './MatchesTab.jsx';
import UndoLinkSheet from './UndoLinkSheet.jsx';
import '../crm/crm.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const TAB_VALUES = ['waiting', 'linked', 'suggestions'];
const NEW_ACCOUNT = '__new__';

const syncSoon = () => { try { store.syncNow(); } catch { /* signed out meanwhile */ } };

function Facts({ c }) {
  const bits = [`${c.orders} order${c.orders === 1 ? '' : 's'}`, `spend ${formatMoney(c.spendCents) || '$0'}`];
  if (c.lastOrderDate) bits.push(`last order ${formatDate(c.lastOrderDate)}`);
  // D5: its notes from the Order Manager wait here too, and its follow-up date (a task once it is linked).
  if (c.notes) bits.push(`${c.notes} note${c.notes === 1 ? '' : 's'} waiting`);
  if (c.followUpDate) bits.push(`follow-up ${formatDate(c.followUpDate)}`);
  return <span style={{ ...muted, fontVariantNumeric: 'tabular-nums' }}>{bits.join(' · ')}</span>;
}

function Who({ c }) {
  const contact = [c.contactName, c.email, c.phone ? formatPhone(c.phone) : null, c.city].filter(Boolean);
  return (
    <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
      <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ overflowWrap: 'anywhere' }}>{c.businessName || 'No business name'}</strong>
        {c.number ? <span style={muted}>#{c.number}</span> : null}
        {c.gone ? <Badge tone="warn">Deleted in the Order Manager</Badge> : null}
        {c.linkProblem ? <Badge tone="danger">Linked to more than one account</Badge> : null}
      </span>
      {contact.length ? <span style={{ ...muted, overflowWrap: 'anywhere' }}>{contact.join(' · ')}</span> : null}
      {c.contactProblems?.length ? (
        <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>
          {c.contactProblems.map((p) => `${p.field === 'email' ? 'Email' : 'Phone'} “${p.as_typed}” couldn’t be cleaned there`).join(' · ')}
        </span>
      ) : null}
      <Facts c={c} />
    </div>
  );
}

/**
 * Pick a client from this device's copy, then one of its accounts (or a new one). From a suggestion
 * (D2) `initial` = { clientId, accountId, reason }: that client and account picked, the reason kept on the link.
 */
function LinkSheet({ customer, initial = null, onClose, onDone }) {
  const { data } = useClientListData();
  const [q, setQ] = useState(customer.businessName ?? '');
  const [clientId, setClientId] = useState(initial?.clientId ?? null);
  const [accountId, setAccountId] = useState(initial?.accountId ?? NEW_ACCOUNT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const index = useMemo(() => (data ? buildClientIndex(data) : []), [data]);
  const matches = useMemo(() => filterClients(index, { q, status: 'all' }).slice(0, 8), [index, q]);
  const accounts = useMemo(() => (data && clientId ? data.accounts.filter((a) => a.client_id === clientId) : []), [data, clientId]);
  const chosen = index.find((r) => r.client.id === clientId)?.client ?? null;
  // A suggestion with no account of its own: pick one the usual way once this device's copy is read.
  useEffect(() => {
    if (data && initial?.clientId && !initial.accountId) pick(initial.clientId);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(id) {
    setClientId(id);
    const own = data.accounts.filter((a) => a.client_id === id);
    // The account named like the customer, else the only one, else a new one.
    const same = own.find((a) => a.name.toLowerCase() === String(customer.businessName ?? '').toLowerCase());
    setAccountId(same?.id ?? (own.length === 1 ? own[0].id : NEW_ACCOUNT));
  }

  async function submit() {
    if (!clientId) return setError('Pick a client first');
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/wholesale/customers/${customer.uid}/link`, {
        clientId, accountId: accountId === NEW_ACCOUNT ? null : accountId, reason: clientId === initial?.clientId ? initial.reason ?? null : null,
      });
      syncSoon();
      onDone(chosen);
    } catch (err) {
      setError(err.status === 0 ? 'Can’t reach the suite server: nothing was linked.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={`Link ${customer.businessName ?? 'this customer'}`}
      onClose={onClose}
      onSubmit={submit}
      testId="link-sheet"
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !clientId}>{busy ? 'Linking…' : 'Link'}</Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <p style={{ ...muted, margin: 0 }}>
          Its orders, payments, returns, refunds and notes go on the client’s timeline (a follow-up date becomes a task),
          and the account is marked age-restricted with a wholesale relationship if it has none. Undo link puts it all back.
        </p>
        <TextField label="Find the client" value={q} onChange={(e) => { setQ(e.target.value); setClientId(null); }} autoComplete="off" />
        {!clientId ? (
          matches.length ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }} data-testid="client-matches">
              {matches.map((r) => (
                <li key={r.client.id}>
                  <button type="button" className="crm-link-button" onClick={() => pick(r.client.id)} style={{ textAlign: 'left', width: '100%' }}>
                    <strong>{r.client.name}</strong>{r.accountNames.length ? <span style={muted}> · {r.accountNames.join(', ')}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : <p style={{ ...muted, margin: 0 }}>{data ? 'No client matches: try another name, or close this and use Create a client.' : 'Loading clients…'}</p>
        ) : (
          <>
            <p style={{ margin: 0 }} data-testid="link-client">
              Client: <strong>{chosen?.name}</strong>{' '}
              <button type="button" className="crm-link-button" onClick={() => setClientId(null)}>Change</button>
            </p>
            <SelectField
              id="link-account"
              label="Their business (account)"
              value={accountId}
              onChange={setAccountId}
              options={[
                ...accounts.map((a) => ({ value: a.id, label: a.name })),
                { value: NEW_ACCOUNT, label: `A new account: ${customer.businessName ?? 'named after the customer'}` },
              ]}
            />
          </>
        )}
        {error ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p> : null}
      </div>
    </Sheet>
  );
}

function ConfirmSheet({ title, children, action, onClose, onConfirm, busy, error }) {
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : action}</Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {children}
        {error ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p> : null}
      </div>
    </Sheet>
  );
}

export default function WholesalePage() {
  const [params, setParams] = useSearchParams();
  const tab = TAB_VALUES.includes(params.get('tab')) ? params.get('tab') : 'waiting';
  const [q, setQ] = useState('');
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const listTab = tab === 'suggestions' ? 'waiting' : tab;
  const url = `/api/wholesale/${listTab}?limit=200${q.trim() && tab !== 'suggestions' ? `&q=${encodeURIComponent(q.trim())}` : ''}`;
  const { data, error, loading, offline, reload, checking, checkAgain } = useServerData(url);
  const matchCounts = useServerData('/api/wholesale/matches/counts');
  const suggestionCount = matchCounts.data ? matchCounts.data.pairs + matchCounts.data.duplicates : null;
  const tabs = [
    { value: 'waiting', label: 'Waiting for a client' },
    { value: 'linked', label: 'Linked' },
    { value: 'suggestions', label: suggestionCount ? `Suggestions (${suggestionCount})` : 'Suggestions' },
  ];
  const [matchesKey, setMatchesKey] = useState(0);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [done, setDone] = useState(null);

  async function act(path, message) {
    setBusy(true);
    setProblem(null);
    try {
      await api.post(path, {});
      syncSoon();
      setSheet(null);
      setDone(message);
      await Promise.all([reload(), matchCounts.reload()]);
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server: nothing changed.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  const list = data?.customers ?? [];
  const counts = data?.counts;
  return (
    <>
      <PageHeader
        title="Wholesale"
        subtitle="Order Manager customers: link each to a client, and its orders show on their timeline"
        actions={<Button onClick={() => { checkAgain(); matchCounts.reload(); setMatchesKey((k) => k + 1); }} disabled={loading || checking}>{checking ? 'Checking…' : 'Check again'}</Button>}
      />
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Segmented label="Which customers" value={tab} onChange={(v) => { setDone(null); setParams(v === 'waiting' ? {} : { tab: v }, { replace: true }); }} options={tabs} />
          {tab !== 'suggestions' ? <TextField label="Search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email or phone" style={{ flex: '1 1 220px' }} /> : null}
        </div>
        {offline ? (
          <Notice tone="warn">Can’t reach the suite server. These lists live on the server{data ? '; what you see is from the last check' : ''}, and linking waits until it’s back.</Notice>
        ) : null}
        {error && !offline ? <Notice tone="danger">{error.message}</Notice> : null}
        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        {done ? <Notice tone="ok"><span style={{ whiteSpace: 'pre-line' }} data-testid="wholesale-done">{done}</span></Notice> : null}
        {tab === 'suggestions' ? (
          <MatchesTab
            key={matchesKey}
            offline={offline}
            onLink={(s) => setSheet({ kind: 'link', customer: s.customer, initial: { clientId: s.clientId, accountId: s.accountId, reason: s.reason } })}
            onChanged={() => matchCounts.reload()}
          />
        ) : null}
        {tab === 'waiting' && counts ? (
          <p style={{ ...muted, margin: 0 }} data-testid="waiting-counts">
            {counts.customers
              ? `${counts.customers} customer${counts.customers === 1 ? '' : 's'} waiting · their ${counts.orders} order${counts.orders === 1 ? '' : 's'}, ${counts.money} payment${counts.money === 1 ? '' : 's'}, refunds or returns${counts.notes ? ` and ${counts.notes} note${counts.notes === 1 ? '' : 's'}` : ''} are kept until they are linked`
              : 'Every customer the Order Manager has sent is linked.'}
            {' '}· {counts.linked} linked
          </p>
        ) : null}
        {tab !== 'suggestions' ? (<>
        <Card padded={false}>
          {!data && loading ? <EmptyState title="Loading…" /> : null}
          {data && !list.length ? (
            tab === 'waiting'
              ? <EmptyState title={q ? 'No waiting customer matches' : 'Nobody is waiting for a client'}>New Order Manager customers show up here until they are linked.</EmptyState>
              : <EmptyState title={q ? 'No linked customer matches' : 'No customer linked yet'}>Link one from Waiting for a client.</EmptyState>
          ) : null}
          {list.length ? (
            <ul style={{ listStyle: 'none', margin: '-1px 0 0', padding: 0 }} data-testid={`${tab}-list`}>
              {list.map((c) => (
                <li key={c.uid} data-customer={c.uid} style={{ borderTop: '1px solid var(--border)', padding: 'var(--space-3) var(--space-4)', display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ flex: '1 1 260px', minWidth: 0, display: 'grid', gap: 4 }}>
                    <Who c={c} />
                    {tab === 'linked' && c.clientId ? (
                      <span style={{ fontSize: 'var(--text-sm)' }}>
                        <Icon name="link" size={14} /> <Link to={`/crm/clients/${c.clientId}`}>{c.clientName}</Link>
                        {c.accountName && c.accountName !== c.clientName ? <span style={muted}> · {c.accountName}</span> : null}
                        {c.link ? <span style={muted} data-testid="link-how"> · {linkHowText(c.link, me)}</span> : null}
                      </span>
                    ) : null}
                  </div>
                  {tab === 'waiting' ? (
                    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      <Button variant="primary" onClick={() => setSheet({ kind: 'link', customer: c })} disabled={offline}>Link to a client…</Button>
                      <Button onClick={() => setSheet({ kind: 'create', customer: c })} disabled={offline}>Create a client</Button>
                    </div>
                  ) : (
                    <Button variant="ghost" onClick={() => setSheet({ kind: 'unlink', customer: c })} disabled={offline}>Undo link…</Button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
        {data && data.total > list.length ? <p style={{ ...muted, margin: 0 }}>Showing {list.length} of {data.total}: search to find the others.</p> : null}
        </>) : null}
        <p style={{ ...muted, margin: 0 }}>
          The connection itself (its address, the shared secret, the off switch): <Link to="/system/connections">System → Connections</Link>.
          {' '}Linking automatically: <Link to="/system/automations">System → Automations</Link>.
        </p>
      </div>

      {sheet?.kind === 'link' ? (
        <LinkSheet
          customer={sheet.customer}
          initial={sheet.initial ?? null}
          onClose={() => setSheet(null)}
          onDone={(client) => {
            setSheet(null);
            setDone(`Linked to ${client?.name ?? 'the client'}: its orders are on their timeline.`);
            reload();
            matchCounts.reload();
            setMatchesKey((k) => k + 1);
          }}
        />
      ) : null}
      {sheet?.kind === 'create' ? (
        <ConfirmSheet
          title={`Create a client from ${sheet.customer.businessName ?? 'this customer'}`}
          action="Create the client"
          busy={busy}
          error={problem}
          onClose={() => setSheet(null)}
          onConfirm={() => act(`/api/wholesale/customers/${sheet.customer.uid}/create-client`, `${sheet.customer.businessName ?? 'The client'} was made and linked.`)}
        >
          <p style={{ margin: 0 }}>
            Makes a client and an account named “{sheet.customer.businessName}”, with its address
            {sheet.customer.contactName || sheet.customer.email || sheet.customer.phone ? ', a contact' : ''}, an active wholesale
            relationship and the link — then its orders go on the new client’s timeline.
          </p>
          <p style={{ ...muted, margin: 0 }}>Check the client list first if they might be there already under another name.</p>
        </ConfirmSheet>
      ) : null}
      {sheet?.kind === 'unlink' ? (
        <UndoLinkSheet
          uid={sheet.customer.uid}
          customerName={sheet.customer.businessName}
          clientName={sheet.customer.clientName}
          how={linkHowText(sheet.customer.link, me)}
          onClose={() => setSheet(null)}
          onDone={(undone) => {
            setSheet(null);
            setDone([`${sheet.customer.businessName ?? 'The customer'} is waiting for a client again.`, ...undone.restore, ...undone.keep].join('\n'));
            reload();
            matchCounts.reload();
          }}
        />
      ) : null}
    </>
  );
}
