// Monthly targets on the monthly plan (D15): under each business, its targets for the month — set, changed and removed
// offline (the synced `target` record) — each with what the month has brought so far when the suite server can be
// reached (GET /api/overview/targets: sales live only on the server). The priorities below stay C4b's: the targets are
// the numbers the month is judged by, the priorities the work meant to get there; the overview's scorecard shows both.
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Icon, Notice, SelectField, TextAreaField, TextField } from '../../ui/index.js';
import { store, useRecords, useRecord } from '../../sync/index.js';
import { useServerData } from '../../api/useServerData.js';
import { localDate } from '../../ui/format.js';
import { FormSheet, RecordSync, TextButton, useAction } from '../crm/parts.jsx';
import { MEASURE_HELP, MEASURE_LABELS, isMoneyMeasure } from '@suite/shared/targets';
import { targetLine, measureValue } from './cards.js';
import './overview.css';
import { TargetBar } from './Cards.jsx';
import {
  MEASURE_OPTIONS, TARGET_CURRENCIES, targetValues, newTargetFields, targetEditChanges, businessTargets, freeMeasure,
} from './targetForm.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const TargetsContext = createContext(null);

/** Around the monthly plan's business cards: the month's targets (this device's copy) and the server's actuals. */
export function TargetsProvider({ month, children }) {
  const { records } = useRecords('target', { where: (r) => r.month === month }, [month]);
  const today = localDate();
  const { data, offline, reload } = useServerData(`/api/overview/targets?month=${month.slice(0, 7)}&today=${today}`, { everyMs: 60_000 });
  // A target set or changed here reaches the server with the next sync (about a second and a half later): ask again then.
  const signature = records.map((r) => `${r.id}:${r.amount}:${r.currency ?? ''}`).sort().join('|');
  useEffect(() => {
    if (!signature) return undefined;
    const timer = setTimeout(() => reload?.(), 3000);
    return () => clearTimeout(timer);
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = useMemo(() => {
    const actuals = new Map();
    for (const b of data?.businesses ?? []) for (const t of b.targets) actuals.set(t.id, t);
    return { month, records, actuals, offline, today, loaded: Boolean(data) };
  }, [month, records, data, offline, today]);
  return <TargetsContext.Provider value={value}>{children}</TargetsContext.Provider>;
}

function TargetItem({ target, extras, ctx, onOpen }) {
  const server = ctx.actuals.get(target.id);
  // The server's actual for this very target (and amount); else "so far" can't be shown without a connection.
  const fresh = server && server.amount === target.amount && (server.currency ?? 'CAD') === (target.currency ?? 'CAD');
  const line = targetLine({ ...target, currency: isMoneyMeasure(target.measure) ? (target.currency ?? 'CAD') : null, actual: fresh ? server.actual : null, partial: fresh && server.partial, reason: fresh ? server.reason : null, pace: fresh ? server.pace : null, extras: [] },
    { month: ctx.month.slice(0, 7), today: ctx.today });
  const removeExtras = async () => {
    for (const x of extras) await store.remove('target', x.id);
  };
  return (
    <li className="overview-target" data-target-id={target.id} data-measure={target.measure}>
      <button type="button" className="overview-target-open" onClick={() => onOpen(target)} aria-label={`Change the target: ${line.label}`}>
        <span className="overview-target-head">
          <span style={{ fontWeight: 600 }}>{line.label}</span>
          <span className="overview-figure" data-testid="target-value">{fresh ? line.value : `Target ${measureValue(target.measure, target.amount, target.currency ?? 'CAD')}`}</span>
        </span>
      </button>
      {fresh ? <TargetBar line={line} /> : null}
      <span style={{ ...muted, fontSize: 'var(--text-xs)' }} data-testid="target-so-far">
        {fresh ? [line.statusText, line.detail].filter(Boolean).join(' · ')
          : ctx.offline ? 'So far: needs a connection to the suite (sales are worked out there).' : ctx.loaded ? 'So far: saving…' : 'So far: …'}
      </span>
      {extras.length ? (
        <Notice tone="warn">
          <span data-testid="target-twice">Set on two devices: the one changed last counts.</span>{' '}
          <TextButton onClick={removeExtras}>Remove the extra</TextButton>
        </Notice>
      ) : null}
    </li>
  );
}

/** A business's targets for the month on the monthly plan, with "+ Target". */
export function BusinessTargets({ business }) {
  const ctx = useContext(TargetsContext);
  const [sheet, setSheet] = useState(null);
  if (!ctx) return null;
  const { current, extras } = businessTargets(ctx.records, business.id);
  return (
    <div className="planner-month-targets" data-testid={`month-targets-${business.id}`} style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <h3 style={{ ...muted, fontWeight: 600, margin: 0 }}>Targets</h3>
        <TextButton style={{ marginLeft: 'auto' }} onClick={() => setSheet({ initial: { measure: freeMeasure(current) } })} aria-label={`Add a target for ${business.name}`}>
          <Icon name="plus" size={14} />Target
        </TextButton>
      </div>
      {current.length ? (
        <ul className="overview-targets">
          {current.map((t) => <TargetItem key={t.id} target={t} extras={extras.get(t.id) ?? []} ctx={ctx} onOpen={(r) => setSheet({ record: r })} />)}
        </ul>
      ) : <p style={{ ...muted, margin: 0 }}>No targets this month: sales, orders, new clients or leads won, measured by the suite.</p>}
      {sheet ? <TargetSheet record={sheet.record} initial={sheet.initial} business={business} month={ctx.month} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

/** Set or change one target (offline). */
export function TargetSheet({ record = null, initial = {}, business, month, onClose }) {
  const [start] = useState(() => targetValues(record, initial));
  const [v, setV] = useState(start);
  const [problems, setProblems] = useState({});
  const { busy, error, run } = useAction();
  const live = useRecord('target', record?.id ?? null).record;
  const set = (k) => (e) => setV((cur) => ({ ...cur, [k]: e?.target ? e.target.value : e }));
  const money = isMoneyMeasure(v.measure);
  const save = async () => {
    const r = record ? targetEditChanges(start, v) : newTargetFields(v, { businessId: business.id, month });
    setProblems(r.problems);
    if (Object.keys(r.problems).length) return;
    const ok = await run(async () => {
      if (record) {
        if (Object.keys(r.fields).length) await store.update('target', record.id, r.fields);
      } else {
        await store.create('target', r.fields);
      }
    });
    if (ok) onClose();
  };
  const remove = record ? async () => {
    if (await run(() => store.remove('target', record.id))) onClose();
  } : null;
  const dirty = Object.keys(v).some((k) => (v[k] ?? '') !== (start[k] ?? ''));
  return (
    <FormSheet
      title={record ? `${business.name}: ${MEASURE_LABELS[record.measure]}` : `New target for ${business.name}`}
      testId="target-form"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
      onDelete={remove}
      deleteWarning="Remove this target? The month’s sales and clients aren’t touched."
    >
      {live ? <RecordSync record={live} what="target" /> : null}
      {record ? null : (
        <SelectField id="target-measure" label="What to measure" value={v.measure} onChange={set('measure')} error={problems.measure} options={MEASURE_OPTIONS} />
      )}
      <span style={muted}>{MEASURE_HELP[v.measure]}</span>
      <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
        <TextField
          id="target-amount"
          label={money ? 'Target ($)' : 'Target'}
          inputMode={money ? 'decimal' : 'numeric'}
          value={v.amount}
          onChange={set('amount')}
          error={problems.amount}
          autoFocus={!record}
          placeholder={money ? 'e.g. 12,000' : 'e.g. 5'}
        />
        {money ? (
          <SelectField id="target-currency" label="Currency" value={v.currency} onChange={set('currency')} options={TARGET_CURRENCIES.map((c) => ({ value: c, label: c }))} />
        ) : null}
      </div>
      <TextAreaField id="target-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} error={problems.notes} rows={2} />
      <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>For {business.name}, the calendar month. Saved on this device and sent when it can be.</span>
    </FormSheet>
  );
}
