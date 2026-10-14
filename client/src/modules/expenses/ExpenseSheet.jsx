// The add / edit sheet for one expense (C9): the amount and the day, who paid, the category and notes,
// and the businesses it is for (ticked; split evenly to the cent). Saving sends only what changed,
// and a retry after a partial failure never makes the expense twice or repeats a tag.
import { useMemo, useRef, useState } from 'react';
import { store } from '../../sync/index.js';
import { TextField, TextAreaField, CheckboxField, Notice } from '../../ui/index.js';
import { FormSheet, RecordSync, useAction } from '../crm/parts.jsx';
import { businessShortName, formatMoney, parseDollars } from '../crm/logic.js';
import { EXPENSE_DESCRIPTION_MAX, EXPENSE_CATEGORY_MAX, EXPENSE_NOTES_MAX, splitCents, shareLabel } from '@suite/shared/expenses';
import { expenseFormValues, expenseFieldsFrom, tagChanges } from './logic.js';

const muted = { fontSize: 'var(--text-xs)', color: 'var(--text-muted)' };

/**
 * record: the expense being edited (null = new). shares: its business tags, [{ id, business_id }].
 * defaultBusinesses: the businesses a new expense starts tagged with (the page's business filter).
 */
export default function ExpenseSheet({ record = null, shares = [], businesses, defaultBusinesses = [], me, onClose, onDone }) {
  const [values, setValues] = useState(() => expenseFormValues(record, record ? shares.map((s) => s.business_id) : defaultBusinesses));
  const [starting] = useState(() => JSON.stringify(values));
  const dirty = JSON.stringify(values) !== starting;
  const { busy, error, setError, run } = useAction();
  // What is on the server so far, kept across a failed save: a retry adds what is missing only.
  const saved = useRef({
    id: record?.id ?? null,
    baseline: record,
    tags: new Set(shares.map((s) => s.business_id)),
    gone: new Set(),
  });

  const nameOf = (id) => businessShortName(businesses.find((b) => b.id === id));
  // Archived businesses are left out unless this expense is already tagged with them.
  const choices = businesses.filter((b) => !b.archived || values.businesses.includes(b.id));
  const picked = choices.filter((b) => values.businesses.includes(b.id)).map((b) => b.id);
  const cents = parseDollars(values.amount);
  const parts = splitCents(Number.isSafeInteger(cents) ? cents : 0, picked);

  const setField = (key) => (e) => setValues((cur) => ({ ...cur, [key]: e.target.value }));
  const toggle = (id, on) => setValues((cur) => ({
    ...cur,
    businesses: on ? [...new Set([...cur.businesses, id])] : cur.businesses.filter((x) => x !== id),
  }));

  const save = async () => {
    const { error: problem, fields, changed } = expenseFieldsFrom(values, saved.current.baseline);
    if (problem) return setError(problem);
    const ok = await run(async () => {
      const s = saved.current;
      if (!s.id) {
        s.id = await store.create('expense', fields);
        s.baseline = { ...fields, id: s.id };
      } else if (Object.keys(changed).length) {
        await store.update('expense', s.id, changed);
        s.baseline = { ...s.baseline, ...changed };
      }
      for (const id of values.businesses) {
        if (s.tags.has(id)) continue;
        await store.create('expense_share', { expense_id: s.id, business_id: id });
        s.tags.add(id);
      }
      for (const share of shares) {
        if (values.businesses.includes(share.business_id) || s.gone.has(share.id)) continue;
        await store.remove('expense_share', share.id);
        s.gone.add(share.id);
        s.tags.delete(share.business_id);
      }
    });
    if (ok) onDone();
  };

  const remove = async () => {
    if (await run(() => store.remove('expense', record.id))) onDone();
  };

  return (
    <FormSheet
      title={record ? 'Edit expense' : 'New expense'}
      testId="expense-form"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
      onDelete={record ? remove : undefined}
      deleteWarning="Delete this expense? Only for a mistake. It is taken off every business it was for."
    >
      {record ? <RecordSync record={record} what="expense" /> : null}
      <TextField
        id="exp-description"
        label="What was it for"
        value={values.description}
        onChange={setField('description')}
        maxLength={EXPENSE_DESCRIPTION_MAX}
        autoFocus={!record}
      />
      <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <TextField id="exp-amount" label="Amount" inputMode="decimal" value={values.amount} onChange={setField('amount')} hint="Dollars and cents, like 49.99" />
        <TextField id="exp-date" label="Date spent" type="date" value={values.spent_on} onChange={setField('spent_on')} />
      </div>
      <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <TextField id="exp-category" label="Category (optional)" value={values.category} onChange={setField('category')} maxLength={EXPENSE_CATEGORY_MAX} hint="Like Software or Shipping" />
      </div>
      <fieldset data-testid="expense-businesses" style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--space-2)' }}>
        <legend style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 4 }}>Which businesses is it for?</legend>
        {choices.map((b) => (
          <CheckboxField
            key={b.id}
            id={`exp-biz-${b.id}`}
            label={b.name}
            checked={values.businesses.includes(b.id)}
            onChange={(on) => toggle(b.id, on)}
          />
        ))}
        {picked.length > 1 ? (
          <Notice tone="info">
            Split evenly, {shareLabel(picked.length)} each: {parts.map((p) => `${nameOf(p.businessId)} ${formatMoney(p.cents)}`).join(' · ')}
          </Notice>
        ) : null}
        {picked.length === 0 ? <span style={muted}>Not for any business yet: it counts as company-wide.</span> : null}
      </fieldset>
      <TextAreaField id="exp-notes" label="Notes (optional)" value={values.notes} onChange={setField('notes')} rows={3} maxLength={EXPENSE_NOTES_MAX} />
    </FormSheet>
  );
}
