// Account → Calendar: "Meetings from Apple Calendar" (C6b). Each person connects their own iCloud
// calendars with their Apple ID and an app-specific password (made at appleid.apple.com); the suite
// checks it with iCloud before saving, keeps it encrypted, never shows it again, and only reads.
// Which calendars count, Read now, Forget. Needs a connection to the suite (server settings).
import { useState } from 'react';
import { Card, Button, Notice, Badge, TextField, CheckboxField } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { connectProblem, appleState, toggledExcluded } from './apple.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const stack = { display: 'grid', gap: 'var(--space-3)' };
const row = { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' };
const steps = { margin: 0, paddingLeft: '1.2em', display: 'grid', gap: 'var(--space-1)', fontSize: 'var(--text-sm)' };

/** After connecting: which calendars to read, chosen before anything is read (review fix). */
function ChooseCalendars({ calendars, busy, offline, onConfirm }) {
  const [off, setOff] = useState(() => new Set());
  return (
    <div style={stack} data-testid="apple-choose">
      <p style={{ ...muted, margin: 0 }}>Connected. Choose which calendars the suite reads — nothing is read until you do.</p>
      {calendars.length ? (
        <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 0 }}>
          <legend style={{ ...muted, fontWeight: 600, marginBottom: 4 }}>Calendars to read</legend>
          {calendars.map((c) => (
            <CheckboxField
              key={c.url}
              id={`choose-${c.url}`}
              label={c.name}
              checked={!off.has(c.url)}
              onChange={(v) => setOff((prev) => {
                const next = new Set(prev);
                if (v) next.delete(c.url);
                else next.add(c.url);
                return next;
              })}
            />
          ))}
        </fieldset>
      ) : <p style={muted}>No calendars with events were found in this iCloud account.</p>}
      <div style={row}>
        <Button variant="primary" disabled={busy || offline} onClick={() => onConfirm([...off].sort())} data-testid="apple-confirm">
          {busy ? 'Reading…' : 'Read these calendars'}
        </Button>
      </div>
    </div>
  );
}

