import { useMemo, useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatPhone, parseTags } from '@suite/shared/normalize';
import { ACTIVITY_TYPES } from '@suite/shared/crm';
import { Card, Button, Badge, EmptyState, SelectField, Icon } from '../../ui/index.js';
import { formatDate, formatDateTime } from '../../ui/format.js';
import { useAuth } from '../../auth/session.jsx';
import { store } from '../../sync/index.js';
import { useClientPageData } from './data.js';
import {
  KIND_LABELS, ACTIVITY_LABELS, CHANNEL_LABELS, PERIOD_LABELS, actorLabel, billingSummary, consentView,
  filterTimeline, pickableBusinesses, websiteHref, addressLines, errorText,
} from './logic.js';
import { BusinessChip, Badges, RecordSync, StatusBadge, TextButton } from './parts.jsx';
import { ClientForm, AccountForm, ContactForm, RelationshipForm, ServiceForm, ConsentForm, ActivityForm } from './forms.jsx';
import { relationshipsWithoutNextStep } from '@suite/shared/planner';
import { ClientTasksCard, NoNextStepLine } from '../planner/ClientTasksCard.jsx';
import { useToday } from '../planner/parts.jsx';
import { wholesaleItems, activityItem, sumCards, linkHowText } from '../wholesale/logic.js';
import { WholesaleTimelineItem, AccountWholesale, ClientWholesale, QuietRegularBadge } from '../wholesale/parts.jsx';
import UndoLinkSheet from '../wholesale/UndoLinkSheet.jsx';
import { resoldLine } from '../costs/logic.js';
import { STAGE_LABELS, clientLeads, leadTimelineItems, leadValueText, nextStepOf, isOpenLead } from './leads.js';
import { LeadForm } from './leadForms.jsx';
import './crm.css';

// One client on one screen (/crm/clients/:id): who they are, their businesses (accounts) with
// what each of ours does for them (relationships → services), their people (contacts, consent
// per business), and the timeline with quick notes and call logs. Everything is read from and
// written to the device's offline copy, so it all works with no connection. Phones: one column
// and a capture bar above the tab bar; wide screens: records left, timeline right (crm.css).

const PAGE = 50;
const ICONS = { note: 'note', call: 'call', email: 'mail', meeting: 'meeting', order: 'order', milestone: 'flag' };
const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const sectionHead = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' };
const h2 = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' };
const preWrap = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 };

function Tags({ value }) {
  const tags = parseTags(value);
  return tags.length ? (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {tags.map((t) => <Badge key={t} tone="accent">{t}</Badge>)}
    </span>
  ) : null;
}

function LinkLine({ link, me, onUndo }) {
  // An Order Manager customer is named (and its figures shown) by the account's wholesale box (D1):
  // its permanent id is only in the tooltip. D2: how it was linked, and Undo (needs the server).
  const app = link.app === 'wom' ? 'an Order Manager customer' : `${link.app} record ${link.external_id}`;
  return (
    <div style={{ ...muted, display: 'flex', gap: 'var(--space-1)', alignItems: 'center', flexWrap: 'wrap' }} data-testid="link-line" title={link.external_id}>
      <Icon name="link" size={14} />
      <span>{linkHowText(link, me)} to {app}</span>
      <Badges record={link} />
      {onUndo && link.app === 'wom' && link.account_id ? (
        <TextButton onClick={() => onUndo(link)} aria-label="Undo this link">Undo…</TextButton>
      ) : null}
    </div>
  );
}

// ---- header -------------------------------------------------------------------------------------

function Header({ client, onEdit, onStatus, wholesale, wholesaleCards = [], today }) {
  const closed = client.status === 'closed';
  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <Link to="/crm" style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 2, textDecoration: 'none', minHeight: 'var(--tap)', width: 'fit-content' }}>
          <Icon name="back" size={16} /> Clients
        </Link>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 240px', minWidth: 0, display: 'grid', gap: 'var(--space-2)' }}>
            <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, letterSpacing: '-0.01em', overflowWrap: 'anywhere' }} data-testid="client-name">{client.name}</h1>
            <Badges record={client}>
              <StatusBadge status={client.status} />
              {closed ? null : <QuietRegularBadge cards={wholesaleCards} today={today} />}
              <Tags value={client.tags} />
            </Badges>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button onClick={onEdit}><Icon name="edit" size={16} />Edit</Button>
            <Button variant="ghost" onClick={() => onStatus(closed ? 'active' : 'closed')}>{closed ? 'Reopen' : 'Close client'}</Button>
          </div>
        </div>
        <ClientWholesale figures={wholesale} />
        {client.notes ? <p style={preWrap}>{client.notes}</p> : null}
        <RecordSync record={client} what="client" />
      </div>
    </Card>
  );
}

