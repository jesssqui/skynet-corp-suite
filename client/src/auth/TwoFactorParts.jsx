import { useState } from 'react';
import { Button, Notice, TextField, Icon } from '../ui/index.js';
import { Qr } from './Qr.jsx';
import { isInstalled } from './device.js';

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        if (await copy(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        }
      }}
      style={{ minHeight: 36, padding: '0 var(--space-3)', fontSize: 'var(--text-sm)' }}
    >
      <Icon name="copy" size={16} />
      {done ? 'Copied' : label}
    </Button>
  );
}

/** "XXXX XXXX …" so the key can be typed by hand. */
const groupKey = (secret) => secret.match(/.{1,4}/g).join(' ');

const isPhone = () => /iPhone|iPad|Android/.test(navigator.userAgent);

/**
 * Set up an authenticator app: QR code (scan from another screen), an otpauth link (opens
 * Passwords / the authenticator on this phone) and the key to type by hand; then the first code.
 */
export function TotpSetup({ enroll, onSubmit, busy, error, submitLabel = 'Turn on two-factor' }) {
  const [code, setCode] = useState('');
  const onPhone = isPhone() || isInstalled();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code.replace(/\s/g, ''));
      }}
      style={{ display: 'grid', gap: 'var(--space-4)' }}
    >
      <ol style={{ margin: 0, paddingLeft: '1.2em', display: 'grid', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
        <li>
          {onPhone
            ? 'Tap “Open in authenticator app” (Passwords on iPhone, Google Authenticator, 1Password…), or type the key into one.'
            : 'Scan the QR code with your phone (the iPhone camera offers to add it to Passwords), or type the key into an authenticator app.'}
        </li>
        <li>Type the 6-digit code it shows.</li>
      </ol>

      <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'center' }}>
        {onPhone ? null : <Qr text={enroll.otpauthUrl} label="QR code for your authenticator app" />}
        <div style={{ display: 'grid', gap: 'var(--space-3)', minWidth: 0, flex: '1 1 200px' }}>
          <a
            href={enroll.otpauthUrl}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)',
              minHeight: 'var(--tap)', padding: '0 var(--space-4)', borderRadius: 'var(--radius)',
              background: onPhone ? 'var(--accent)' : 'var(--surface)', color: onPhone ? 'var(--on-accent)' : 'var(--text)',
              border: `1px solid ${onPhone ? 'var(--accent)' : 'var(--border)'}`, fontWeight: 550, textDecoration: 'none',
            }}
          >
            <Icon name="key" size={18} />
            Open in authenticator app
          </a>
          <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              Or type the key ({enroll.issuer} · {enroll.account})
            </span>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', letterSpacing: '0.04em', overflowWrap: 'anywhere' }}>
              {groupKey(enroll.secret)}
            </code>
            <div>
              <CopyButton text={enroll.secret} label="Copy key" />
            </div>
          </div>
        </div>
      </div>

      <TextField
        label="Code from the app"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        required
        inputStyle={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.2em', fontSize: 20 }}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button variant="primary" type="submit" disabled={busy || code.replace(/\s/g, '').length !== 6}>
        {busy ? 'Checking…' : submitLabel}
      </Button>
    </form>
  );
}

/** Shows recovery codes once, with copy and save, and waits for "I've saved them". */
export function RecoveryCodes({ codes, onDone, doneLabel = 'Continue' }) {
  const [saved, setSaved] = useState(false);
  const text = `Skynet Corp Suite recovery codes (each works once)\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'suite-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
        If you lose your phone, each of these signs you in once instead of a code. Keep them somewhere safe and
        separate from your phone (a password manager, or printed). They won’t be shown again.
      </p>
      <ol
        style={{
          margin: 0, padding: 'var(--space-3) var(--space-4)', listStyle: 'none', display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 'var(--space-2)',
          background: 'var(--surface-2)', borderRadius: 'var(--radius)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)',
        }}
      >
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ol>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <CopyButton text={text} label="Copy all" />
        <Button onClick={download} style={{ minHeight: 36, padding: '0 var(--space-3)', fontSize: 'var(--text-sm)' }}>
          Save as file
        </Button>
      </div>
      <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontSize: 'var(--text-sm)', minHeight: 'var(--tap)' }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} style={{ width: 20, height: 20 }} />
        I’ve saved these codes
      </label>
      <Button variant="primary" disabled={!saved} onClick={onDone}>{doneLabel}</Button>
    </div>
  );
}
