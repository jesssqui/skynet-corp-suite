// The Stockroom card's settings on System → Connections (D16): paste the connection code Stockroom
// shows once (Settings → Connections → Connect the suite, SLR1.…) — the server checks it with
// Stockroom before saving it, and keeps the secret only encrypted; it is never sent back here. Then
// what each read last brought, Pull now, and Forget. Server settings: needs a connection to the suite.
import { useState } from 'react';
import { Button, Notice, TextAreaField } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { useAuth } from '../../auth/session.jsx';
import { actorLabel } from '../crm/logic.js';
import { codeProblem, readText, listsText } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' };

export default function StockroomConnectionPanel({ offline, onChanged }) {
  const { session } = useAuth();
  const me = session?.user?.actor;
  const { data, replace } = useServerData('/api/stockroom/connection', { everyMs: 30_000 });
  const [code, setCode] = useState('');
  const [pasting, setPasting] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  if (!data) return null;
  const showPaste = pasting || !data.connected;
  const typed = codeProblem(code);

  async function act(what, fn) {
    setBusy(what);
    setProblem(null);
    try {
      const next = await fn();
      replace(() => next);
      onChanged?.();
      return true;
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server.' : err.message);
      return false;
    } finally {
      setBusy(null);
    }
  }
  const connect = async () => {
    if (await act('connect', () => api.put('/api/stockroom/connection', { code: code.trim() }))) {
      setCode('');
      setPasting(false);
    }
  };
  const pull = () => act('pull', async () => (await api.post('/api/stockroom/pull', {})).connection);
  const forget = async () => {
    if (await act('forget', () => api.del('/api/stockroom/connection'))) setConfirmForget(false);
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }} data-testid="stockroom-settings">
      {data.connected ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 'var(--text-sm)' }}>
            <span style={mono} data-testid="stockroom-url">{data.hubUrl}</span> · key <span style={mono}>{data.readerKey}</span>
          </span>
          <span style={muted}>
            Connected {formatDateTime(data.setAt)} by {(actorLabel(data.setBy, me) ?? data.setBy).toLowerCase()}. The secret is kept encrypted on the suite’s server and can’t be shown.
          </span>
          {data.revokedAt ? <Notice tone="danger">Disconnected in Stockroom ({formatDateTime(data.revokedAt)}): make a new connection there and paste its code here.</Notice> : null}
          {!data.readable && !data.revokedAt ? <Notice tone="warn">This machine can’t read the secret (its key file is missing): paste the code again.</Notice> : null}
        </div>
      ) : (
        <span style={muted}>Not connected yet.</span>
      )}

      {showPaste ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <TextAreaField
            label="Connection code from Stockroom"
            hint="In Stockroom (as an admin): Settings → Connections → Connect the suite. It is shown there once and starts with SLR1."
            rows={3}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={typed || undefined}
            autoComplete="off"
            spellCheck={false}
            data-testid="stockroom-code"
          />
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={connect} disabled={offline || busy !== null || typed !== null}>
              {busy === 'connect' ? 'Checking with Stockroom…' : 'Connect'}
            </Button>
            {data.connected ? <Button onClick={() => { setPasting(false); setCode(''); }}>Cancel</Button> : null}
          </div>
        </div>
      ) : null}

      {data.connected ? (
        <>
          <div style={{ display: 'grid', gap: 4 }} data-testid="stockroom-reads">
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{listsText(data.lists) || 'Nothing read yet'}</span>
            {data.reads.map((r) => (
              <span key={r.endpoint} style={muted}><strong style={{ fontWeight: 600 }}>{r.label}:</strong> {readText(r, formatDateTime)}</span>
            ))}
            <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>{data.cadence}. Read only: the suite never changes anything in Stockroom.</span>
          </div>
          {confirmForget ? (
            <Notice tone="warn">
              <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
                <span>Forget the connection here? Tasks already made stay. Disconnect it in Stockroom too (Settings → Connections), so the key stops working there.</span>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <Button variant="primary" onClick={forget} disabled={offline || busy !== null}>{busy === 'forget' ? 'Forgetting…' : 'Forget it'}</Button>
                  <Button onClick={() => setConfirmForget(false)}>Cancel</Button>
                </div>
              </div>
            </Notice>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Button onClick={pull} disabled={offline || busy !== null || data.paused || Boolean(data.revokedAt)} data-testid="stockroom-pull">
                {busy === 'pull' ? 'Reading Stockroom…' : 'Pull now'}
              </Button>
              {!showPaste ? <Button onClick={() => setPasting(true)} disabled={offline}>Paste a new code…</Button> : null}
              <Button onClick={() => setConfirmForget(true)} disabled={offline}>Forget…</Button>
            </div>
          )}
        </>
      ) : null}
      {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
    </div>
  );
}