function ConnectForm({ busy, offline, onSubmit, onCancel, appleId: initialId = '' }) {
  const [appleId, setAppleId] = useState(initialId);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState(null);
  const submit = () => {
    const p = connectProblem({ appleId, password });
    setProblem(p);
    if (!p) onSubmit({ appleId: appleId.trim(), password });
  };
  return (
    <div style={stack} data-testid="apple-form">
      <ol style={steps}>
        <li>On <strong>appleid.apple.com</strong> → Sign-In and Security → <em>App-Specific Passwords</em> → +, name it “Suite”.</li>
        <li>Copy the password it shows (four groups of four letters) and paste it below. Your Apple ID’s own password never goes here.</li>
      </ol>
      <TextField label="Apple ID" id="apple-id" type="email" autoComplete="username" value={appleId} onChange={(e) => setAppleId(e.target.value)} />
      <TextField label="App-specific password" id="apple-password" type="password" autoComplete="off" placeholder="abcd-efgh-ijkl-mnop"
        value={password} onChange={(e) => setPassword(e.target.value)} hint="Checked with iCloud before it’s saved; kept encrypted, never shown again." />
      {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
      <div style={row}>
        <Button variant="primary" onClick={submit} disabled={busy || offline} data-testid="apple-connect">{busy ? 'Checking with iCloud…' : 'Connect'}</Button>
        {onCancel ? <Button onClick={onCancel} disabled={busy}>Cancel</Button> : null}
      </div>
    </div>
  );
}

export default function AppleCard() {
  const { data: info, error, offline, replace } = useServerData('/api/calendar/apple');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [editing, setEditing] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const state = appleState(info, formatDateTime);

  async function run(fn) {
    setBusy(true);
    setProblem(null);
    try {
      const r = await fn();
      replace(() => r);
      return true;
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server: nothing was changed.' : err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const connect = async (body) => {
    if (await run(() => api.put('/api/calendar/apple', body))) setEditing(false);
  };

  return (
    <Card title="Meetings from Apple Calendar">
      {!info ? <p style={muted}>{offline ? 'Needs a connection to the suite.' : error ? error.message : 'Loading…'}</p> : (
        <div style={stack} data-testid="apple-card">
          <div style={row} data-testid="apple-state">
            {info.connected ? <Badge tone={state.tone === 'ok' ? 'ok' : state.tone === 'danger' ? 'danger' : 'warn'}>{info.appleId}</Badge> : <Badge>Off</Badge>}
            <span style={state.tone === 'danger' ? { ...muted, color: 'var(--danger)' } : muted}>{state.text}</span>
          </div>
          {offline ? <Notice tone="warn">No connection to the suite: this can’t be changed right now (meetings already on this device still show on Today).</Notice> : null}
          {info.connected && !info.confirmed && !editing && !info.refusedAt ? (
            <ChooseCalendars calendars={info.calendars} busy={busy} offline={offline}
              onConfirm={(excluded) => run(() => api.put('/api/calendar/apple/calendars', { excluded }))} />
          ) : !info.connected || editing || info.refusedAt ? (
            <>
              {!info.connected ? (
                <p style={{ ...muted, margin: 0 }}>
                  Your meetings show on Today and in Plan my day, and count in the day’s load — read-only, every {info.everyMinutes} minutes,
                  from a week back to two months ahead. Each of you connects your own.
                </p>
              ) : null}
              <ConnectForm busy={busy} offline={offline} onSubmit={connect} appleId={info.appleId ?? ''} onCancel={info.connected && !info.refusedAt ? () => setEditing(false) : null} />
            </>
          ) : (
            <>
              {info.calendars.length ? (
                <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 0 }} data-testid="apple-calendars">
                  <legend style={{ ...muted, fontWeight: 600, marginBottom: 4 }}>Calendars to read</legend>
                  {info.calendars.map((c) => (
                    <CheckboxField
                      key={c.url}
                      id={`cal-${c.url}`}
                      label={(
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 5, background: c.color ?? 'var(--border)' }} />
                          {c.name}{c.included ? <span style={{ ...muted, fontWeight: 400 }}> · {c.meetings}</span> : null}
                        </span>
                      )}
                      checked={c.included}
                      onChange={(v) => run(() => api.put('/api/calendar/apple/calendars', { excluded: toggledExcluded(info.calendars, c.url, v) }))}
                    />
                  ))}
                </fieldset>
              ) : <p style={muted}>No calendars with events were found in this iCloud account.</p>}
              {info.unsupported ? (
                <p style={{ ...muted, margin: 0 }}>{info.unsupported} repeating event{info.unsupported === 1 ? ' has a rule' : 's have rules'} the suite can’t read: only the first time shows.</p>
              ) : null}
              {confirmForget ? (
                <Notice tone="warn">
                  <div style={stack}>
                    <span>Forget the Apple ID and password here? Your meetings leave the suite on every device (Apple Calendar is untouched).
                      Also remove the app-specific password at appleid.apple.com.</span>
                    <div style={row}>
                      <Button variant="danger" disabled={busy || offline} onClick={async () => { if (await run(() => api.del('/api/calendar/apple'))) setConfirmForget(false); }}>Forget</Button>
                      <Button onClick={() => setConfirmForget(false)}>Cancel</Button>
                    </div>
                  </div>
                </Notice>
              ) : (
                <div style={row}>
                  <Button onClick={() => run(() => api.post('/api/calendar/apple/pull', {}))} disabled={busy || offline || info.paused} data-testid="apple-pull">{busy ? 'Reading…' : 'Read now'}</Button>
                  <Button onClick={() => setEditing(true)} disabled={busy || offline}>New password…</Button>
                  <Button variant="ghost" onClick={() => setConfirmForget(true)} disabled={busy || offline}>Forget…</Button>
                </div>
              )}
            </>
          )}
          {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }} data-testid="apple-problem">{problem}</p> : null}
          <p style={{ ...muted, margin: 0, fontSize: 'var(--text-xs)' }}>
            Kept in the suite: each meeting’s title, time and calendar — not its notes, place or who’s invited. Today, the plan and
            the load show each of you only your own meetings, but both people’s are on every signed-in device (synced like tasks),
            so the other person could find them there (Offline data). Titles also stay in the suite’s sync history and in its
            backups, even after a meeting is deleted or the connection forgotten. Your tasks never go back into these calendars this way.
          </p>
        </div>
      )}
    </Card>
  );
}
