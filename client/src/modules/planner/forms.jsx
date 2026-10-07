// The task sheet (add / edit, every field) and "Note on a client…" from the inbox. Writes go
// through the offline store; an edit sends only the fields changed since the sheet opened
// (taskForm.js), so the other person's change that arrives meanwhile survives. A sheet with
// typed input asks before it is thrown away (FormSheet).
import { useMemo, useRef, useState } from 'react';
import { TextField, SelectField, TextAreaField, CheckboxField, Segmented, Notice } from '../../ui/index.js';
import { localDate } from '../../ui/format.js';
import { store } from '../../sync/index.js';
import { useAuth } from '../../auth/session.jsx';
import { FormSheet, useAction } from '../crm/parts.jsx';
import { KIND_LABELS, pickableBusinesses, textOrNull, fold } from '../crm/logic.js';
import { taskForm, taskValues, editChanges, isDirty, linkChange } from './taskForm.js';
import { estimateOptions, otherActor, relationshipLabel, clearedFields, defaultBusinessId } from './logic.js';
import { usePlannerData } from './data.js';
import { getLastBusiness, setLastBusiness } from './prefs.js';
import { nowIso } from '../../ui/format.js';

const row = { display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' };
const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1);

/**
 * A new task's starting values: owner = whoever makes it, business = the one in context, else the
 * last one this person used here, else Personal (defaultBusinessId); plus what the caller knows
 * (client, account, relationship, title…).
 */
export function newTaskInitial({ me, businesses, context = null, ...rest }) {
  return {
    owner: me,
    business_id: defaultBusinessId({ context, lastUsed: getLastBusiness(me), businesses }),
    ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null)),
  };
}

/**
 * Add or edit a task. `initial` (new tasks): pre-filled values (newTaskInitial). `onSaved(id)` runs
 * after the store accepted it (before onDone), e.g. to clear the inbox item it came from.
 */
