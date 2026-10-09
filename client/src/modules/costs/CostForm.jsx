// Add / edit one recurring cost (D6), in a sheet like the CRM's forms: written through the offline
// store (works with no connection), an edit sends only the fields changed since the sheet opened,
// Delete is behind a confirm (for mistakes — Cancelled is how a cost stops).
import { COST_PERIODS, COST_PERIOD_LABELS, COST_STATUSES, COST_NAME_MAX, COST_REMINDER_DAYS } from '@suite/shared/costs';
import { TextField, SelectField, TextAreaField, CheckboxField } from '../../ui/index.js';
import { FormSheet } from '../crm/parts.jsx';
import { useForm, deleter } from '../crm/forms.jsx';
import { pickableBusinesses, titleCase } from '../crm/logic.js';
import { costForm, relationshipOptions, currencyOptions } from './logic.js';

const row = { display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' };

/**
 * @param {object} props
 * @param {object} [props.record] the cost to edit (none = a new one)
 * @param {object} [props.initial] values for a new one (business_id, relationship_id)
 * @param {{ businesses, relationships, accounts, clients }} props.data what the pickers list
 */
export function CostForm({ record, initial, data, onClose, onDone, onDeleted }) {
  const { v, set, save, dirty, problems, busy, error, run } = useForm(costForm, record, { entity: 'recurring_cost', onDone, initial });
  const businesses = pickableBusinesses(data.businesses, record?.business_id ?? null);
  const rels = relationshipOptions(data, record?.relationship_id ?? null);
  const once = v.period === 'once';
  return (
    <FormSheet
      title={record ? 'Edit cost' : 'New cost'}
      testId="cost-form"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
      onDelete={deleter(run, 'recurring_cost', record, onDeleted)}
      deleteWarning="Delete this cost? Only for a mistake: when you stop paying for it, set its status to Cancelled (it stays in the list, out of the totals)."
    >
      <TextField id="cost-name" label="Name" value={v.name} onChange={set('name')} autoFocus={!record} maxLength={COST_NAME_MAX} error={problems.name} hint="e.g. Hosting, Domain leftys.ca, Home insurance" />
      <div style={row}>
        <SelectField
          id="cost-business"
          label="Paid by"
          value={v.business_id}
          onChange={set('business_id')}
          error={problems.business_id}
          options={[{ value: '', label: 'Choose…' }, ...businesses.map((b) => ({ value: b.id, label: b.archived ? `${b.name} (archived)` : b.name }))]}
          hint="Personal for the home"
        />
        <TextField id="cost-vendor" label="Vendor (optional)" value={v.vendor} onChange={set('vendor')} maxLength={200} />
      </div>
      <div style={row}>
        <TextField id="cost-amount" label="Amount $ (optional)" inputMode="decimal" value={v.amount} onChange={set('amount')} error={problems.amount} hint="Each time it’s paid" />
        <SelectField id="cost-currency" label="Currency" value={v.currency} onChange={set('currency')} options={currencyOptions(v.currency)} />
        <SelectField id="cost-period" label="How often" value={v.period} onChange={set('period')} options={COST_PERIODS.map((p) => ({ value: p, label: COST_PERIOD_LABELS[p] }))} />
      </div>
      <div style={row}>
        <TextField
          id="cost-next"
          label={once ? 'Paid on' : 'Next renewal'}
          type="date"
          value={v.next_renewal}
          onChange={set('next_renewal')}
          error={problems.next_renewal}
          hint={once ? 'A one-time cost: no reminder after this date' : `A reminder comes ${COST_REMINDER_DAYS} days before`}
        />
        <TextField id="cost-payment" label="Paid with (optional)" value={v.payment_method} onChange={set('payment_method')} maxLength={200} hint="e.g. Visa ••4242, chequing" />
      </div>
      {once ? null : (
        <CheckboxField
          id="cost-auto"
          label="Renews on its own"
          checked={v.auto_renews}
          onChange={set('auto_renews')}
          hint={v.period === 'monthly'
            ? 'Monthly and automatic: no reminder each month; the suite moves the date forward once it passes.'
            : 'Once the date passes, the suite moves it forward by the period. Unticked, it shows “Overdue — renewed?” until you set the next date.'}
        />
      )}
      {record ? (
        <SelectField id="cost-status" label="Status" value={v.status} onChange={set('status')} options={COST_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))} />
      ) : null}
      <div style={row}>
        <SelectField
          id="cost-relationship"
          label="Resold to a client (optional)"
          value={v.relationship_id}
          onChange={set('relationship_id')}
          options={[{ value: '', label: 'Not resold' }, ...rels]}
          hint="The client relationship we bill it on"
        />
        {v.relationship_id ? (
          <TextField id="cost-resold" label="They pay $ (optional)" inputMode="decimal" value={v.resold} onChange={set('resold')} error={problems.resold} hint="Per the same period" />
        ) : null}
      </div>
      <TextAreaField id="cost-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} />
    </FormSheet>
  );
}
