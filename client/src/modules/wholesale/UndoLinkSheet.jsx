// Undo an Order Manager link (D2), from the Wholesale page's Linked tab and from a client's account
// card. Asks the server first what undoing would put back and what would stay (GET …/undo: nothing
// changes), then undoes it (POST …/unlink). Needs a connection: the holding area and the record of
// what linking changed are on the server.
import { useEffect, useState } from 'react';
import { Button, Notice, Sheet } from '../../ui/index.js';
import { api } from '../../api/client.js';
import { store } from '../../sync/index.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const list = { margin: 0, paddingLeft: '1.2em', display: 'grid', gap: 4 };
const syncSoon = () => { try { store.syncNow(); } catch { /* signed out meanwhile */ } };

/**
 * @param {{ uid: string, customerName?: string, clientName?: string, how?: string, onClose: () => void,
 *   onDone: (undone: { restore: string[], keep: string[] }) => void }} props
 */
export default function UndoLinkSheet({ uid, customerName, clientName, how, onClose, onDone }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const offlineText = 'Can’t reach the suite server: undoing a link needs it (nothing was changed).';

  useEffect(() => {
    let alive = true;
    api.get(`/api/wholesale/customers/${uid}/undo`)
      .then((p) => alive && setPreview(p))
      .catch((err) => alive && setError(err.status === 0 ? offlineText : err.message));
    return () => { alive = false; };
  }, [uid]);

  async function undo() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/wholesale/customers/${uid}/unlink`, {});
      syncSoon();
      onDone(r.undone ?? { restore: [], keep: [] });
    } catch (err) {
      setError(err.status === 0 ? offlineText : err.message);
    } finally {
      setBusy(false);
    }
  }

  const name = customerName || 'this customer';
  return (
    <Sheet
      title={`Undo the link of ${name}`}
      onClose={onClose}
      testId="undo-link-sheet"
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={undo} disabled={busy || !preview}>{busy ? 'Undoing…' : 'Undo the link'}</Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {how ? <p style={{ ...muted, margin: 0 }}>{how}.</p> : null}
        <p style={{ margin: 0 }}>
          Its orders, payments, returns, refunds and notes leave {clientName ? `${clientName}’s` : 'the client’s'} timeline and it waits
          for a client again. The suite keeps them: linking again brings them all back. It won’t be linked
          {clientName ? ` to ${clientName}` : ''} automatically again.
        </p>
        {!preview && !error ? <p style={{ ...muted, margin: 0 }}>Checking what the link changed…</p> : null}
        {preview?.restore?.length ? (
          <div data-testid="undo-restore">
            <p style={{ margin: '0 0 4px', fontWeight: 600 }}>Put back as it was</p>
            <ul style={list}>{preview.restore.map((s) => <li key={s}>{s}</li>)}</ul>
          </div>
        ) : null}
        {preview?.keep?.length ? (
          <div data-testid="undo-keep">
            <p style={{ margin: '0 0 4px', fontWeight: 600 }}>Left as it is</p>
            <ul style={{ ...list, ...muted }}>{preview.keep.map((s) => <li key={s}>{s}</li>)}</ul>
          </div>
        ) : null}
        {preview && !preview.restore?.length && !preview.keep?.length ? (
          <p style={{ ...muted, margin: 0 }}>The link changed nothing else: only the link goes.</p>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Sheet>
  );
}