export function TaskSheet({ record = null, initial = {}, onClose, onDone, onDeleted, onSaved, title }) {
  const { session } = useAuth();
  const me = session?.user?.actor ?? 'owner';
  const { data } = usePlannerData();
  const today = localDate();
  const [start] = useState(() => taskValues(record, { today, initial }));
  const [v, setV] = useState(start);
  const [problems, setProblems] = useState({});
  const { busy, error, run } = useAction();
  // A new task saved once stays that task: if what runs after it (onSaved) fails, Save again
  // retries that part instead of making a second task.
  const created = useRef(null);

  const pick = useMemo(() => {
    if (!data) return null;
    const { businesses, clients, accounts, relationships, businessesById, accountsById, relationshipsById } = data;
    return { businesses, clients, accounts, relationships, businessesById, accountsById, relationshipsById };
  }, [data]);

  const set = (k) => (e) => {
    const value = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setV((cur) => (pick && ['client_id', 'account_id', 'relationship_id', 'due_date'].includes(k)
      ? linkChange(cur, k, value, pick)
      : { ...cur, [k]: value }));
  };

  const save = async () => {
    let fields;
    if (record) {
      const r = editChanges(taskForm, start, v);
      setProblems(r.problems);
      if (Object.keys(r.problems).length) return;
      fields = r.fields;
    } else {
      const r = taskForm.toFields(v);
      setProblems(r.problems);
      if (Object.keys(r.problems).length) return;
      fields = r.fields;
    }
    let id = record?.id ?? null;
    const ok = await run(async () => {
      if (!record) {
        id = created.current ?? await store.create('task', fields);
        created.current = id;
      } else if (Object.keys(fields).length) await store.update('task', record.id, fields);
      if (fields.business_id) setLastBusiness(me, fields.business_id);
      await onSaved?.(id);
    });
    if (ok) onDone?.(id);
  };

  const remove = record ? async () => {
    if (await run(() => store.remove('task', record.id))) (onDeleted ?? onClose)();
  } : null;

  const options = useMemo(() => {
    if (!pick) return null;
    const clientIds = new Set(pick.clients.map((c) => c.id));
    const clients = pick.clients.filter((c) => c.status !== 'closed' || c.id === v.client_id).sort(byName);
    const accounts = v.client_id ? pick.accounts.filter((a) => a.client_id === v.client_id).sort(byName) : [];
    const accountIds = new Set(accounts.map((a) => a.id));
    const relationships = pick.relationships.filter((r) => accountIds.has(r.account_id));
    return {
      businesses: pickableBusinesses(pick.businesses, v.business_id || null),
      clients,
      clientGone: Boolean(v.client_id) && !clientIds.has(v.client_id),
      accounts,
      accountGone: Boolean(v.account_id) && !pick.accountsById.has(v.account_id),
      relationships,
      relationshipGone: Boolean(v.relationship_id) && !pick.relationshipsById.has(v.relationship_id),
    };
  }, [pick, v.client_id, v.business_id, v.account_id, v.relationship_id]);

  const other = otherActor(me);
  return (
    <FormSheet
      title={title ?? (record ? 'Edit task' : 'New task')}
      testId="task-form"
      onClose={onClose}
      dirty={isDirty(start, v)}
      busy={busy}
      error={error}
      onSave={save}
      onDelete={remove}
      deleteWarning="Delete this task? Only for a mistake: when it’s finished, tick it instead."
    >
      <TextField
        id="task-title"
        label="Task"
        value={v.title}
        onChange={set('title')}
        autoFocus={!record && !initial.title}
        maxLength={300}
        error={problems.title}
      />
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Whose</span>
        <Segmented
          label="Whose"
          value={v.owner}
          onChange={set('owner')}
          options={[{ value: me, label: 'Mine' }, { value: other, label: 'Partner’s' }, { value: 'shared', label: 'Shared' }]}
        />
      </div>
      {!options ? <p style={{ margin: 0, color: 'var(--text-muted)' }}>Loading…</p> : (
        <>
          <SelectField
            id="task-business"
            label="Our business"
            value={v.business_id}
            onChange={set('business_id')}
            error={problems.business_id}
            options={[{ value: '', label: 'Choose…' }, ...options.businesses.map((b) => ({ value: b.id, label: b.archived ? `${b.name} (archived)` : b.name }))]}
          />
          <div style={row}>
            <TextField
              id="task-date"
              label="Due (optional)"
              type="date"
              value={v.due_date}
              onChange={set('due_date')}
              hint={v.relationship_id && !v.due_date ? 'A next step needs a date' : undefined}
            />
            <TextField
              id="task-time"
              label="Time (optional)"
              type="time"
              value={v.due_time}
              onChange={set('due_time')}
              disabled={!v.due_date}
              error={problems.due_time}
              title={v.due_date ? undefined : 'Pick a date first'}
            />
            <SelectField
              id="task-estimate"
              label="Estimate (optional)"
              value={v.estimate}
              onChange={set('estimate')}
              error={problems.estimate}
              options={[{ value: '', label: 'None' }, ...estimateOptions(v.estimate)]}
            />
          </div>
          <SelectField
            id="task-client"
            label="Client (optional)"
            value={v.client_id}
            onChange={set('client_id')}
            options={[
              { value: '', label: 'None' },
              ...(options.clientGone ? [{ value: v.client_id, label: '(deleted client)' }] : []),
              ...options.clients.map((c) => ({ value: c.id, label: c.status === 'closed' ? `${c.name} (closed)` : c.name })),
            ]}
          />
          {v.client_id ? (
            <div style={row}>
              <SelectField
                id="task-account"
                label="Their business (optional)"
                value={v.account_id}
                onChange={set('account_id')}
                options={[
                  { value: '', label: 'None in particular' },
                  ...(options.accountGone ? [{ value: v.account_id, label: '(deleted account)' }] : []),
                  ...options.accounts.map((a) => ({ value: a.id, label: a.name })),
                ]}
              />
              <SelectField
                id="task-relationship"
                label="Next step for (optional)"
                value={v.relationship_id}
                onChange={set('relationship_id')}
                options={[
                  { value: '', label: 'No relationship' },
                  ...(options.relationshipGone ? [{ value: v.relationship_id, label: '(deleted relationship)' }] : []),
                  ...options.relationships.map((r) => ({
                    value: r.id,
                    label: `${relationshipLabel(r, { ...pick, kindLabels: KIND_LABELS })}${r.status !== 'active' ? ` (${r.status})` : ''}`,
                  })),
                ]}
              />
            </div>
          ) : null}
        </>
      )}
      <TextAreaField id="task-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} rows={3} />
      <CheckboxField id="task-top" label="One of today’s top 3" checked={v.top} onChange={set('top')} />
      {record ? <CheckboxField id="task-done" label="Done" checked={v.done} onChange={set('done')} /> : null}
    </FormSheet>
  );
}

