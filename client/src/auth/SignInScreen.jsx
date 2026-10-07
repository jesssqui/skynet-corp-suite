import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Button, Notice, TextField } from '../ui/index.js';
import { getDeviceId, isInstalled, readSessionCache } from './device.js';
import { countUnsent } from '../sync/localdb.js';
import { useAuth } from './session.jsx';

// Sign-in: password, then a code from the authenticator app (or a recovery code). Two-factor is set
// up on the Mac mini with the account (users.js add), never here. A passkey would add a button here
// that skips both steps.

function Frame({ title, subtitle, children }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 'calc(var(--space-6) + env(safe-area-inset-top)) calc(var(--space-4) + env(safe-area-inset-right)) calc(var(--space-6) + env(safe-area-inset-bottom)) calc(var(--space-4) + env(safe-area-inset-left))',
      }}
    >
      <main style={{ width: '100%', maxWidth: 420, display: 'grid', gap: 'var(--space-5)', marginTop: 'min(8vh, 64px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <img src="/icons/icon.svg" alt="" width={36} height={36} style={{ borderRadius: 9 }} />
          <span style={{ fontWeight: 700, fontSize: 'var(--text-lg)', letterSpacing: '-0.01em' }}>Skynet Corp Suite</span>
        </div>
        <section
          style={{
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow)', padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-4)',
          }}
        >
          <div>
            <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, letterSpacing: '-0.01em' }}>{title}</h1>
            {subtitle ? <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>{subtitle}</p> : null}
          </div>
          {children}
        </section>
      </main>
    </div>
  );
}

/** Changes the last person signed in here never got to send (deleted if someone else signs in). */
function useUnsentOfPrevious() {
  const [state, setState] = useState(null);
  useEffect(() => {
    const previous = readSessionCache();
    if (!previous) return;
    countUnsent().then((n) => n && setState({ user: previous.user, n }), () => {});
  }, []);
  return state;
}

function PasswordStep({ notice, onNext }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const unsent = useUnsentOfPrevious();
  const someoneElse = unsent && username.trim() && username.trim().toLowerCase() !== unsent.user.username;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/api/auth/login', { username, password, deviceId: getDeviceId(), installed: isInstalled() });
      onNext(res, username);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Frame title="Sign in">
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <TextField
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {someoneElse ? (
          <Notice tone="warn">
            {unsent.user.displayName} has {unsent.n} change{unsent.n === 1 ? '' : 's'} on this device that {unsent.n === 1 ? 'hasn’t' : 'haven’t'} been
            sent. Signing in as someone else deletes {unsent.n === 1 ? 'it' : 'them'}; {unsent.user.displayName} can sign in here first to send {unsent.n === 1 ? 'it' : 'them'}.
          </Notice>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button variant="primary" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Checking…' : 'Continue'}
        </Button>
      </form>
    </Frame>
  );
}

function CodeStep({ challenge, onDone, onRestart }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post('/api/auth/login/code', { challenge, code }));
    } catch (err) {
      if (err.code === 'challenge_expired') return onRestart(err.message);
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Frame
      title={recovery ? 'Use a recovery code' : 'Enter your code'}
      subtitle={recovery ? 'One of the codes you saved when you set up two-factor. Each works once.' : 'The 6-digit code from your authenticator app.'}
    >
      <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <TextField
          key={recovery ? 'recovery' : 'totp'}
          label={recovery ? 'Recovery code' : 'Code'}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          required
          {...(recovery
            ? { autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false, autoComplete: 'off', placeholder: 'XXXX-XXXX-XXXX' }
            : { inputMode: 'numeric', autoComplete: 'one-time-code', pattern: '[0-9 ]*', maxLength: 7 })}
          inputStyle={{ fontFamily: 'var(--font-mono)', letterSpacing: recovery ? '0.08em' : '0.2em', fontSize: 20 }}
        />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button variant="primary" type="submit" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Sign in'}</Button>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button variant="ghost" onClick={() => { setRecovery(!recovery); setCode(''); setError(null); }}>
            {recovery ? 'Use the app instead' : 'Use a recovery code'}
          </Button>
          <Button variant="ghost" onClick={() => onRestart(null)}>Start again</Button>
        </div>
      </form>
    </Frame>
  );
}

export default function SignInScreen() {
  const { notice, signedIn } = useAuth();
  const [step, setStep] = useState({ name: 'password' });
  const [restartNotice, setRestartNotice] = useState(null);

  const restart = (message) => {
    setRestartNotice(message ? { tone: 'warn', text: message } : null);
    setStep({ name: 'password' });
  };

  if (step.name === 'code') {
    return <CodeStep challenge={step.start.challenge} onDone={signedIn} onRestart={restart} />;
  }
  return (
    <PasswordStep
      notice={restartNotice ?? notice}
      onNext={(start) => setStep({ name: 'code', start })}
    />
  );
}

/** Loading, can't reach the server, or not signed in: one of those screens instead of the app. */
export function AuthGate({ children }) {
  const { status, error, recheck } = useAuth();
  if (status === 'signed-in') return children;
  if (status === 'signed-out') return <SignInScreen />;
  if (status === 'unreachable') {
    return (
      <Frame title="Can’t reach the suite" subtitle="Check that this device is connected to Tailscale, then try again.">
        {error ? <Notice tone="warn">{error}</Notice> : null}
        <Button variant="primary" onClick={recheck}>Try again</Button>
      </Frame>
    );
  }
  return <div aria-busy="true" style={{ minHeight: '100dvh' }} />;
}