// ---- accounts ------------------------------------------------------------------------------------

function ServiceItem({ service, open }) {
  const money = billingSummary(service);
  const facts = [
    service.stage ? `Stage: ${service.stage}` : null,
    money || null,
    service.period && !money.includes('/') && !money.includes('one-off') ? PERIOD_LABELS[service.period] : null,
    service.renewal_date ? `Renews ${formatDate(service.renewal_date)}` : null,
  ].filter(Boolean);
  return (
    <li className="crm-service" data-service-id={service.id}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{service.name}</span>
        <Badges record={service}><StatusBadge status={service.status} /></Badges>
        <TextButton style={{ marginLeft: 'auto' }} onClick={open} aria-label={`Edit service ${service.name}`}>Edit</TextButton>
      </div>
      {facts.length ? <div style={muted}>{facts.join(' · ')}</div> : null}
      {service.scope ? <p style={{ ...preWrap, ...muted }}>{service.scope}</p> : null}
      {service.notes ? <p style={{ ...preWrap, ...muted }}>{service.notes}</p> : null}
      <RecordSync record={service} what="service" />
    </li>
  );
}

/** D6: our recurring costs resold on this relationship — "Hosting — we pay $300/yr, they pay $480/yr" (tap to edit on Costs). */
function ResoldCosts({ costs }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }} data-testid="resold-costs">
      {[...costs].sort((a, b) => String(a.name).localeCompare(String(b.name))).map((c) => (
        <li key={c.id} style={{ ...muted, display: 'flex', gap: 'var(--space-1)', alignItems: 'center', flexWrap: 'wrap' }} data-cost-id={c.id}>
          <Icon name="card" size={14} />
          <Link to={`/costs?open=${c.id}`} style={{ color: 'inherit', textDecoration: c.status === 'cancelled' ? 'line-through' : 'none' }}>{resoldLine(c)}</Link>
          {c.status === 'cancelled' ? <Badge tone="neutral">Cancelled</Badge> : null}
          <Badges record={c} />
        </li>
      ))}
    </ul>
  );
}

