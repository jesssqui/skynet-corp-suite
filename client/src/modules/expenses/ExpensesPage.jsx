// Expenses (/expenses): one month's expenses (newest first), the totals of the month or of one of our
// businesses (each expense counted once; a tagged expense is split evenly to the cent, so the businesses
// add up to the total), and the add / edit sheet. The month and business are kept in the URL.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader, Card, Button, EmptyState, TextField, SelectField } from '../../ui/index.js';
import { formatDate, localDate } from '../../ui/format.js';
import { BusinessChip } from '../crm/parts.jsx';
import { formatMoney } from '../crm/logic.js';
import { shareLabel } from '@suite/shared/expenses';
import { useExpenseData } from './data.js';
import { monthOf, monthLabel, summarize } from './logic.js';
import ExpenseSheet from './ExpenseSheet.jsx';

const PAGE = 50;
const muted = { fontSize: 'var(--text-xs)', color: 'var(--text-muted)' };

export default function ExpensesPage() {
  const { data, loading } = useExpenseData();
  const [params, setParams] = useSearchParams();
  const thisMonth = monthOf(localDate());
  const month = params.get('month') || thisMonth;
  const business = params.get('business') ?? '';
  const [shown, setShown] = useState(PAGE);
  const [sheet, setSheet] = useState(null);
  useEffect(() => setShown(PAGE), [month, business]);

  const setParam = (key, value, fallback = '') => {
    // From the address bar, so two quick changes don't undo each other.
    const next = new URLSearchParams(window.location.search);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const businessById = useMemo(() => new Map((data?.businesses ?? []).map((b) => [b.id, b])), [data]);
  const sharesByExpense = useMemo(() => {
    const map = new Map();
    for (const s of data?.shares ?? []) {
      if (!map.has(s.expense_id)) map.set(s.expense_id, []);
      map.get(s.expense_id).push(s);
    }
    return map;
  }, [data]);
  const summary = useMemo(
    () => (data ? summarize(data.expenses, data.shares, { month, business: business || null }) : null),
    [data, month, business],
  );
  const businessOptions = (data?.businesses ?? []).filter((b) => !b.archived || b.id === business);
  const businessName = business ? businessById.get(business)?.name ?? 'a deleted business' : '';
  const close = () => setSheet(null);

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle={monthLabel(month)}
        actions={(
          <Button variant="primary" disabled={!data} onClick={() => setSheet({ record: null })}>New expense</Button>
        )}
      />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div className="planner-filters">
          <TextField id="exp-month" label="Month" type="month" value={month} onChange={(e) => setParam('month', e.target.value, thisMonth)} />
          <SelectField
            id="exp-business"
            label="Our business"
            value={business}
            onChange={(v) => setParam('business', v)}
            options={[{ value: '', label: 'All our businesses' }, ...businessOptions.map((b) => ({ value: b.id, label: b.name }))]}
          />
        </div>

        <Card title={business ? `${businessName}’s share` : 'Company total this month'}>
          {!summary ? (
            <p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p>
          ) : (
            <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="expense-totals">
              <div>
                <div style={{ fontSize: 'var(--text-xl)', fontWeight: 700 }} data-testid="expense-total">{formatMoney(summary.total)}</div>
                <div style={muted}>{summary.count} {summary.count === 1 ? 'expense' : 'expenses'}{business ? ' tagged to this business' : ''}</div>
              </div>
              {!business ? (
                <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="expense-by-business">
                  {(data.businesses).filter((b) => summary.byBusiness.get(b.id) > 0).map((b) => (
                    <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', alignItems: 'center' }}>
                      <BusinessChip business={b} />
                      <span style={{ fontWeight: 600 }}>{formatMoney(summary.byBusiness.get(b.id))}</span>
                    </div>
                  ))}
                  {summary.unassigned > 0 ? (
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', ...muted }}>
                      <span>Company-wide (no business)</span>
                      <span style={{ fontWeight: 600, color: 'var(--text)' }}>{formatMoney(summary.unassigned)}</span>
                    </div>
                  ) : null}
                  <span style={muted}>Expenses shared between businesses are split evenly, to the cent.</span>
                </div>
              ) : null}
            </div>
          )}
        </Card>

        <Card>
          {!summary ? null : summary.rows.length ? (
            <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="expense-list">
              {summary.rows.slice(0, shown).map((e) => {
                const parts = summary.splits.get(e.id) ?? [];
                const mine = business ? parts.find((p) => p.businessId === business) : null;
                return (
                  <button
                    key={e.id}
                    type="button"
                    data-testid="expense-row"
                    onClick={() => setSheet({ record: e })}
                    style={{
                      display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', alignItems: 'flex-start', textAlign: 'left',
                      padding: 'var(--space-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 8px)',
                      background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', font: 'inherit',
                    }}
                  >
                    <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                      <strong style={{ overflowWrap: 'anywhere' }}>{e.description}</strong>
                      <span style={muted}>
                        {formatDate(e.spent_on)}
                        {e.category ? ` · ${e.category}` : ''}
                      </span>
                    </span>
                    <span style={{ display: 'grid', gap: 4, justifyItems: 'end', flexShrink: 0 }}>
                      <strong>{formatMoney(mine ? mine.cents : e.amount_cents)}</strong>
                      {mine ? <span style={muted}>of {formatMoney(e.amount_cents)}</span> : null}
                      <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {parts.length === 0 ? <span style={muted}>Company-wide</span> : null}
                        {parts.map((p) => (
                          <BusinessChip key={p.businessId} business={businessById.get(p.businessId)} short />
                        ))}
                      </span>
                      {parts.length > 1 ? <span style={muted}>Split {shareLabel(parts.length)} each</span> : null}
                    </span>
                  </button>
                );
              })}
              {summary.rows.length > shown ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                  <Button onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, summary.rows.length - shown)} more</Button>
                  <span style={muted}>{shown} of {summary.rows.length}</span>
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState title={business ? 'Nothing for this business this month' : 'No expenses this month'}>
              Add one with New expense. Tag it to the businesses it is for.
            </EmptyState>
          )}
        </Card>
      </div>

      {sheet && data ? (
        <ExpenseSheet
          record={sheet.record}
          shares={sheet.record ? sharesByExpense.get(sheet.record.id) ?? [] : []}
          businesses={data.businesses}
          defaultBusinesses={business ? [business] : []}
          onClose={close}
          onDone={close}
        />
      ) : null}
    </>
  );
}
