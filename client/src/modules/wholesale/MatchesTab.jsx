// The review list (D2): Order Manager customers waiting for a client beside the client each may be
// (Link… / Not the same), and possible duplicate clients inside the CRM (open both / Not the same —
// nothing is merged). "Show dismissed" lists the "Not the same" decisions with "Suggest again".
// Server data (matching runs on the server), so it needs a connection, like the rest of the page.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatPhone } from '@suite/shared/normalize';
import { Badge, Button, Card, EmptyState, Icon, Notice } from '../../ui/index.js';
import { formatDate, formatDateTime } from '../../ui/format.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { useClientListData } from '../crm/data.js';
import { BusinessChip } from '../crm/parts.jsx';
import { formatMoney } from '../crm/logic.js';
import { customerAddressText, suggestionReason } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const sideBySide = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 'var(--space-3)' };
const side = { display: 'grid', gap: 2, alignContent: 'start', minWidth: 0, padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-sm, 8px)', background: 'var(--surface-2)' };
const label = { ...muted, fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 };
const row = { borderTop: '1px solid var(--border)', padding: 'var(--space-3) var(--space-4)', display: 'grid', gap: 'var(--space-2)' };

function Lines({ items }) {
  const shown = items.filter(Boolean);
  return shown.map((t) => <span key={t} style={{ ...muted, overflowWrap: 'anywhere' }}>{t}</span>);
}

/** The Order Manager customer's side. */
function CustomerSide({ c }) {
  const facts = [`${c.orders} order${c.orders === 1 ? '' : 's'}`, `spend ${formatMoney(c.spendCents) || '$0'}`];
  if (c.lastOrderDate) facts.push(`last order ${formatDate(c.lastOrderDate)}`);
  return (
    <div style={side} data-testid="match-customer">
      <span style={label}>Order Manager customer</span>
      <strong style={{ overflowWrap: 'anywhere' }}>{c.businessName || c.contactName || 'No business name'}{c.number ? <span style={muted}> #{c.number}</span> : null}</strong>
      <Lines items={[c.contactName, c.email, c.phone ? formatPhone(c.phone) : null, customerAddressText(c.address)]} />
      {c.contactProblems?.length ? (
        <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>
          {c.contactProblems.map((p) => `${p.field === 'email' ? 'Email' : 'Phone'} “${p.as_typed}” couldn’t be cleaned there`).join(' · ')}
        </span>
      ) : null}
      <span style={{ ...muted, fontVariantNumeric: 'tabular-nums' }}>{facts.join(' · ')}</span>
    </div>
  );
}

/** A suite client's side: its accounts (the suggested one marked), contacts and our businesses. */
function ClientSide({ c, accountId, businessesById, title = 'Client in the suite' }) {
  return (
    <div style={side} data-testid="match-client" data-client-id={c.id}>
      <span style={label}>{title}</span>
      <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Link to={`/crm/clients/${c.id}`} style={{ fontWeight: 650, overflowWrap: 'anywhere' }}>{c.name}</Link>
        {c.status === 'closed' ? <Badge tone="warn">Closed</Badge> : null}
        {c.businessIds.map((id) => <BusinessChip key={id} business={businessesById.get(id) ?? { id, name: 'Business' }} short />)}
      </span>
      {c.accounts.map((a) => (
        <span key={a.id} style={{ ...muted, overflowWrap: 'anywhere', fontWeight: a.id === accountId ? 650 : undefined }}>
          {a.id === accountId ? '→ ' : ''}{a.name}{[a.street, a.city, a.postalCode].some(Boolean) ? ` · ${[a.street, a.city, a.postalCode].filter(Boolean).join(', ')}` : ''}
        </span>
      ))}
      {c.accountCount > c.accounts.length ? <span style={muted}>and {c.accountCount - c.accounts.length} more accounts</span> : null}
      {c.contacts.map((p) => (
        <span key={p.id} style={{ ...muted, overflowWrap: 'anywhere' }}>
          {[p.name, p.role, p.email, p.phone ? formatPhone(p.phone) : null].filter(Boolean).join(' · ')}
        </span>
      ))}
      {c.contactCount > c.contacts.length ? <span style={muted}>and {c.contactCount - c.contacts.length} more contacts</span> : null}
    </div>
  );
}

function Reasons({ reasons, strong, why }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }} data-testid="match-reasons">
      {reasons.map((r) => <Badge key={r.kind} tone={strong && (r.kind === 'email' || r.kind === 'phone') ? 'accent' : 'neutral'}>{r.text}</Badge>)}
      {why ? <span style={muted}>{why}</span> : null}
    </div>
  );
}

/**
 * The Suggestions tab. `onLink(suggestion)` opens the page's link sheet (client and account picked,
 * the reason carried); `onChanged()` after a decision (the page re-reads its counts).
 */
