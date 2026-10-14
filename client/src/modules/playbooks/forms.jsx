// The playbook screens' sheets (D9): a playbook's details, one step, a run's details, and Run (the
// choices, a preview of everything it will make, then one save). Every write goes through the offline
// store, so all of it works with no connection; an edit sends only what changed (the CRM's useForm).
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RELATIONSHIP_KINDS, SERVICE_PERIODS } from '@suite/shared/crm';
import { OWNERS } from '@suite/shared/actors';
import { newId } from '@suite/shared/ids';
import {
  PLAYBOOK_REPEATS, REPEAT_LABELS, OFFSET_UNITS, STEP_OWNERS, STEP_OWNER_LABELS, STEP_ACTIONS, PLAYBOOK_NAME_MAX, STEP_TITLE_MAX, STAGE_MAX,
  repeatOf, monthLabel,
} from '@suite/shared/playbooks';
import { TextField, SelectField, TextAreaField, CheckboxField, Notice, Sheet, Button } from '../../ui/index.js';
import { formatDate, localDate } from '../../ui/format.js';
import { store } from '../../sync/index.js';
import { FormSheet, useAction } from '../crm/parts.jsx';
import { useForm, deleter } from '../crm/forms.jsx';
import { pickableBusinesses, KIND_LABELS, PERIOD_LABELS, fold } from '../crm/logic.js';
import { ownerLabel } from '../planner/logic.js';
import {
  playbookForm, stepForm, runForm, ACTION_LABELS, OFFSET_UNIT_LABELS, planRun, applyRun, keptRunIds, forgetRunIds, defaultRunName,
  relationshipLine, runsUnderWay,
} from './logic.js';