/**
 * "Note on a client…": an inbox item becomes a note (an activity) on the client picked here, dated
 * when it was captured; then the item leaves the inbox.
 */
export function InboxNoteSheet({ item, onClose, onDone }) {
  const { data } = usePlannerData();
  const [q, setQ] = useState('');
  const [clientId, setClientId] = useState('');
  const [businessId, setBusinessId] = useState('');
  const [body, setBody] = useState(item.text);
  const [problem, setProblem] = useState(null);
  const { busy, error, run } = useAction();
  const clients = useMemo(() => {
    if (!data) return [];
    const words = fold(q).split(/\s+/).filter(Boolean);
    return data.clients.filter((c) => words.every((w) => fold(c.name).includes(w))).sort(byName);
  }, [data, q]);
  const chosen = clientId ? data?.clientsById.get(clientId) : null;
  return (
    <FormSheet
      title="Note on a client"
      testId="inbox-note-form"
      onClose={onClose}
      dirty={Boolean(clientId) || body !== item.text || Boolean(businessId)}
      busy={busy}
      error={error}
      saveLabel="Add note"
      onSave={async () => {
        const text = textOrNull(body);
        if (!clientId || !text) {
          setProblem(!clientId ? 'Pick the client this note is about' : 'The note is empty');
          return;
        }
        const ok = await run(async () => {
          const id = await store.create('activity', { client_id: clientId, type: 'note', body: text, at: item.captured_at, business_id: businessId || null });
          await store.update('inbox_item', item.id, clearedFields({ entity: 'activity', id, now: nowIso() }));
        });
        if (ok) onDone?.();
      }}
    >
      <TextAreaField id="note-body" label="Note" value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
      {chosen ? (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>Client: {chosen.name}</span>
          <button type="button" className="crm-link-button" onClick={() => setClientId('')}>Change</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          <TextField id="note-client-search" label="Client" type="search" placeholder="Type part of the name" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4, maxHeight: 240, overflowY: 'auto' }} aria-label="Clients">
            {clients.slice(0, 30).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => { setClientId(c.id); setProblem(null); }}
                  style={{ width: '100%', textAlign: 'left', minHeight: 'var(--tap)', padding: '0 var(--space-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface)', color: 'var(--text)', fontSize: 'var(--text-md)', cursor: 'pointer' }}
                >
                  {c.name}{c.status === 'closed' ? ' (closed)' : ''}
                </button>
              </li>
            ))}
            {data && !clients.length ? <li style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No client matches.</li> : null}
          </ul>
        </div>
      )}
      <SelectField
        id="note-business"
        label="Our business (optional)"
        value={businessId}
        onChange={setBusinessId}
        options={[{ value: '', label: 'None in particular' }, ...pickableBusinesses(data?.businesses ?? []).map((b) => ({ value: b.id, label: b.name }))]}
      />
      {problem ? <Notice tone="warn">{problem}</Notice> : null}
    </FormSheet>
  );
}