export default function MatchesTab({ offline, onLink, onChanged }) {
  const { data: lists } = useClientListData();
  const businessesById = useMemo(() => new Map((lists?.businesses ?? []).map((b) => [b.id, b])), [lists]);
  const sugg = useServerData('/api/wholesale/matches/suggestions?limit=100');
  const dups = useServerData('/api/wholesale/matches/duplicates?limit=100');
  const [showDismissed, setShowDismissed] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState(0);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);

  async function decide(path, body, key) {
    setBusy(key);
    setProblem(null);
    try {
      await api.post(path, body);
      await Promise.all([sugg.reload(), dups.reload()]);
      setDismissedVersion((v) => v + 1);
      onChanged?.();
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server: nothing was changed.' : err.message);
    } finally {
      setBusy(null);
    }
  }

  const suggestions = sugg.data?.suggestions ?? [];
  const duplicates = dups.data?.duplicates ?? [];
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      <p style={{ ...muted, margin: 0 }}>
        Same email or phone as exactly one client links automatically; everything less certain waits here. “Not the same” is
        remembered, so the pair isn’t suggested again. Only clients of Wholesale, Great White North Design and Business consulting
        (or with no business yet) are compared.
      </p>
      <Card padded={false}>
        <div style={{ padding: 'var(--space-3) var(--space-4)', fontWeight: 650 }}>
          Order Manager customers who may already be clients{sugg.data ? ` (${sugg.data.total})` : ''}
        </div>
        {!sugg.data && sugg.loading ? <EmptyState title="Loading…" /> : null}
        {sugg.data && !suggestions.length ? <EmptyState title="No suggestions">Waiting customers that look like a client show up here.</EmptyState> : null}
        {suggestions.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="suggestions-list">
            {suggestions.map((s) => {
              const key = `${s.customer.uid}|${s.client.id}`;
              return (
                <li key={key} style={row} data-suggestion={key}>
                  <div style={sideBySide}>
                    <CustomerSide c={s.customer} />
                    <ClientSide c={s.client} accountId={s.accountId} businessesById={businessesById} />
                  </div>
                  <Reasons reasons={s.reasons} strong={s.strong} why={s.why} />
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <Button variant="primary" disabled={offline || busy === key} onClick={() => onLink({ customer: s.customer, clientId: s.client.id, accountId: s.accountId, reason: suggestionReason(s) })}>
                      Link…
                    </Button>
                    <Button disabled={offline || busy === key} onClick={() => decide('/api/wholesale/matches/not-same', { kind: 'customer', a: s.customer.uid, b: s.client.id }, key)}>
                      Not the same
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {sugg.data && sugg.data.total > suggestions.length ? <p style={{ ...muted, margin: 'var(--space-3) var(--space-4)' }}>Showing {suggestions.length} of {sugg.data.total}: deal with these first.</p> : null}
      </Card>

      <Card padded={false}>
        <div style={{ padding: 'var(--space-3) var(--space-4)', fontWeight: 650 }}>
          Possible duplicate clients{dups.data ? ` (${dups.data.total})` : ''}
        </div>
        <p style={{ ...muted, margin: '0 var(--space-4) var(--space-3)' }}>
          Two clients with the same email or phone, or similar names at the same address. Nothing is merged: open both to tidy them up,
          or say they aren’t the same.
        </p>
        {dups.data && !duplicates.length ? <EmptyState title="No possible duplicates" /> : null}
        {duplicates.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="duplicates-list">
            {duplicates.map((d) => {
              const key = `${d.a.id}|${d.b.id}`;
              return (
                <li key={key} style={row} data-duplicate={key}>
                  <div style={sideBySide}>
                    <ClientSide c={d.a} businessesById={businessesById} title="Client" />
                    <ClientSide c={d.b} businessesById={businessesById} title="Client" />
                  </div>
                  <Reasons reasons={d.reasons} />
                  <div>
                    <Button disabled={offline || busy === key} onClick={() => decide('/api/wholesale/matches/not-same', { kind: 'clients', a: d.a.id, b: d.b.id }, key)}>
                      Not the same
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </Card>

      <div>
        <button type="button" className="crm-link-button" onClick={() => setShowDismissed((v) => !v)} aria-expanded={showDismissed}>
          <Icon name={showDismissed ? 'up' : 'down'} size={14} /> {showDismissed ? 'Hide dismissed' : 'Show dismissed'}
        </button>
      </div>
      {showDismissed ? <Dismissed key={dismissedVersion} offline={offline} busy={busy} decide={decide} /> : null}
    </div>
  );
}

/** "Not the same" decisions, newest first, each with "Suggest again". */
function Dismissed({ offline, busy, decide }) {
  const dismissed = useServerData('/api/wholesale/matches/dismissed', { everyMs: 0 });
  return (
    <Card padded={false}>
      {dismissed.data && !dismissed.data.dismissed.length ? <EmptyState title="Nothing dismissed" /> : null}
      {dismissed.data?.dismissed.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="dismissed-list">
          {dismissed.data.dismissed.map((d) => {
            const key = `${d.kind}|${d.a}|${d.b}`;
            return (
              <li key={key} style={{ ...row, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <strong>{d.first}</strong> and <strong>{d.second}</strong>
                  <span style={muted}> · not the same, {formatDateTime(d.at)}{d.kind === 'customer' ? ' (Order Manager customer)' : ''}</span>
                </span>
                <Button variant="ghost" disabled={offline || busy === key} onClick={() => decide('/api/wholesale/matches/suggest-again', { kind: d.kind, a: d.a, b: d.b }, key)}>
                  Suggest again
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Card>
  );
}