const row = { display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' };
const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const opts = (values, labels) => values.map((v) => ({ value: v, label: labels[v] ?? v }));
const storage = () => { try { return window.localStorage; } catch { return null; } };

export function PlaybookForm({ record, initial, businesses, onClose, onDone, onDeleted }) {
  const { v, set, save, dirty, problems, busy, error, run } = useForm(playbookForm, record, { entity: 'playbook', onDone, initial });
  return (
    <FormSheet
      title={record ? 'Edit playbook' : 'New playbook'}
      testId="playbook-form"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
      onDelete={deleter(run, 'playbook', record, onDeleted)}
      deleteWarning="Delete this playbook? Only for a mistake: runs already started keep their own steps and tasks. To stop offering it, archive it instead."
    >
      <TextField id="playbook-name" label="Name" value={v.name} onChange={set('name')} autoFocus={!record} maxLength={PLAYBOOK_NAME_MAX} error={problems.name} hint="e.g. Website launch, Packing an order" />
      <div style={row}>
        <SelectField
          id="playbook-business"
          label="Business"
          value={v.business_id}
          onChange={set('business_id')}
          error={problems.business_id}
          options={[{ value: '', label: 'Choose…' }, ...pickableBusinesses(businesses, record?.business_id ?? null).map((b) => ({ value: b.id, label: b.name }))]}
        />
        <SelectField id="playbook-repeat" label="Runs" value={v.repeat} onChange={set('repeat')} options={opts(PLAYBOOK_REPEATS, REPEAT_LABELS)}
          hint={v.repeat === 'monthly' ? 'A retainer: the steps again each month' : 'A project, a job, a checklist'} />
      </div>
      <CheckboxField id="playbook-client" label="For a client" checked={v.for_client} onChange={set('for_client')} hint="A run asks which client; its tasks name them" />
      {v.for_client ? (
        <SelectField
          id="playbook-kind"
          label="What we do for them (optional)"
          value={v.kind}
          onChange={set('kind')}
          options={[{ value: '', label: '—' }, ...opts(RELATIONSHIP_KINDS, KIND_LABELS)]}
          hint="A run uses the client’s relationship of this kind with the business, and adds one when they have none"
        />
      ) : null}
      <TextAreaField id="playbook-description" label="When to use it (optional)" value={v.description} onChange={set('description')} rows={2} />
      {record ? <CheckboxField id="playbook-archived" label="Archived" checked={v.archived} onChange={set('archived')} hint="Hidden from the list; its runs carry on" /> : null}
    </FormSheet>
  );
}

export function StepForm({ record, initial, playbook, businesses, onClose, onDone, onDeleted }) {
  const { v, set, save, dirty, problems, busy, error, run } = useForm(stepForm, record, { entity: 'playbook_step', parent: { playbook_id: playbook.id }, onDone, initial });
  const renewal = v.action === 'renewal';
  return (
    <FormSheet
      title={record ? 'Edit step' : 'New step'}
      testId="step-form"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
      onDelete={deleter(run, 'playbook_step', record, onDeleted)}
      deleteWarning="Delete this step? Runs already started keep it; only new runs leave it out."
    >
      {playbook.for_client ? (
        <SelectField id="step-action" label="What it does" value={v.action} onChange={set('action')} options={opts(STEP_ACTIONS, ACTION_LABELS)} />
      ) : null}
      <TextField id="step-title" label={renewal ? 'Name' : 'Task'} value={v.title} onChange={set('title')} autoFocus={!record} maxLength={STEP_TITLE_MAX} error={problems.title}
        hint={renewal ? 'e.g. Hosting renewal' : 'Its title on the task list'} />
      <div style={row}>
        <TextField id="step-offset" label="When" inputMode="numeric" value={v.offset_amount} onChange={set('offset_amount')} error={problems.offset_amount}
          hint="0 = the start day; −2 = two before it" />
        <SelectField id="step-unit" label="…after the start" value={v.offset_unit} onChange={set('offset_unit')} options={opts(OFFSET_UNITS, OFFSET_UNIT_LABELS)} />
      </div>
      <TextField id="step-stage" label="Stage (optional)" value={v.stage} onChange={set('stage')} maxLength={STAGE_MAX} error={problems.stage} hint="Steps are grouped by stage on a run: Build, Launch, After launch…" />
      {renewal ? (
        <>
          <div style={row}>
            <TextField id="step-service" label="The client’s service" value={v.service_name} onChange={set('service_name')} error={problems.service_name} hint="Set on theirs by this name; added when they have none" />
            <SelectField id="step-period" label="Renews" value={v.service_period} onChange={set('service_period')} options={opts(SERVICE_PERIODS, PERIOD_LABELS)} />
          </div>
          <TextField id="step-amount" label="They pay $ (optional)" inputMode="decimal" value={v.service_amount} onChange={set('service_amount')} error={problems.service_amount} hint="Only for a service the run adds" />
          <p style={{ ...muted, margin: 0 }}>The renewal reminder comes 30 days before that date, on its own.</p>
        </>
      ) : (
        <>
          <div style={row}>
            <SelectField id="step-owner" label="Who does it" value={v.owner} onChange={set('owner')} options={opts(STEP_OWNERS, STEP_OWNER_LABELS)} />
            <TextField id="step-estimate" label="Minutes (optional)" inputMode="numeric" value={v.estimate_minutes} onChange={set('estimate_minutes')} error={problems.estimate_minutes} />
          </div>
          {playbook.for_client ? (
            <>
              <CheckboxField id="step-offer" label="Only when they don’t have a service of ours yet (an offer)" checked={v.offer} onChange={set('offer')} />
              {v.offer ? (
                <div style={row}>
                  <SelectField id="step-offer-business" label="Our business" value={v.only_if_lacks_business} onChange={set('only_if_lacks_business')} error={problems.offer}
                    options={[{ value: '', label: 'Choose…' }, ...pickableBusinesses(businesses, record?.only_if_lacks_business ?? null).map((b) => ({ value: b.id, label: b.name }))]} />
                  <SelectField id="step-offer-kind" label="Service" value={v.only_if_lacks_kind} onChange={set('only_if_lacks_kind')}
                    options={[{ value: '', label: 'Choose…' }, ...opts(RELATIONSHIP_KINDS.filter((k) => k !== 'wholesale'), KIND_LABELS)]} />
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
      <TextAreaField id="step-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} rows={3} hint="Copied into the task" />
      <TextAreaField id="step-links" label="Files and links (optional)" value={v.links} onChange={set('links')} rows={3}
        hint="One per line: a web address (with a label before it if you like), or a few words saying where the file is" />
      <p style={{ ...muted, margin: 0 }}>Changes apply to runs started from now on.</p>
    </FormSheet>
  );
}

export function RunEditForm({ record, onClose, onDone }) {
  const { v, set, save, dirty, problems, busy, error } = useForm(runForm, record, { entity: 'playbook_run', onDone });
  return (
    <FormSheet title="Edit run" testId="run-form" onClose={onClose} dirty={dirty} busy={busy} error={error} onSave={save}>
      <TextField id="run-name" label="Name" value={v.name} onChange={set('name')} error={problems.name} />
      {repeatOf(record) === 'monthly' ? (
        <TextField id="run-end" label="Last month starts by (optional)" type="date" value={v.end_date} onChange={set('end_date')} error={problems.end_date} hint="No months start after this day" />
      ) : null}
      <TextAreaField id="run-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} rows={4} />
    </FormSheet>
  );
}

/**
 * Run a playbook: who for (a client and their account, when it is for a client), the start day, who does
 * it, a preview of every task, renewal date and skipped offer — then one save (ids made once: a retry or
 * a double tap never runs it twice). Opens the run's page when saved.
 */
export function RunSheet({ playbook, data, me, initialClientId = '', onClose }) {
  const navigate = useNavigate();
  const steps = useMemo(() => data.stepsOf(playbook.id), [data, playbook.id]);
  const forClient = Boolean(playbook.for_client);
  const monthly = repeatOf(playbook) === 'monthly';
  const [clientId, setClientId] = useState(initialClientId);
  const [find, setFind] = useState('');
  const accounts = clientId ? data.accountsOf(clientId) : [];
  const [accountChoice, setAccountChoice] = useState('');
  const accountId = accountChoice || (accounts.length === 1 ? accounts[0].id : '');
  const [startDate, setStartDate] = useState(localDate());
  const [endDate, setEndDate] = useState('');
  const [owner, setOwner] = useState('');
  const [name, setName] = useState(null); // null = the default name (follows the client)
  const [moveLater, setMoveLater] = useState(false);
  const saving = useRef(false); // a second tap while saving does nothing (review fix)
  const { busy, error, run } = useAction();
  const [tried, setTried] = useState(false);
  const account = accountId ? data.accountsById.get(accountId) : null;
  const runName = name ?? defaultRunName(playbook, account);
  const choice = {
    name: runName, startDate, clientId: forClient ? clientId : '', accountId: forClient ? accountId : '', owner, endDate: monthly ? endDate : '',
    moveLaterRenewals: moveLater,
  };
  const underWay = forClient && accountId ? runsUnderWay(data.runs, playbook.id, accountId) : [];
  const crm = { businessesById: data.businessesById, accountsById: data.accountsById, relationships: data.relationships, services: data.services };
  const previewIds = useMemo(() => keptRunIds(null, `preview:${playbook.id}`, {}, steps.map((s) => s.id), newId), [playbook.id, steps]);
  const plan = planRun({ playbook, steps, choice, me, ids: previewIds, data: crm });
  const clients = useMemo(() => {
    const words = fold(find).split(/\s+/).filter(Boolean);
    return data.clients.filter((c) => c.status !== 'closed' && words.every((w) => fold(c.name).includes(w)))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, 100);
  }, [data.clients, find]);
  const businessName = (id) => data.businessesById.get(id)?.name ?? 'that business';

  const save = async () => {
    setTried(true);
    if (Object.keys(plan.problems).length || busy || saving.current) return;
    saving.current = true;
    const ids = keptRunIds(storage(), playbook.id, choice, steps.map((s) => s.id), newId);
    const real = planRun({ playbook, steps, choice, me, ids, data: crm });
    const ok = await run(async () => {
      await applyRun(store, real);
      forgetRunIds(storage(), playbook.id);
    });
    saving.current = false;
    if (ok) navigate(`/playbooks/runs/${ids.run}`);
  };

  const p = tried ? plan.problems : {};
  return (
    <Sheet
      title={`Run “${playbook.name}”`}
      onClose={onClose}
      onSubmit={save}
      testId="run-sheet"
      footer={(
        <>
          <Button variant="primary" type="submit" disabled={busy}>Run it</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </>
      )}
    >
      {forClient ? (
        <>
          {clientId && data.clientsById.get(clientId) ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <span>For <strong>{data.clientsById.get(clientId).name}</strong></span>
              <Button variant="ghost" onClick={() => { setClientId(''); setAccountChoice(''); }}>Change</Button>
            </div>
          ) : (
            <>
              <TextField id="run-find" label="Client" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Type part of the name" error={p.client} />
              <SelectField
                id="run-client"
                label="Pick the client"
                value={clientId}
                onChange={(val) => { setClientId(val); setAccountChoice(''); }}
                options={[{ value: '', label: clients.length ? 'Choose…' : 'No client matches' }, ...clients.map((c) => ({ value: c.id, label: c.name }))]}
              />
            </>
          )}
          {clientId && accounts.length > 1 ? (
            <SelectField id="run-account" label="Their account" value={accountId} onChange={setAccountChoice} error={p.account}
              options={[{ value: '', label: 'Choose…' }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]} />
          ) : null}
          {clientId && !accounts.length ? <Notice tone="warn">This client has no account yet: add one on their page first.</Notice> : null}
        </>
      ) : null}
      <TextField id="run-name" label="Name" value={runName} onChange={(e) => setName(e.target.value)} error={p.name} />
      <div style={row}>
        <TextField id="run-start" label={monthly ? 'First month starts' : 'Start day'} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} error={p.startDate} />
        {monthly ? <TextField id="run-end" label="Last month starts by (optional)" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} error={p.endDate} /> : null}
        <SelectField id="run-owner" label="Who does it" value={owner} onChange={setOwner}
          options={[{ value: '', label: 'As each step says' }, ...OWNERS.map((o) => ({ value: o, label: o === 'shared' ? 'Shared list' : o === me ? 'Me' : 'My partner' }))]} />
      </div>
      {p.steps ? <Notice tone="warn">{p.steps}</Notice> : null}
      {underWay.map((r) => (
        <Notice key={r.id} tone="warn"><span data-testid="run-under-way">Already under way: {r.name}, started {formatDate(r.start_date)}.</span></Notice>
      ))}
      {plan.preview?.items.some((i) => i.keptLater) || (moveLater && plan.preview?.items.some((i) => i.from)) ? (
        <CheckboxField id="run-move-later" label="Also move renewal dates that are later than the playbook’s" checked={moveLater} onChange={setMoveLater} />
      ) : null}
      {plan.preview ? <RunPreview preview={plan.preview} me={me} businessName={businessName} monthly={monthly} startDate={startDate} /> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Sheet>
  );
}

function RunPreview({ preview, me, businessName, monthly, startDate }) {
  const rel = relationshipLine(preview.relationship, businessName);
  return (
    <div data-testid="run-preview" style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <strong style={{ fontSize: 'var(--text-sm)' }}>It will make</strong>
      {rel ? <span style={muted}>{rel}</span> : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-1)' }}>
        {preview.items.map((i) => (
          <li key={i.stepId} data-preview-kind={i.kind} style={{ fontSize: 'var(--text-sm)', overflowWrap: 'anywhere', color: i.kind === 'skipped' ? 'var(--text-muted)' : 'var(--text)' }}>
            {i.kind === 'task' ? <>{formatDate(i.date)} · {i.title} <span style={muted}>({ownerLabel(i.owner, me)})</span></> : null}
            {i.kind === 'renewal' ? (
              i.keptLater ? <>{i.service} already renews on {formatDate(i.from)} (later): left as it is</>
                : i.from ? <>{i.service}’s renewal moves from {formatDate(i.from)} to {formatDate(i.date)}</>
                  : <>{i.service} renews on {formatDate(i.date)}{i.existing ? ' (their service)' : ' (added)'}</>
            ) : null}
            {i.kind === 'skipped' ? <>Left out: {i.title} — {i.why}</> : null}
          </li>
        ))}
      </ul>
      {monthly && startDate ? <span style={muted}>Then the same steps every month after {monthLabel(startDate)}, made a week ahead.</span> : null}
    </div>
  );
}
