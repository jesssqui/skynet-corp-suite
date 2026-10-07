import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/session.jsx';
import { TotpSetup, RecoveryCodes } from '../../auth/TwoFactorParts.jsx';
import { PageHeader, Card, Button, Badge, KeyValue, Notice, TextField, Icon } from '../../ui/index.js';
import AccountTabs from './AccountTabs.jsx';
import { useUnsentWarning } from '../../sync/components.jsx';

const PERSON = { owner: 'Owner', partner: 'Partner' };

function when(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
}

const stack = { display: 'grid', gap: 'var(--space-4)' };

/** Password + a code again, for changes to two-factor. */
function Recheck({ submitLabel, onSubmit, onCancel }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <form
      style={stack}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSubmit({ password, code: code.trim() });
        } catch (err) {
          setError(err.message);
          setBusy(false);
        }
      }}
    >
      <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <TextField
        label="Code from your authenticator app, or a recovery code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoComplete="one-time-code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        required
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Button variant="primary" type="submit" disabled={busy || !password || !code.trim()}>{busy ? 'Checking…' : submitLabel}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function TwoFactorCard({ info, reload }) {
  // idle | codes-recheck | codes-show | reset-recheck | reset-setup | done
  const [mode, setMode] = useState({ name: 'idle' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const left = info.twoFactor.recoveryCodesLeft;

  if (mode.name === 'codes-recheck') {
    return (
      <Card title="New recovery codes">
        <p style={{ marginTop: 0, fontSize: 'var(--text-sm)' }}>Your current codes stop working once the new ones are made.</p>
        <Recheck
          submitLabel="Make new codes"
          onCancel={() => setMode({ name: 'idle' })}
          onSubmit={async (creds) => setMode({ name: 'codes-show', codes: (await api.post('/api/auth/account/recovery-codes', creds)).recoveryCodes })}
        />
      </Card>
    );
  }
  if (mode.name === 'codes-show') {
    return (
      <Card title="New recovery codes">
        <RecoveryCodes codes={mode.codes} doneLabel="Done" onDone={() => { setMode({ name: 'idle' }); reload(); }} />
      </Card>
    );
  }
  if (mode.name === 'reset-recheck') {
    return (
      <Card title="Move to a new authenticator">
        <p style={{ marginTop: 0, fontSize: 'var(--text-sm)' }}>
          For a new phone or a lost one. Your other devices will need to sign in again. A recovery code works here if the old
          phone is gone.
        </p>
        <Recheck
          submitLabel="Continue"
          onCancel={() => setMode({ name: 'idle' })}
          onSubmit={async (creds) => setMode({ name: 'reset-setup', start: await api.post('/api/auth/account/two-factor/reset', creds) })}
        />
      </Card>
    );
  }
  if (mode.name === 'reset-setup') {
    return (
      <Card title="Move to a new authenticator">
        <TotpSetup
          enroll={mode.start.enroll}
          busy={busy}
          error={error}
          submitLabel="Switch to this authenticator"
          onSubmit={async (code) => {
            setBusy(true);
            setError(null);
            try {
              await api.post('/api/auth/account/two-factor/confirm', { challenge: mode.start.challenge, code });
              setMode({ name: 'done' });
              reload();
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        />
        <Button variant="ghost" style={{ marginTop: 'var(--space-2)' }} onClick={() => setMode({ name: 'idle' })}>Cancel</Button>
      </Card>
    );
  }

  return (
    <Card title="Two-factor">
      <div style={stack}>
        {mode.name === 'done' ? <Notice tone="ok">Switched. Codes now come from the new authenticator.</Notice> : null}
        <KeyValue
          rows={[
            ['Authenticator', info.twoFactor.totp ? <Badge key="t" tone="ok">On since {when(info.twoFactor.totp.enrolledAt)}</Badge> : <Badge key="t" tone="warn">Off</Badge>],
            ['Recovery codes', <Badge key="r" tone={left <= 3 ? 'warn' : 'neutral'}>{left} left</Badge>],
          ]}
        />
        {left <= 3 ? <Notice tone="warn">You’re running low on recovery codes. Make new ones and save them.</Notice> : null}
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button onClick={() => setMode({ name: 'codes-recheck' })}>New recovery codes</Button>
          <Button onClick={() => setMode({ name: 'reset-recheck' })}>Move to a new authenticator</Button>
        </div>
      </div>
    </Card>
  );
}

function PasswordCard() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const reset = () => { setCurrent(''); setNext(''); setAgain(''); setError(null); setBusy(false); };
  const mismatch = again && next !== again;

  return (
    <Card title="Password">
      {!open ? (
        <div style={stack}>
          {done ? <Notice tone="ok">Password changed. Your other devices will ask you to sign in again.</Notice> : null}
          <div><Button onClick={() => { setOpen(true); setDone(false); }}>Change password</Button></div>
        </div>
      ) : (
        <form
          style={stack}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api.post('/api/auth/account/password', { currentPassword: current, newPassword: next });
              reset();
              setOpen(false);
              setDone(true);
            } catch (err) {
              setError(err.message);
              setBusy(false);
            }
          }}
        >
          <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          <TextField label="New password" type="password" autoComplete="new-password" hint="At least 12 characters. A few random words work well." value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
          <TextField label="New password again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} error={mismatch ? 'Doesn’t match' : null} required />
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="primary" type="submit" disabled={busy || !current || next.length < 12 || next !== again}>{busy ? 'Saving…' : 'Change password'}</Button>
            <Button variant="ghost" onClick={() => { reset(); setOpen(false); }}>Cancel</Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function SignOutButton() {
  const { signOut } = useAuth();
  const { warning, sendNow } = useUnsentWarning();
  const [confirming, setConfirming] = useState(false);
  if (confirming && warning) {
    return (
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <Notice tone="warn">{warning}</Notice>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button onClick={sendNow}>Try sending them</Button>
          <Button variant="danger" onClick={signOut}>Sign out anyway</Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      </div>
    );
  }
  return (
    <Button variant="danger" onClick={() => (warning ? (sendNow(), setConfirming(true)) : signOut())}>
      <Icon name="logout" size={18} />
      Sign out of this device
    </Button>
  );
}

export default function AccountPage() {
  const { session } = useAuth();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setInfo(await api.get('/api/auth/account'));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader title="Account" subtitle={info ? `Signed in as ${info.user.displayName}` : ' '} actions={<AccountTabs />} />
      {error ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{error}</Notice> : null}
      {info ? (
        <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', alignItems: 'start' }}>
          <Card title="You">
            <KeyValue
              rows={[
                ['Name', info.user.displayName],
                ['Username', info.user.username],
                ['Person', PERSON[info.user.actor] ?? info.user.actor],
                ['This device', info.device.name],
                ['Session ends', `${when(info.session.idleExpiresAt)} if unused`],
              ]}
            />
            <div style={{ marginTop: 'var(--space-4)' }}>
              <SignOutButton />
            </div>
          </Card>
          <TwoFactorCard info={info} reload={load} />
          <PasswordCard />
        </div>
      ) : error && session ? (
        // No connection: the rest needs the server, but signing out of this device must still work.
        <Card title="You" style={{ maxWidth: 480 }}>
          <KeyValue rows={[['Name', session.user.displayName], ['This device', session.device.name]]} />
          <div style={{ marginTop: 'var(--space-4)' }}>
            <SignOutButton />
          </div>
        </Card>
      ) : null}
    </>
  );
}
