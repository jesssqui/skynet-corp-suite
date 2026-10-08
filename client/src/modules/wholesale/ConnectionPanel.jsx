// The Order Manager connection's settings on its Connections card (D1): the address to enter in the
// Order Manager (Settings → Integrations → Suite connection), and the shared secret — made here,
// shown once, never readable again (stored encrypted on the server). Either of you can make a new
// one; the Order Manager stops getting through until the new one is pasted there.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Notice } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { useAuth } from '../../auth/session.jsx';
import { actorLabel } from '../crm/logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const code = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--text-sm)', background: 'var(--surface-2)',
  padding: '6px 10px', borderRadius: 'var(--radius-sm)', overflowWrap: 'anywhere', userSelect: 'all',
};

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false); // no clipboard (plain http): the text is selectable instead
    }
  }
  return <Button onClick={copy}>{copied ? 'Copied' : label}</Button>;
}

export default function WomConnectionPanel({ offline, onChanged }) {
  const { session } = useAuth();
  const me = session?.user?.actor;
  const { data, replace } = useServerData('/api/wholesale/connection', { everyMs: 0 });
  const [secret, setSecret] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  if (!data) return null;
  const s = data.secret;

  async function make() {
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.post('/api/wholesale/connection/secret', {});
      setSecret(r.secret);
      replace(() => r.connection);
      setConfirming(false);
      onChanged?.();
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server: no secret was made.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }} data-testid="wom-settings">
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>In the Order Manager: Settings → Integrations → Suite connection</span>
        <span style={muted}>Suite address</span>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={code} data-testid="wom-url">{data.url}</code>
          <CopyButton text={data.url} />
        </div>
        <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>
          The Order Manager’s container on this Mac reaches the suite at this address (DEPLOY.md, “Order Manager connection”).
        </span>
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        <span style={muted}>Shared secret</span>
        {secret ? (
          <Notice tone="ok">
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <strong>Paste this into the Order Manager now — it is shown only once.</strong>
              <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={code} data-testid="wom-secret">{secret}</code>
                <CopyButton text={secret} label="Copy secret" />
              </div>
              <span style={{ fontSize: 'var(--text-xs)' }}>Leaving this page hides it for good; if it’s lost, make a new one.</span>
            </div>
          </Notice>
        ) : (
          <span data-testid="wom-secret-state">
            {!s.set ? 'None yet: make one, then paste it into the Order Manager.'
              : !s.readable ? 'Made, but this machine can’t read it (its key file is missing): make a new one.'
                : `Made ${formatDateTime(s.setAt)} by ${(actorLabel(s.setBy, me) ?? s.setBy).toLowerCase()}. It can’t be shown again.`}
          </span>
        )}
        {confirming ? (
          <Notice tone="warn">
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <span>A new secret replaces the old one at once: the Order Manager’s events wait (nothing is lost) until you paste the new one there.</span>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <Button variant="primary" onClick={make} disabled={busy || offline}>{busy ? 'Making…' : 'Make a new secret'}</Button>
                <Button onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            </div>
          </Notice>
        ) : (
          <div>
            <Button onClick={() => (s.set ? setConfirming(true) : make())} disabled={busy || offline} variant={s.set ? 'secondary' : 'primary'}>
              {s.set ? 'New secret…' : 'Make the secret'}
            </Button>
          </div>
        )}
        {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
      </div>

      <p style={{ ...muted, margin: 0 }}>
        {data.waiting.customers
          ? <>{data.waiting.customers} customer{data.waiting.customers === 1 ? ' is' : 's are'} waiting for a client: <Link to="/wholesale">link them on the Wholesale page</Link>.</>
          : <>Customers the Order Manager sends: <Link to="/wholesale">Wholesale page</Link>.</>}
      </p>
    </div>
  );
}
