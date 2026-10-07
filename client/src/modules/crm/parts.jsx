// Small pieces the client screens share: business chips, sync state per record, a form sheet
// with save / delete-with-confirm, and the busy/error state of a store call.
import { useCallback, useState } from 'react';
import { Badge, Button, Notice, Sheet } from '../../ui/index.js';
import { useSyncEngine } from '../../sync/index.js';
import { ClashPanel, SyncBadges } from '../../sync/components.jsx';
import { businessColor, businessShortName, errorText } from './logic.js';

/** One of our businesses as a coloured chip. `short` uses initials for long names (list rows). */
export function BusinessChip({ business, short = false }) {
  const name = business?.name ?? 'Unknown business';
  return (
    <span
      title={short ? name : undefined}
      aria-label={short ? name : undefined}
      data-business-chip={business?.id}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px 2px 6px', borderRadius: 999,
        background: 'var(--surface-2)', fontSize: 'var(--text-xs)', fontWeight: 600, whiteSpace: 'nowrap',
        maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text)', lineHeight: 1.5,
      }}
    >
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 999, background: businessColor(business), flexShrink: 0 }} />
      <span aria-hidden={short ? true : undefined}>{short ? businessShortName(business) : name}</span>
      {business?.archived && !short ? <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(archived)</span> : null}
    </span>
  );
}

/** Busy/error state around a store call; errors come out in plain English (errorText). */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/**
 * A record's sync state where it is shown: a banner when it is flagged (kept after a delete on
 * another device, or a change under it), and its clashes to settle.
 */
export function RecordSync({ record, what }) {
  const engine = useSyncEngine();
  if (!record?._sync) return null;
  const { flagged, clashes } = record._sync;
  if (!flagged && !clashes?.length) return null;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      {flagged ? (
        <Notice tone="warn">
          <strong>Check this {what}.</strong> It was deleted on one device while it (or something under it) was being
          changed on another, so it was kept. {clashes?.some((c) => c.kind === 'delete') ? 'Keep it or delete it below.' : ''}
        </Notice>
      ) : null}
      <ClashPanel record={record} definition={engine?.definition(record._sync.entity)} />
    </div>
  );
}

/** "Waiting to sync" / "Check this" / "N clashes" badges, in a row that wraps. */
export function Badges({ record, children }) {
  return (
    <span style={{ display: 'inline-flex', gap: 'var(--space-1)', flexWrap: 'wrap', alignItems: 'center' }}>
      {children}
      <SyncBadges record={record} />
    </span>
  );
}

export function StatusBadge({ status }) {
  const tone = { active: 'ok', paused: 'warn', closed: 'neutral', ended: 'neutral', done: 'accent', cancelled: 'neutral' }[status] ?? 'neutral';
  return <Badge tone={tone}>{status ? status.charAt(0).toUpperCase() + status.slice(1) : '—'}</Badge>;
}

/**
 * A form in a Sheet: Save / Cancel, an inline error, and (for an existing record) "Delete…" with
 * a confirm that says what deleting does. Deleting is for mistakes; normal use is a status.
 */
export function FormSheet({ title, onClose, onSave, busy, error, children, onDelete, deleteWarning, testId, saveLabel = 'Save' }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Sheet
      title={title}
      onClose={onClose}
      onSubmit={() => !busy && onSave()}
      testId={testId}
      footer={confirming ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)', width: '100%' }}>
          <Notice tone="warn">{deleteWarning}</Notice>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="danger" disabled={busy} onClick={onDelete}>Delete</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Keep it</Button>
          </div>
        </div>
      ) : (
        <>
          <Button variant="primary" type="submit" disabled={busy}>{saveLabel}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {onDelete ? (
            <Button variant="ghost" style={{ marginLeft: 'auto', color: 'var(--danger)' }} onClick={() => setConfirming(true)}>Delete…</Button>
          ) : null}
        </>
      )}
    >
      {children}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Sheet>
  );
}

/** A small text button (links-as-buttons inside cards), a full tap target high. */
export function TextButton({ children, onClick, style, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 0, background: 'transparent', color: 'var(--accent)', fontWeight: 600, padding: '0 var(--space-2)',
        minHeight: 'var(--tap)', cursor: 'pointer', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center', gap: 4, ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
