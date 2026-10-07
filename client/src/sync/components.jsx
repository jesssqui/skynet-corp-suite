// Building blocks for pages that show synced records: the sync bar, a record's clashes
// (keep / use the other), and generic field inputs driven by the entity definitions.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Badge, Icon, Notice } from '../ui/index.js';
import { useAuth } from '../auth/session.jsx';
import { useSyncEngine, useSyncStatus, useSyncData } from './hooks.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A field value for reading: '—' for empty, Yes/No for booleans. */
export function formatValue(field, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (field?.type === 'boolean' || typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** "phone_number" -> "Phone number" */
export function fieldLabel(name) {
  const s = name.replace(/_id$/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const chipStyle = {
  background: 'var(--warn-soft)', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', minHeight: 32,
  padding: '0 var(--space-3)', borderRadius: 999, fontSize: 'var(--text-sm)', fontWeight: 600, textDecoration: 'none',
};

const barTones = {
  quiet: { background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent' },
  offline: { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' },
  syncing: { background: 'var(--accent-soft)', color: 'var(--text)', border: '1px solid transparent' },
  warn: { background: 'var(--warn-soft)', color: 'var(--text)', border: '1px solid transparent' },
};

/** What the bar says for a status: { tone, icon, text, retry? } or null for nothing. */
export function describeStatus(status) {
  if (!status || status.phase === 'starting') return null;
  if (status.phase === 'stopped') {
    if (status.stoppedBy === 'device_mismatch') {
      return { tone: 'warn', icon: 'alert', text: 'Sync stopped: this tab is signed in as another device. Reload the page.' };
    }
    // Couldn't open the offline database at all (no IndexedDB, storage blocked).
    if (status.stoppedBy === 'unavailable') return { tone: 'warn', icon: 'alert', text: 'This browser can’t keep an offline copy' };
    return null;
  }
  const n = status.waiting;
  const changes = plural(n, 'change waiting', 'changes waiting');
  if (status.phase === 'offline') return { tone: 'offline', icon: 'cloudOff', text: n ? `Offline · ${changes}` : 'Offline' };
  if (status.phase === 'error') {
    return { tone: 'warn', icon: 'alert', text: n ? `${changes} · can’t sync right now` : 'Can’t sync right now', retry: true };
  }
  // Every sync shows "Syncing…" only when there is something to send or nothing was ever downloaded,
  // so the routine background check doesn't make the bar flicker.
  if (status.phase === 'syncing' && (n > 0 || !status.lastSyncAt)) return { tone: 'syncing', icon: 'sync', text: 'Syncing…', spin: true };
  if (n) {
    return { tone: 'offline', icon: 'cloud', text: status.parked === n ? `${changes} for records not here yet` : changes };
  }
  return { tone: 'quiet', icon: 'check', text: 'All changes saved' };
}

/** The bar at the top of every page: offline / waiting / syncing / saved, and what needs attention. */
export function SyncBar() {
  const engine = useSyncEngine();
  const status = useSyncStatus();
  const d = describeStatus(status);
  if (!d && !status?.attention && !status?.clockWarning) return null;
  const tone = barTones[d?.tone ?? 'quiet'];
  return (
    <div
      role="status"
      aria-live="polite"
      data-sync-phase={status?.phase}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
        gap: 'var(--space-2)', marginBottom: 'var(--space-4)', minHeight: 36,
      }}
    >
      {d ? (
        <span
          style={{
            ...tone, display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', minHeight: 32,
            padding: d.tone === 'quiet' ? 0 : '0 var(--space-3)', borderRadius: 999, fontSize: 'var(--text-sm)',
            fontWeight: 550, minWidth: 0,
          }}
        >
          <Icon
            name={d.icon}
            size={16}
            style={{ color: d.tone === 'quiet' ? 'var(--ok)' : 'inherit' }}
            {...(d.spin ? { className: 'sync-spin' } : {})}
          />
          <Link to="/sync" style={{ color: 'inherit', textDecoration: 'none' }} data-testid="sync-bar-text">{d.text}</Link>
          {d.retry && engine ? (
            <button
              type="button"
              onClick={() => engine.syncNow('manual')}
              style={{ border: 0, background: 'transparent', color: 'var(--accent)', fontWeight: 600, padding: '0 0 0 var(--space-1)', cursor: 'pointer', fontSize: 'inherit' }}
            >
              Retry
            </button>
          ) : null}
        </span>
      ) : <span />}
      {status?.clockWarning || status?.attention ? (
        <span style={{ display: 'inline-flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {status.clockWarning ? (
            <Link to="/sync" title={status.clockWarning} style={{ ...chipStyle, color: 'var(--warn)' }} data-testid="clock-warning">
              <Icon name="alert" size={16} />
              This device’s clock is off
              <Icon name="chevron" size={14} />
            </Link>
          ) : null}
          {status.attention ? (
            <Link to="/sync/attention" style={{ ...chipStyle, color: 'var(--warn)' }}>
              <Icon name="alert" size={16} />
              {plural(status.attention, 'needs attention', 'need attention')}
              <Icon name="chevron" size={14} />
            </Link>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function who(side, me) {
  const person = side.actor === me?.user?.actor ? 'you' : side.actor === 'system' ? 'the server' : 'the other person';
  const device = side.device === me?.device?.id ? ' on this device' : '';
  const when = side.at ? new Date(side.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  return `${person}${device}${when ? `, ${when}` : ''}`;
}

/**
 * A record's open clashes (record._sync.clashes) with a choice for each. Settling needs a
 * connection (the server decides; the record is pulled again after). Renders (and subscribes to
 * anything) only for a record that has clashes, so long lists can show one per row.
 */
export function ClashPanel({ record, definition }) {
  const clashes = record?._sync?.clashes ?? [];
  return clashes.length ? <Clashes clashes={clashes} definition={definition} /> : null;
}

function Clashes({ clashes, definition }) {
  const engine = useSyncEngine();
  const status = useSyncStatus();
  const { session } = useAuth();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const offline = status?.phase === 'offline';

  const settle = async (clash, resolution) => {
    setBusy(clash.id);
    setError(null);
    try {
      await engine.resolveClash(clash.id, resolution);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="clashes">
      {clashes.map((c) => {
        const field = definition?.fields?.[c.field];
        const disabled = offline || busy === c.id;
        return (
          <div
            key={c.id}
            style={{
              background: 'var(--warn-soft)', borderRadius: 'var(--radius)', padding: 'var(--space-3)',
              display: 'grid', gap: 'var(--space-2)', fontSize: 'var(--text-sm)',
            }}
          >
            {c.kind === 'delete' ? (
              <>
                <strong>Deleted on one device while it was changed on another</strong>
                <span style={{ color: 'var(--text-muted)' }}>
                  {c.winner.value?._child
                    ? `A ${c.winner.value._child.entity} under it was added or changed by ${who(c.winner, session)}`
                    : `Changed by ${who(c.winner, session)}`}
                  ; deleted by {who(c.loser, session)}.
                </span>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <Button disabled={disabled} onClick={() => settle(c, 'keep_winner')}>Keep it</Button>
                  <Button variant="danger" disabled={disabled} onClick={() => settle(c, 'keep_loser')}>Delete it</Button>
                </div>
              </>
            ) : (
              <>
                <strong>{fieldLabel(c.field)} was changed on two devices at once</strong>
                <div style={{ display: 'grid', gap: 'var(--space-2)', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Now: by {who(c.winner, session)}</span>
                    <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{formatValue(field, c.winner.value)}</span>
                    <Button disabled={disabled} onClick={() => settle(c, 'keep_winner')}>Keep this</Button>
                  </div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Other: by {who(c.loser, session)}</span>
                    <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{formatValue(field, c.loser.value)}</span>
                    <Button disabled={disabled} onClick={() => settle(c, 'keep_loser')}>Use this instead</Button>
                  </div>
                </div>
              </>
            )}
            {offline ? <span style={{ color: 'var(--text-muted)' }}>Settling this needs a connection.</span> : null}
          </div>
        );
      })}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

const inputStyle = {
  minHeight: 'var(--tap)', padding: '0 var(--space-3)', fontSize: 16, background: 'var(--surface)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius)', width: '100%',
};

/** A label of a record for pickers: its first text field. */
function recordLabel(def, rec) {
  const text = Object.values(def?.fields ?? {}).find((f) => f.type === 'text' && rec[f.name]);
  return text ? rec[text.name] : rec.id.slice(-8);
}

/**
 * A picker for an `id` field: the records of the entity it points to (`ref`), or every record on
 * this device when it doesn't say. Only rendered in forms, so a long list's rows never load or
 * subscribe to this.
 */
function IdSelect({ field, id, value, onChange }) {
  const { data } = useSyncData(async (engine) => {
    const out = [];
    for (const def of engine.entities().filter((d) => !field.ref || d.entity === field.ref)) {
      for (const rec of await engine.list(def.entity)) {
        out.push({ value: rec.id, label: field.ref ? recordLabel(def, rec) : `${def.entity} · ${recordLabel(def, rec)}` });
      }
    }
    return out;
  }, [field.ref], { entities: field.ref ? [field.ref] : null });
  const opts = data ?? [];
  return (
    <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} style={inputStyle}>
      <option value="">{field.required ? 'Choose…' : '—'}</option>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {value && !opts.some((o) => o.value === value) ? <option value={value}>{value}</option> : null}
    </select>
  );
}

// Text fields with a `format`: the matching keyboard (the engine stores the normalised value on save).
const FORMAT_INPUT = {
  email: { type: 'email', inputMode: 'email', autoComplete: 'email' },
  phone: { type: 'tel', inputMode: 'tel', autoComplete: 'tel' },
  postal: { autoComplete: 'postal-code', autoCapitalize: 'characters' },
};

/** One input for a field definition ({ name, type, required, max, values, format, ref }). value/onChange use the field's own type. */
export function FieldInput({ field, value, onChange, idPrefix = 'f' }) {
  const id = `${idPrefix}-${field.name}`;
  const label = `${fieldLabel(field.name)}${field.required ? '' : ' (optional)'}`;
  let input;
  if (field.type === 'boolean') {
    return (
      <label htmlFor={id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', minHeight: 'var(--tap)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} style={{ width: 20, height: 20 }} />
        {fieldLabel(field.name)}
      </label>
    );
  }
  if (field.type === 'id') {
    input = <IdSelect field={field} id={id} value={value} onChange={onChange} />;
  } else if (field.type === 'enum') {
    input = (
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} style={inputStyle}>
        <option value="">{field.required ? 'Choose…' : '—'}</option>
        {field.values.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  } else if (field.type === 'integer' || field.type === 'number') {
    input = (
      <input
        id={id}
        type="number"
        inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
        step={field.type === 'integer' ? 1 : 'any'}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        style={inputStyle}
      />
    );
  } else if (field.type === 'date') {
    input = <input id={id} type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} style={inputStyle} />;
  } else if (field.type === 'text' && (field.max ?? 0) > 300) {
    input = (
      <textarea
        id={id}
        value={value ?? ''}
        maxLength={field.max}
        rows={3}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        style={{ ...inputStyle, padding: 'var(--space-2) var(--space-3)', resize: 'vertical' }}
      />
    );
  } else {
    input = (
      <input
        id={id}
        {...(FORMAT_INPUT[field.format] ?? {})}
        value={value ?? ''}
        maxLength={field.format === 'phone' ? 40 : field.max}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        style={inputStyle}
      />
    );
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <label htmlFor={id} style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{label}</label>
      {input}
    </div>
  );
}

/** Inputs for every field of a definition. */
export function FieldsForm({ definition, values, onChange, idPrefix }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {Object.values(definition.fields).map((f) => (
        <FieldInput
          key={f.name}
          field={f}
          idPrefix={idPrefix}
          value={values[f.name] ?? null}
          onChange={(v) => onChange({ ...values, [f.name]: v })}
        />
      ))}
    </div>
  );
}

/**
 * Signing out deletes this device's copy, unsent changes included. Text to warn with, or null.
 * (Asks for a sync as a side effect, so the warning may clear itself if the changes can still go.)
 */
export function useUnsentWarning() {
  const engine = useSyncEngine();
  const status = useSyncStatus();
  const n = status?.waiting ?? 0;
  if (!n) return { warning: null, sendNow: () => {} };
  return {
    warning: `${plural(n, 'change', 'changes')} on this device ${n === 1 ? 'hasn’t' : 'haven’t'} been sent yet. Signing out deletes ${n === 1 ? 'it' : 'them'}.`,
    sendNow: () => engine?.syncNow('sign-out'),
  };
}

/** Small badges for a record's sync state. */
export function SyncBadges({ record }) {
  const s = record?._sync;
  if (!s) return null;
  return (
    <>
      {s.pending ? <Badge tone="neutral">Waiting to sync</Badge> : null}
      {s.flagged ? <Badge tone="warn">Check this</Badge> : null}
      {s.clashes?.length ? <Badge tone="warn">{plural(s.clashes.length, 'clash', 'clashes')}</Badge> : null}
    </>
  );
}
