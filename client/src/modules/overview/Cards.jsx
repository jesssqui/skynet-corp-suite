// The overview's business cards and the goals scorecard on screen (D15), below the sales strip and "To deal with".
// Words come from cards.js (no React); each card shows its figures or says plainly that its source isn't connected.
// Mac first (a grid of cards, two or three across); one column on a phone, no sideways scrolling at 320 px.
import { Link } from 'react-router-dom';
import { Card } from '../../ui/index.js';
import { formatDate, formatDateTime } from '../../ui/format.js';
import { businessColor } from '../crm/logic.js';
import { cardView, allBusinessesView, targetLine, prioritiesText, priorityProgress, longMonth } from './cards.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const fmt = { date: (d) => formatDate(d), dateTime: (d) => formatDateTime(d) };
const toneColor = (tone) => (tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : tone === 'good' ? 'var(--ok)' : undefined);

function CardHead({ title, link, linkText, id }) {
  return (
    <div className="overview-card-head">
      <h2 id={`card-${id}`}>{title}</h2>
      {link ? <Link to={link} style={{ fontSize: 'var(--text-sm)' }}>{linkText} ›</Link> : null}
    </div>
  );
}

function Note({ note }) {
  if (!note) return null;
  return (
    <span style={{ ...muted, color: toneColor(note.tone) ?? muted.color }} data-testid="card-state">
      {note.text}
      {note.link ? <> <Link to={note.link}>{note.linkText} ›</Link></> : null}
    </span>
  );
}

