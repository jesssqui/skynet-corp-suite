// The eBay card's settings on System → Connections (D13): the keyset (App ID, Cert ID — kept encrypted on the server,
// never shown again —, RuName), Sign in to eBay (eBay's consent page; it sends the browser back to the RuName's accept
// URL — the suite's /ebay/accepted once it has its https ts.net address — or the person pastes the address eBay showed),
// the sign-in's expiry, the zone the shop's days are counted in, Pull now and Forget. Needs a connection to the suite.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Notice, TextField, TextAreaField } from '../../ui/index.js';
import { formatDate, formatDateTime } from '../../ui/format.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { acceptUrlFor, acceptProblem, pastedProblem, stateLine, keysetProblem } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' };

export default function EbayConnectionPanel({ offline, onChanged }) {
  const { data, replace } = useServerData('/api/ebay/connection', { everyMs: 30_000 });
  const [keys, setKeys] = useState({ appId: '', certId: '', ruName: '' });
  const [editKeys, setEditKeys] = useState(false);
  const [pasted, setPasted] = useState('');
  const [started, setStarted] = useState(false);
  const [zone, setZone] = useState(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  if (!data) return null;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const accept = acceptUrlFor(origin);
  const reach = acceptProblem(origin);
  const showKeys = editKeys || !data.set;
  const kp = keysetProblem(keys);
  const pp = pastedProblem(pasted);

  async function act(what, fn, after) {
    setBusy(what);
    setProblem(null);
    try {
      const next = await fn();
      if (next) replace(() => next.connection ?? next);
      after?.();
      onChanged?.();
      return true;
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server.' : err.message);
      return false;
    } finally {
      setBusy(null);
    }
  }
  const saveKeys = () => act('keys', () => api.put('/api/ebay/connection', { appId: keys.appId.trim(), certId: keys.certId.trim(), ruName: keys.ruName.trim() }),
    () => { setKeys({ appId: '', certId: '', ruName: '' }); setEditKeys(false); });
  async function signIn() {
    setBusy('sign-in');
    setProblem(null);
    try {
      const { url } = await api.post('/api/ebay/sign-in', {});
      setStarted(true);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server.' : err.message);
    } finally {
      setBusy(null);
    }
  }
  const finish = () => act('finish', () => api.post('/api/ebay/sign-in/finish', { url: pasted.trim() }), () => { setPasted(''); setStarted(false); });
  const pull = () => act('pull', () => api.post('/api/ebay/pull', {}));
  const saveZone = () => act('zone', () => api.put('/api/ebay/settings', { timeZone: zone }), () => setZone(null));
  const forget = () => act('forget', () => api.del('/api/ebay/connection'), () => setConfirmForget(false));
  const signedIn = ['on', 'not_read', 'failing', 'paused'].includes(data.state) && data.signedInAt;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }} data-testid="ebay-settings" data-state={data.state}>
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }} data-testid="ebay-state">{stateLine(data, formatDate)}</span>
      {data.set ? (
        <span style={muted}>
          App ID <span style={mono}>{data.appId}</span> · RuName <span style={mono}>{data.ruName}</span> · Cert ID kept encrypted on the suite’s server.
          {' '}Scope: orders, read only. Days counted in {data.timeZone}.
        </span>
      ) : null}

      {data.ruNameProblem && !showKeys ? (
        <Notice tone="danger">
          <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="ebay-runame-problem">
            <span>The saved RuName can’t be used to sign in. {data.ruNameProblem} Then save the keyset again: the App ID and Cert ID are needed with it.</span>
            <div><Button onClick={() => setEditKeys(true)} disabled={offline}>Enter the keyset again</Button></div>
          </div>
        </Notice>
      ) : null}

      {showKeys ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="ebay-keyset">
          <span style={muted}>From developer.ebay.com → Application Keys → <strong>Production</strong> keyset, and User Tokens → your RuName. Set the RuName’s accept URL to <span style={mono}>{accept}</span>.</span>
          {reach ? <Notice tone="warn">{reach}</Notice> : null}
          <TextField id="ebay-app" label="App ID (Client ID)" value={keys.appId} onChange={(e) => setKeys({ ...keys, appId: e.target.value })} autoComplete="off" spellCheck={false} />
          <TextField id="ebay-cert" label="Cert ID (Client Secret)" type="password" value={keys.certId} onChange={(e) => setKeys({ ...keys, certId: e.target.value })} autoComplete="off" spellCheck={false} />
          <TextField id="ebay-runame" label="RuName (eBay Redirect URL name)" value={keys.ruName} onChange={(e) => setKeys({ ...keys, ruName: e.target.value })} autoComplete="off" spellCheck={false} />
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={saveKeys} disabled={offline || busy !== null || kp !== null} data-testid="ebay-save-keys">{busy === 'keys' ? 'Saving…' : 'Save the keyset'}</Button>
            {data.set ? <Button onClick={() => setEditKeys(false)}>Cancel</Button> : null}
          </div>
          {kp && (keys.appId || keys.certId || keys.ruName) ? <span style={muted}>{kp}</span> : null}
          {data.set ? <span style={muted}>A new keyset ends the current sign-in.</span> : null}
        </div>
      ) : null}

      {data.set && !showKeys ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant={signedIn ? 'secondary' : 'primary'} onClick={signIn} disabled={offline || busy !== null || data.paused || Boolean(data.ruNameProblem)} data-testid="ebay-sign-in">
              {signedIn ? 'Sign in to eBay again' : 'Sign in to eBay'}
            </Button>
            {signedIn ? <Button onClick={pull} disabled={offline || busy !== null || data.paused} data-testid="ebay-pull">{busy === 'pull' ? 'Reading eBay…' : 'Pull now'}</Button> : null}
          </div>
          <span style={muted}>Sign in as Save Point Shop and agree. eBay then sends the browser to the accept URL; if that page doesn’t open (no https address yet), copy the whole address from the browser and paste it here.</span>
          {started || pasted ? null : <Button onClick={() => setStarted(true)} style={{ justifySelf: 'start' }}>Paste the address eBay showed…</Button>}
          {started || pasted ? (
            <>
              <TextAreaField id="ebay-pasted" label="The address eBay showed after “I agree”" rows={3} value={pasted} onChange={(e) => setPasted(e.target.value)} error={pp || undefined} spellCheck={false} />
              <div><Button variant="primary" onClick={finish} disabled={offline || busy !== null || pp !== null} data-testid="ebay-finish">{busy === 'finish' ? 'Checking with eBay…' : 'Finish the sign-in'}</Button></div>
            </>
          ) : null}
        </div>
      ) : null}

      {data.set && !showKeys ? (
        <>
          {data.lastSuccessAt ? (
            <span style={muted} data-testid="ebay-read">
              Read {formatDateTime(data.lastSuccessAt)}{data.window ? ` · totals ${data.window.from} to ${data.window.to}` : ''}{data.backfill?.doneAt ? ` · back to ${data.backfill.from}` : ''} · {data.waiting} order{data.waiting === 1 ? '' : 's'} to ship.
              {' '}<Link to="/costs/sales/ebay">Sales and months</Link>
            </span>
          ) : null}
          {zone !== null ? (
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end', flexWrap: 'wrap' }}>
              <TextField id="ebay-zone" label="Count days in (time zone)" value={zone} onChange={(e) => setZone(e.target.value)} />
              <Button variant="primary" onClick={saveZone} disabled={offline || busy !== null}>Save</Button>
              <Button onClick={() => setZone(null)}>Cancel</Button>
            </div>
          ) : null}
          {confirmForget ? (
            <Notice tone="warn">
              <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
                <span>Forget eBay here? The keyset and sign-in go; totals and tasks stay. To stop it on eBay too: eBay → Account → Sign in and security → Third-party app access.</span>
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <Button variant="primary" onClick={forget} disabled={offline || busy !== null}>{busy === 'forget' ? 'Forgetting…' : 'Forget it'}</Button>
                  <Button onClick={() => setConfirmForget(false)}>Cancel</Button>
                </div>
              </div>
            </Notice>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Button onClick={() => setZone(data.timeZone)} disabled={offline}>Time zone…</Button>
              <Button onClick={() => setEditKeys(true)} disabled={offline}>New keyset…</Button>
              <Button onClick={() => setConfirmForget(true)} disabled={offline}>Forget…</Button>
            </div>
          )}
        </>
      ) : null}
      {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
    </div>
  );
}