function RelationshipItem({ rel, business, services, resold = [], onEdit, onAddService, onEditService, noNextStep, clientId, businesses }) {
  return (
    <li className="crm-rel" data-relationship-id={rel.id}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <BusinessChip business={business} />
        <span style={{ fontWeight: 600 }}>{KIND_LABELS[rel.kind] ?? rel.kind}</span>
        <Badges record={rel}><StatusBadge status={rel.status} /></Badges>
        <TextButton style={{ marginLeft: 'auto' }} onClick={onEdit} aria-label={`Edit ${KIND_LABELS[rel.kind] ?? rel.kind} relationship`}>Edit</TextButton>
      </div>
      {rel.start_date ? <div style={muted}>Since {formatDate(rel.start_date)}</div> : null}
      {noNextStep ? <NoNextStepLine rel={rel} clientId={clientId} businesses={businesses} /> : null}
      {rel.notes ? <p style={{ ...preWrap, ...muted }}>{rel.notes}</p> : null}
      <RecordSync record={rel} what="relationship" />
      {services.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
          {services.map((s) => <ServiceItem key={s.id} service={s} open={() => onEditService(s)} />)}
        </ul>
      ) : null}
      {resold.length ? <ResoldCosts costs={resold} /> : null}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <TextButton onClick={onAddService} style={{ paddingLeft: 0, width: 'fit-content' }}><Icon name="plus" size={14} />Add service</TextButton>
        {rel.kind === 'wholesale' ? null : (
        <Link to={`/costs?new=1&relationship=${rel.id}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)', minHeight: 'var(--tap)', fontSize: 'var(--text-sm)', fontWeight: 600, textDecoration: 'none' }}>
          <Icon name="plus" size={14} />Add resold cost
        </Link>
        )}
      </div>
    </li>
  );
}

function AccountItem({ account, rels, servicesByRel, resoldByRel, links, businessesById, open, noNextStep, businesses, wholesaleCards, today, clientClosed, me }) {
  const lines = addressLines(account);
  const href = websiteHref(account.website);
  return (
    <li className="crm-account" data-account-id={account.id}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 'var(--text-md)', fontWeight: 650, overflowWrap: 'anywhere' }}>{account.name}</h3>
        <Badges record={account}>
          {account.age_restricted ? <Badge tone="warn">Age-restricted</Badge> : null}
          <Tags value={account.tags} />
        </Badges>
        <TextButton style={{ marginLeft: 'auto' }} onClick={() => open({ kind: 'account', record: account })} aria-label={`Edit account ${account.name}`}>Edit</TextButton>
      </div>
      {lines.length || account.website ? (
        <div style={{ ...muted, display: 'grid', gap: 2 }}>
          {lines.map((l) => <span key={l}>{l}</span>)}
          {account.website ? (
            href ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ overflowWrap: 'anywhere', width: 'fit-content' }}>{account.website}</a> : <span>{account.website}</span>
          ) : null}
        </div>
      ) : null}
      {account.notes ? <p style={{ ...preWrap, ...muted }}>{account.notes}</p> : null}
      {links.map((l) => <LinkLine key={l.id} link={l} me={me} onUndo={(link) => open({ kind: 'undo-link', link, account, cards: wholesaleCards })} />)}
      <AccountWholesale cards={wholesaleCards} figures={sumCards(wholesaleCards)} today={today} hideQuiet={clientClosed} />
      <RecordSync record={account} what="account" />
      {rels.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
          {rels.map((r) => (
            <RelationshipItem
              key={r.id}
              rel={r}
              business={businessesById.get(r.business_id)}
              services={servicesByRel.get(r.id) ?? []}
              resold={resoldByRel.get(r.id) ?? []}
              onEdit={() => open({ kind: 'relationship', record: r })}
              onAddService={() => open({ kind: 'service', relationshipId: r.id })}
              onEditService={(s) => open({ kind: 'service', record: s, relationshipId: r.id })}
              noNextStep={noNextStep.has(r.id)}
              clientId={account.client_id}
              businesses={businesses}
            />
          ))}
        </ul>
      ) : <div style={muted}>None of our businesses works with it yet.</div>}
      <TextButton onClick={() => open({ kind: 'relationship', accountId: account.id })} style={{ paddingLeft: 0, width: 'fit-content' }}>
        <Icon name="plus" size={14} />Add relationship
      </TextButton>
    </li>
  );
}

// ---- contacts ------------------------------------------------------------------------------------

function ConsentRows({ contact, consents, businessIds, businessesById, today, onRecord }) {
  return (
    <div style={{ display: 'grid', gap: 2 }} data-testid="consent">
      <span style={{ ...muted, fontWeight: 600 }}>Email consent</span>
      {businessIds.length ? businessIds.map((id) => {
        const c = consentView(consents, id, today);
        const detail = [
          c.kind,
          c.state === 'given' && c.until ? `lapses ${formatDate(c.until)}` : null,
          c.state === 'given' && !c.until ? `since ${formatDate(c.date)}` : null,
          c.state === 'expired' ? `lapsed ${formatDate(c.until)}` : null,
          c.state === 'withdrawn' ? formatDate(c.date) : null,
        ].filter(Boolean).join(' · ');
        return (
          <div key={id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }} data-consent-business={id} data-consent-state={c.state}>
            <BusinessChip business={businessesById.get(id)} />
            <Badge tone={c.tone}>{c.label}</Badge>
            {detail ? <span style={muted}>{detail}</span> : null}
            <TextButton style={{ marginLeft: 'auto' }} onClick={() => onRecord(id)} aria-label={`Change consent for ${businessesById.get(id)?.name ?? 'business'}`}>Change</TextButton>
          </div>
        );
      }) : <span style={muted}>None recorded.</span>}
      <TextButton onClick={() => onRecord(null)} style={{ paddingLeft: 0, width: 'fit-content' }}><Icon name="plus" size={14} />Record consent</TextButton>
    </div>
  );
}

function ContactItem({ contact, account, consents, consentBusinessIds, links, businessesById, today, open, me }) {
  const facts = [contact.role, account ? `at ${account.name}` : null].filter(Boolean).join(' ');
  return (
    <li className="crm-contact" data-contact-id={contact.id}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 'var(--text-md)', fontWeight: 650, overflowWrap: 'anywhere' }}>{contact.name}</h3>
        <Badges record={contact} />
        <TextButton style={{ marginLeft: 'auto' }} onClick={() => open({ kind: 'contact', record: contact })} aria-label={`Edit contact ${contact.name}`}>Edit</TextButton>
      </div>
      {facts ? <div style={muted}>{facts}</div> : null}
      {contact.email || contact.phone ? (
        <div style={{ display: 'flex', gap: 'var(--space-1) var(--space-4)', flexWrap: 'wrap' }}>
          {contact.email ? <a className="crm-contact-link" href={`mailto:${contact.email}`}><Icon name="mail" size={16} />{contact.email}</a> : null}
          {contact.phone ? <a className="crm-contact-link" href={`tel:${contact.phone}`}><Icon name="call" size={16} />{formatPhone(contact.phone)}</a> : null}
        </div>
      ) : null}
      {contact.preferred_channel ? <div style={muted}>Prefers: {CHANNEL_LABELS[contact.preferred_channel]}</div> : null}
      {contact.notes ? <p style={{ ...preWrap, ...muted }}>{contact.notes}</p> : null}
      {links.map((l) => <LinkLine key={l.id} link={l} me={me} />)}
      <RecordSync record={contact} what="contact" />
      <ConsentRows
        contact={contact}
        consents={consents}
        businessIds={consentBusinessIds}
        businessesById={businessesById}
        today={today}
        onRecord={(businessId) => open({ kind: 'consent', contact, businessId })}
      />
    </li>
  );
}

// ---- timeline ------------------------------------------------------------------------------------

function ActivityItem({ activity, account, business, me }) {
  const who = actorLabel(activity._sync?.createdBy ?? (activity._sync?.local ? me : null), me);
  return (
    <li className="crm-activity" data-activity-id={activity.id}>
      <span className="crm-activity-icon" aria-hidden="true"><Icon name={ICONS[activity.type] ?? 'note'} size={16} /></span>
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <div style={{ ...muted, display: 'flex', gap: '0 var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <strong style={{ color: 'var(--text)' }}>{ACTIVITY_LABELS[activity.type] ?? activity.type}</strong>
          <time dateTime={activity.at}>{formatDateTime(activity.at)}</time>
          {who ? <span>by {who === 'You' ? 'you' : who === 'Your partner' ? 'your partner' : who.toLowerCase()}</span> : null}
          <Badges record={activity} />
        </div>
        <p style={preWrap}>{activity.body}</p>
        {business || account ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            {business ? <BusinessChip business={business} /> : null}
            {account ? <span style={muted}>{account.name}</span> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

// D8: a note, call or stage change made on one of this client's leads (cross-sell, or before it was won):
// shown like an activity, with a link to the lead it was made on.
function LeadTimelineItem({ item, account, business, me }) {
  const who = actorLabel(item.record._sync?.createdBy ?? (item.record._sync?.local ? me : null), me);
  return (
    <li className="crm-activity" data-activity-id={item.id} data-from-lead={item.lead?.id}>
      <span className="crm-activity-icon" aria-hidden="true"><Icon name={ICONS[item.type] ?? 'note'} size={16} /></span>
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <div style={{ ...muted, display: 'flex', gap: '0 var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <strong style={{ color: 'var(--text)' }}>{ACTIVITY_LABELS[item.type] ?? item.type}</strong>
          <time dateTime={item.at}>{formatDateTime(item.at)}</time>
          {who ? <span>by {who === 'You' ? 'you' : who === 'Your partner' ? 'your partner' : who.toLowerCase()}</span> : null}
          {item.lead ? <Link to={`/crm/leads/${item.lead.id}`}>on the lead</Link> : null}
          <Badges record={item.record} />
        </div>
        {item.body ? <p style={preWrap}>{item.body}</p> : null}
        {business || account ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            {business ? <BusinessChip business={business} /> : null}
            {account ? <span style={muted}>{account.name}</span> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

// D8: this client's leads — cross-sell ones pointing at it and the one(s) it was won from.
function LeadsCard({ leads, tasks, businessesById, onNew, today }) {
  const tasksByLead = new Map();
  for (const t of tasks) tasksByLead.set(t.lead_id, [...(tasksByLead.get(t.lead_id) ?? []), t]);
  return (
    <Card>
      <div style={sectionHead}>
        <h2 style={h2}>Leads</h2>
        <TextButton onClick={onNew}><Icon name="plus" size={14} />New lead</TextButton>
      </div>
      {leads.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }} data-testid="client-leads">
          {leads.map((l) => {
            const next = isOpenLead(l) ? nextStepOf(tasksByLead.get(l.id)) : null;
            const value = leadValueText(l);
            return (
              <li key={l.id} style={{ display: 'grid', gap: 4 }} data-lead-id={l.id}>
                <span style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <Link to={`/crm/leads/${l.id}`} style={{ fontWeight: 600 }}>{l.name}</Link>
                  <Badge tone={l.stage === 'won' ? 'ok' : l.stage === 'lost' ? 'danger' : 'accent'}>{STAGE_LABELS[l.stage]}</Badge>
                  <BusinessChip business={businessesById.get(l.business_id)} short />
                  {l.kind ? <span style={muted}>{KIND_LABELS[l.kind]}</span> : null}
                  {value ? <span style={muted}>{value}</span> : null}
                </span>
                {isOpenLead(l) ? (
                  next
                    ? <span style={{ ...muted, color: next.due_date < today ? 'var(--danger)' : 'var(--text-muted)' }}>Next: {next.title} · {formatDate(next.due_date)}</span>
                    : <span><Badge tone="warn">No next step</Badge></span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : <p style={{ ...muted, margin: 0 }}>No leads. A new lead here is for this client (another service, another of our businesses).</p>}
    </Card>
  );
}

// The timeline's items are the client's activities and (D1) its Order Manager orders, payments,
// returns and refunds, in one list (`items`, from activityItem / wholesaleItems): the Order Manager's
// are type 'order' ("Orders") and business wholesale, so the filters work the same on both. (D5) Its
// notes are business wholesale too, under their own type (a follow-up marked done under Notes).
function Timeline({ items: activities, accounts, businesses, accountsById, businessesById, filter, setFilter, onCapture, me }) {
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [filter]);
  const rows = useMemo(() => filterTimeline(activities, filter), [activities, filter]);
  // Businesses to filter by: those not archived, plus any the timeline names.
  const used = useMemo(() => new Set(activities.map((t) => t.business_id).filter(Boolean)), [activities]);
  const businessOptions = pickableBusinesses(businesses).concat(businesses.filter((b) => b.archived && used.has(b.id)));
  const types = ACTIVITY_TYPES.filter((t) => t !== 'order' || activities.some((x) => x.type === 'order'));
  const typeLabel = (t) => (t === 'order' ? 'Orders' : ACTIVITY_LABELS[t]);
  return (
    <Card>
      <div style={sectionHead}>
        <h2 style={h2}>Timeline</h2>
        <span style={muted} data-testid="timeline-count">{rows.length === activities.length ? `${rows.length}` : `${rows.length} of ${activities.length}`}</span>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
        <Button variant="primary" onClick={() => onCapture('note')}><Icon name="note" size={18} />Add note</Button>
        <Button onClick={() => onCapture('call')}><Icon name="call" size={18} />Log call</Button>
      </div>
      <div className="crm-timeline-filters">
        <SelectField
          id="tl-business"
          label="Our business"
          value={filter.business}
          onChange={(v) => setFilter({ ...filter, business: v })}
          options={[{ value: 'all', label: 'All' }, ...businessOptions.map((b) => ({ value: b.id, label: b.name }))]}
        />
        <SelectField
          id="tl-account"
          label="Their business"
          value={filter.account}
          onChange={(v) => setFilter({ ...filter, account: v })}
          options={[{ value: 'all', label: 'All' }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
        />
        <SelectField
          id="tl-type"
          label="Type"
          value={filter.type}
          onChange={(v) => setFilter({ ...filter, type: v })}
          options={[{ value: 'all', label: 'All' }, ...types.map((t) => ({ value: t, label: typeLabel(t) }))]}
        />
      </div>
      {rows.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="timeline">
          {rows.slice(0, shown).map((t) => (t.source === 'activity' ? (
            <ActivityItem key={t.id} activity={t.record} account={accountsById.get(t.account_id)} business={businessesById.get(t.business_id)} me={me} />
          ) : t.source === 'lead_activity' ? (
            <LeadTimelineItem key={t.id} item={t} account={accountsById.get(t.account_id)} business={businessesById.get(t.business_id)} me={me} />
          ) : (
            <WholesaleTimelineItem key={t.id} item={t} account={accountsById.get(t.account_id)} business={businessesById.get(t.business_id)} />
          )))}
        </ul>
      ) : (
        <EmptyState title={activities.length ? 'Nothing matches these filters' : 'Nothing logged yet'}>
          {activities.length ? 'Notes with no business or account show under All.' : 'Add a note or log a call: it works offline too.'}
        </EmptyState>
      )}
      {rows.length > shown ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: 'var(--space-3)' }}>
          <Button onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</Button>
          <span style={muted}>{shown} of {rows.length}</span>
        </div>
      ) : null}
    </Card>
  );
}

// ---- page ------------------------------------------------------------------------------------------

function ClientScreen({ clientId }) {
  const { data, loading } = useClientPageData(clientId);
  const today = useToday(); // consent and (D3) the "Quiet regular" flag: this device's date, kept current
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const navigate = useNavigate();
  const [sheet, setSheet] = useState(null);
  const [filter, setFilter] = useState({ business: 'all', account: 'all', type: 'all' });
  const [statusError, setStatusError] = useState(null);
  const [undone, setUndone] = useState(null); // D2: what undoing an Order Manager link did

  // A filter whose account or business is gone (deleted, maybe on the other device) goes back to All:
  // the select can't show it, so it would hide everything with nothing on screen to say why.
  useEffect(() => {
    if (!data?.client) return;
    const gone = (value, list) => value !== 'all' && !list.some((x) => x.id === value);
    if (gone(filter.account, data.accounts) || gone(filter.business, data.businesses)) {
      setFilter((f) => ({
        ...f,
        account: gone(f.account, data.accounts) ? 'all' : f.account,
        business: gone(f.business, data.businesses) ? 'all' : f.business,
      }));
    }
  }, [data, filter]);

  const maps = useMemo(() => {
    if (!data?.client) return null;
    const businessesById = new Map(data.businesses.map((b) => [b.id, b]));
    const accountsById = new Map(data.accounts.map((a) => [a.id, a]));
    const relsByAccount = new Map();
    for (const r of data.relationships) relsByAccount.set(r.account_id, [...(relsByAccount.get(r.account_id) ?? []), r]);
    const servicesByRel = new Map();
    for (const s of data.services) servicesByRel.set(s.relationship_id, [...(servicesByRel.get(s.relationship_id) ?? []), s]);
    // D6: our recurring costs resold on each relationship.
    const resoldByRel = new Map();
    for (const c of data.resoldCosts ?? []) resoldByRel.set(c.relationship_id, [...(resoldByRel.get(c.relationship_id) ?? []), c]);
    const consentsByContact = new Map();
    for (const k of data.consents) consentsByContact.set(k.contact_id, [...(consentsByContact.get(k.contact_id) ?? []), k]);
    const linksBy = new Map();
    for (const l of data.links) {
      const key = l.account_id ?? l.contact_id;
      linksBy.set(key, [...(linksBy.get(key) ?? []), l]);
    }
    // Consent is shown for the businesses that work with this client, and any with a record.
    const working = new Set(data.relationships.map((r) => r.business_id));
    const order = (ids) => [...ids].filter((id) => businessesById.has(id))
      .sort((a, b) => (businessesById.get(a).position ?? 99) - (businessesById.get(b).position ?? 99));
    // Active relationships with no open, dated task naming them (the planner's "No next step").
    const noNextStep = new Set(relationshipsWithoutNextStep({
      relationships: data.relationships, accounts: data.accounts, clients: [data.client], tasks: data.relationshipTasks,
    }).map((r) => r.id));
    // D1: the Order Manager's records on the timeline beside the activities, and its figures.
    // D8: and the notes, calls and stage changes made on its leads (they stay with the lead; shown here).
    const relationshipsById = new Map(data.relationships.map((r) => [r.id, r]));
    const leadsById = new Map(data.leads.map((l) => [l.id, l]));
    const items = [...data.activities.map(activityItem), ...wholesaleItems(data.wholesaleOrders, data.wholesaleEntries, data.wholesaleNotes),
      ...leadTimelineItems(data.leadActivities, leadsById, relationshipsById)];
    const cardsByAccount = new Map();
    for (const c of data.wholesaleCustomers) cardsByAccount.set(c.account_id, [...(cardsByAccount.get(c.account_id) ?? []), c]);
    const wholesale = sumCards(data.wholesaleCustomers);
    return { businessesById, accountsById, relsByAccount, servicesByRel, resoldByRel, consentsByContact, linksBy, working, order, noNextStep, items, cardsByAccount, wholesale };
  }, [data]);

  if (!data) return <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>;
  if (!data.client) {
    return (
      <Card>
        <EmptyState title="This client isn’t on this device">
          It may have been deleted, or this device hasn’t downloaded it yet. <Link to="/crm">Back to clients</Link>
        </EmptyState>
      </Card>
    );
  }
  const { client, accounts, contacts, businesses } = data;
  const { businessesById, accountsById, relsByAccount, servicesByRel, resoldByRel, consentsByContact, linksBy, working, order, noNextStep, items, cardsByAccount, wholesale } = maps;
  const open = (s) => setSheet(s);
  const close = () => setSheet(null);
  const capture = (type) => open({
    kind: 'activity', type,
    accountId: filter.account !== 'all' ? filter.account : '',
    businessId: filter.business !== 'all' ? filter.business : '',
  });
  const setStatus = async (status) => {
    setStatusError(null);
    try {
      await store.update('client', client.id, { status });
    } catch (err) {
      setStatusError(errorText(err));
    }
  };

  return (
    <div className="crm-client">
      <Header client={client} onEdit={() => open({ kind: 'client', record: client })} onStatus={setStatus} wholesale={wholesale} wholesaleCards={data.wholesaleCustomers} today={today} />
      {statusError ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{statusError}</p> : null}
      {undone ? (
        <p role="status" style={{ ...muted, margin: 0, whiteSpace: 'pre-line' }} data-testid="link-undone">
          {['The link was undone: the Order Manager customer waits for a client again.', ...undone.restore, ...undone.keep].join('\n')}
        </p>
      ) : null}
      <div className="crm-client-grid">
        <div className="crm-col">
          <Card>
            <div style={sectionHead}>
              <h2 style={h2}>Accounts</h2>
              <TextButton onClick={() => open({ kind: 'account' })}><Icon name="plus" size={14} />Add account</TextButton>
            </div>
            {accounts.length ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="accounts">
                {accounts.map((a) => (
                  <AccountItem
                    key={a.id}
                    account={a}
                    rels={relsByAccount.get(a.id) ?? []}
                    servicesByRel={servicesByRel}
                    resoldByRel={resoldByRel}
                    links={linksBy.get(a.id) ?? []}
                    businessesById={businessesById}
                    open={open}
                    noNextStep={noNextStep}
                    businesses={businesses}
                    wholesaleCards={cardsByAccount.get(a.id) ?? []}
                    today={today}
                    clientClosed={client.status === 'closed'}
                    me={me}
                  />
                ))}
              </ul>
            ) : <p style={{ ...muted, margin: 0 }}>No accounts yet: add each business they own.</p>}
          </Card>
          <Card>
            <div style={sectionHead}>
              <h2 style={h2}>Contacts</h2>
              <TextButton onClick={() => open({ kind: 'contact' })}><Icon name="plus" size={14} />Add contact</TextButton>
            </div>
            {contacts.length ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="contacts">
                {contacts.map((p) => {
                  const rows = consentsByContact.get(p.id) ?? [];
                  return (
                    <ContactItem
                      key={p.id}
                      contact={p}
                      account={accountsById.get(p.account_id)}
                      consents={rows}
                      consentBusinessIds={order(new Set([...working, ...rows.map((k) => k.business_id)]))}
                      links={linksBy.get(p.id) ?? []}
                      businessesById={businessesById}
                      today={today}
                      open={open}
                      me={me}
                    />
                  );
                })}
              </ul>
            ) : <p style={{ ...muted, margin: 0 }}>No contacts yet.</p>}
          </Card>
        </div>
        <div className="crm-col">
          <LeadsCard
            leads={clientLeads(data.leads, client.id)}
            tasks={data.leadTasks}
            businessesById={businessesById}
            today={today}
            onNew={() => open({ kind: 'lead' })}
          />
          <ClientTasksCard
            client={client}
            tasks={data.tasks}
            businesses={businesses}
            businessesById={businessesById}
            accountsById={accountsById}
            filter={filter}
          />
          <Timeline
            items={items}
            accounts={accounts}
            businesses={businesses}
            accountsById={accountsById}
            businessesById={businessesById}
            filter={filter}
            setFilter={setFilter}
            onCapture={capture}
            me={me}
          />
        </div>
      </div>

      <div className="crm-capture-spacer" aria-hidden="true" />
      <div className="crm-capture-bar" role="toolbar" aria-label="Quick capture">
        <Button variant="primary" style={{ flex: 1 }} onClick={() => capture('note')}><Icon name="note" size={18} />Add note</Button>
        <Button style={{ flex: 1 }} onClick={() => capture('call')}><Icon name="call" size={18} />Log call</Button>
      </div>

      {sheet?.kind === 'undo-link' ? (
        <UndoLinkSheet
          uid={sheet.link.external_id}
          customerName={sheet.cards.find((c) => c.customer_uid === sheet.link.external_id)?.name ?? sheet.account.name}
          clientName={client.name}
          how={linkHowText(sheet.link, me)}
          onClose={close}
          onDone={(undone) => { close(); setStatusError(null); setUndone(undone); }}
        />
      ) : null}
      {sheet?.kind === 'lead' ? (
        <LeadForm
          initial={{ client_id: client.id, account_id: accounts.length === 1 ? accounts[0].id : '', name: accounts.length === 1 ? accounts[0].name : client.name, source: 'cross_sell' }}
          businesses={businesses}
          clientsById={new Map([[client.id, client]])}
          accountsById={accountsById}
          onClose={close}
          onDone={(id) => { close(); if (id) navigate(`/crm/leads/${id}`); }}
        />
      ) : null}
      {sheet?.kind === 'client' ? (
        <ClientForm record={sheet.record} onClose={close} onDone={close} onDeleted={() => navigate('/crm', { replace: true })} />
      ) : null}
      {sheet?.kind === 'account' ? (
        <AccountForm record={sheet.record} clientId={client.id} onClose={close} onDone={close} onDeleted={close} />
      ) : null}
      {sheet?.kind === 'contact' ? (
        <ContactForm record={sheet.record} clientId={client.id} accounts={accounts} onClose={close} onDone={close} onDeleted={close} />
      ) : null}
      {sheet?.kind === 'relationship' ? (
        <RelationshipForm
          record={sheet.record}
          accountId={sheet.accountId}
          accounts={accounts}
          businesses={businesses}
          onClose={close}
          onDone={close}
          onDeleted={close}
        />
      ) : null}
      {sheet?.kind === 'service' ? (
        <ServiceForm record={sheet.record} relationshipId={sheet.relationshipId} onClose={close} onDone={close} onDeleted={close} />
      ) : null}
      {sheet?.kind === 'consent' ? (
        <ConsentForm contact={sheet.contact} businesses={businesses} businessId={sheet.businessId} onClose={close} onDone={close} />
      ) : null}
      {sheet?.kind === 'activity' ? (
        <ActivityForm
          key={`${sheet.type}`}
          clientId={client.id}
          type={sheet.type}
          accountId={sheet.accountId}
          businessId={sheet.businessId}
          accounts={accounts}
          businesses={businesses}
          relationships={data.relationships}
          onClose={close}
          onDone={close}
        />
      ) : null}
    </div>
  );
}

export default function ClientPage() {
  const { id } = useParams();
  // A fresh screen per client: filters and open sheets don't carry over.
  return <ClientScreen key={id} clientId={id} />;
}