function Rows({ rows }) {
  if (!rows.length) return null;
  return (
    <dl className="overview-rows">
      {rows.map((r) => (
        <div key={r.key} data-row={r.key}>
          <dt>{r.link ? <Link to={r.link}>{r.label}</Link> : r.label}</dt>
          <dd>
            <span className="overview-figure" style={{ color: toneColor(r.tone) }}>{r.value}</span>
            {r.detail ? <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>{r.detail}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function MoneyRow({ r, months, strong = false }) {
  return (
    <div className="overview-money-row" data-business={r.businessId ?? 'together'} style={strong ? { fontWeight: 650 } : undefined}>
      <span className="overview-money-name">
        {r.businessId ? <span aria-hidden="true" className="overview-dot" style={{ background: businessColor({ id: r.businessId, color: r.color }) }} /> : null}
        {r.name}
      </span>
      {r.cells.map((c, i) => (
        <span key={c.month} className="overview-money-cell" data-month={c.month}>
          <span className="overview-money-label">{months[i].label}</span>
          <span className="overview-figure">{c.sales}{c.handEntered ? '*' : ''}</span>
          <span style={{ ...muted, fontSize: 'var(--text-xs)', color: c.negative ? 'var(--danger)' : muted.color }}>{months[i].lessLabel}: {c.less}</span>
        </span>
      ))}
      <span className="overview-money-cell" data-month="costs">
        <span className="overview-money-label">Costs a month (today)</span>
        <span className="overview-figure">{r.costs}</span>
      </span>
    </div>
  );
}

function AllBusinesses({ card, today }) {
  const v = allBusinessesView(card, today);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="all-businesses">
      {v.rows.length ? v.rows.map((r) => <MoneyRow key={r.businessId} r={r} months={v.months} />) : <span style={muted}>No sales or recurring costs yet.</span>}
      <MoneyRow r={v.together} months={v.months} strong />
      {v.personal.map((r) => <MoneyRow key={r.businessId} r={{ ...r, name: `${r.name} (the home, not in the total)` }} months={v.months} />)}
      <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>
        Total sales per calendar month (each store’s own days), less the recurring costs as they are today (yearly ÷ 12;
        one-off costs left out; no history is kept) — for this month only the share of its days completed. Each currency
        on its own. * includes sales entered by hand.
      </span>
    </div>
  );
}

export function BusinessCard({ card, today }) {
  const v = cardView(card, fmt);
  return (
    <Card>
      <section className="overview-card" data-testid="overview-card" data-card={card.id} data-state={card.state} aria-labelledby={`card-${card.id}`}>
        <CardHead id={card.id} title={v.title} link={v.link} linkText={v.linkText} />
        <Note note={v.note} />
        {card.id === 'allBusinesses' && card.state === 'ok' ? <AllBusinesses card={card} today={today} /> : <Rows rows={v.rows} />}
        {card.id === 'retail' && card.state !== 'error' ? <span style={muted} data-testid="retail-support">{v.support}</span> : null}
        {v.extra ? <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>{v.extra}</span> : null}
      </section>
    </Card>
  );
}

export function BusinessCards({ cards, today }) {
  if (!cards?.length) return null;
  const wide = new Set(['allBusinesses']);
  return (
    <div className="overview-cards" data-testid="overview-cards">
      {cards.map((c) => (
        <div key={c.id} className={wide.has(c.id) ? 'overview-card-wide' : undefined}>
          <BusinessCard card={c} today={today} />
        </div>
      ))}
    </div>
  );
}

/** One target's bar: how far, with a tick where a straight line would be today. */
export function TargetBar({ line }) {
  return (
    <div className="overview-target-bar" role="meter" aria-label={line.label} aria-valuetext={`${line.value}: ${line.statusText}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={line.pct}>
      <span className={`overview-target-fill${line.tone ? ` ${line.tone}` : ''}`} style={{ width: `${line.pct}%` }} />
      {line.expectedPct !== null ? <span className="overview-target-expected" style={{ left: `min(${line.expectedPct}%, calc(100% - 2px))` }} aria-hidden="true" title="Where a straight line would be after the days completed" /> : null}
    </div>
  );
}

export function TargetRow({ line }) {
  return (
    <li className="overview-target" data-target={line.key} data-status={line.status}>
      <div className="overview-target-head">
        <span style={{ fontWeight: 600 }}>{line.label}</span>
        <span className="overview-figure">{line.value}</span>
      </div>
      <TargetBar line={line} />
      <div className="overview-target-head">
        <span style={{ ...muted, color: toneColor(line.tone === 'good' ? null : line.tone) ?? muted.color }} data-testid="target-status">{line.statusText}</span>
        {line.detail ? <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>{line.detail}</span> : null}
      </div>
      {line.extras ? <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>Set on two devices: the one changed last counts — remove the extra on the monthly plan.</span> : null}
    </li>
  );
}

export function GoalsScorecard({ goals, today }) {
  const month = goals?.month ?? String(today).slice(0, 7);
  const planLink = `/plan/month?month=${month}`;
  return (
    <Card>
      <section className="overview-card" data-testid="goals-scorecard" aria-labelledby="card-goals">
        <CardHead id="goals" title={`Goals for ${longMonth(month)}`} link={planLink} linkText="Monthly plan" />
        {goals?.state === 'error' ? <span style={muted}>Couldn’t be read just now — try again in a moment.</span> : null}
        {goals?.state === 'ok' && !goals.businesses.length ? (
          <span style={muted} data-testid="goals-empty">
            No targets or priorities for this month yet. Set each business’s targets — sales, orders, new clients, leads won —
            and its priorities on the <Link to={planLink}>monthly plan ›</Link>
          </span>
        ) : null}
        <div className="overview-goals">
          {(goals?.businesses ?? []).map((b) => (
            <div key={b.businessId} className="overview-goal-business" data-business={b.businessId}>
              <h3 className="overview-tile-name">
                <span aria-hidden="true" className="overview-dot" style={{ background: businessColor({ id: b.businessId, color: b.color }) }} />
                {b.name}
              </h3>
              {b.targets.length ? (
                <ul className="overview-targets">
                  {b.targets.map((t) => <TargetRow key={t.id} line={targetLine(t, { month, today })} />)}
                </ul>
              ) : <span style={muted}>No targets set.</span>}
              <div style={{ display: 'grid', gap: 2 }} data-testid="goal-priorities">
                <span style={{ ...muted, fontWeight: 600 }}>{prioritiesText(b.priorities)}</span>
                {b.priorities.map((p) => (
                  <span key={p.id} style={{ fontSize: 'var(--text-sm)', overflowWrap: 'anywhere', textDecoration: p.done_at ? 'line-through' : undefined }}>
                    {p.done_at ? '✓ ' : '• '}{p.title}{priorityProgress(p) ? <span style={muted}> · {priorityProgress(p)}</span> : null}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        {goals?.businesses?.length ? (
          <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>
            Measured by the suite for the calendar month; the tick on each bar is where a straight line from the 1st would be
            after the days completed. Priorities are ticked by hand on the monthly plan.
          </span>
        ) : null}
      </section>
    </Card>
  );
}
