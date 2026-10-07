import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/session.jsx';
import { PageHeader, Card, Button, Badge, Notice, Icon, EmptyState } from '../../ui/index.js';
import AccountTabs from './AccountTabs.jsx';
import { useUnsentWarning } from '../../sync/components.jsx';

function ago(iso) {
  if (!iso) return '—';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

const isPhoneName = (name) => /iPhone|Android phone|phone/i.test(name);

function DeviceRow({ device, current, onChanged, onSignedOutSelf }) {
  const { warning } = useUnsentWarning();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const signedOut = Boolean(device.signedOutAt);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      style={{
        display: 'grid', gap: 'var(--space-2)', padding: 'var(--space-3) 0',
        borderTop: '1px solid var(--border)', opacity: signedOut ? 0.75 : 1,
      }}
    >
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        <span style={{ color: 'var(--text-muted)', paddingTop: 2 }}>
          <Icon name={isPhoneName(device.name) ? 'phone' : 'laptop'} size={22} />
        </span>
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2 }}>
          {editing ? (
            <form
              style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await api.put(`/api/auth/devices/${device.id}`, { name });
                  setEditing(false);
                  onChanged();
                });
              }}
            >
              <input
                aria-label="Device name"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                style={{
                  flex: '1 1 180px', minHeight: 'var(--tap)', padding: '0 var(--space-3)', fontSize: 16,
                  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                }}
              />
              <Button variant="primary" type="submit" disabled={busy || !name.trim()}>Save</Button>
              <Button variant="ghost" onClick={() => { setEditing(false); setName(device.name); }}>Cancel</Button>
            </form>
          ) : (
            <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
              {device.name}
              {current ? <span style={{ marginLeft: 'var(--space-2)' }}><Badge tone="accent">This device</Badge></span> : null}
            </span>
          )}
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {signedOut
              ? `Signed out ${ago(device.signedOutAt)}${device.signedOutBy ? ` by ${device.signedOutBy.displayName}` : ''}`
              : `Last used ${ago(device.lastSeenAt)}${device.lastIp ? ` · ${device.lastIp}` : ''}`}
            {!signedOut && !device.signedIn ? ' · session ended' : ''}
          </span>
        </div>
        {!editing && !signedOut ? (
          <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
            <Button variant="ghost" onClick={() => setEditing(true)} style={{ padding: '0 var(--space-3)' }}>Rename</Button>
          </div>
        ) : null}
      </div>

      {!signedOut && !editing ? (
        <div style={{ paddingLeft: 34, display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          {confirming ? (
            <>
              <span style={{ fontSize: 'var(--text-sm)' }}>
                {current ? `Sign out here and clear this device’s saved data?${warning ? ` ${warning}` : ''}` : 'Sign it out? Its saved data is cleared the next time it connects.'}
              </span>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => run(async () => {
                  if (current) return onSignedOutSelf();
                  await api.post(`/api/auth/devices/${device.id}/sign-out`);
                  setConfirming(false);
                  onChanged();
                })}
              >
                Sign out
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            </>
          ) : (
            <Button onClick={() => setConfirming(true)} style={{ minHeight: 36, fontSize: 'var(--text-sm)' }}>
              <Icon name="logout" size={16} />
              Sign out
            </Button>
          )}
        </div>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </li>
  );
}

export default function DevicesPage() {
  const { session, signOut } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/api/auth/devices'));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // One card per person (you first), signed-in devices first; signed-out ones folded away.
  const people = [];
  if (data) {
    for (const d of data.devices) {
      let p = people.find((x) => x.user.id === d.user.id);
      if (!p) people.push((p = { user: d.user, active: [], signedOut: [] }));
      (d.signedOutAt ? p.signedOut : p.active).push(d);
    }
    people.sort((a, b) => (a.user.id === session.user.id ? -1 : b.user.id === session.user.id ? 1 : a.user.actor.localeCompare(b.user.actor)));
  }

  return (
    <>
      <PageHeader title="Devices" subtitle="Where each of you is signed in. Either of you can sign any device out." actions={<AccountTabs />} />
      {error ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{error}</Notice> : null}
      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', alignItems: 'start' }}>
        {people.map((p) => (
          <Card key={p.user.id} title={p.user.id === session.user.id ? `${p.user.displayName} (you)` : p.user.displayName}>
            {p.active.length ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {p.active.map((d) => (
                  <DeviceRow key={d.id} device={d} current={d.id === data.currentDeviceId} onChanged={load} onSignedOutSelf={signOut} />
                ))}
              </ul>
            ) : (
              <EmptyState title="Not signed in anywhere" />
            )}
            {p.signedOut.length ? (
              <details style={{ marginTop: 'var(--space-3)' }}>
                <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: 'var(--space-3) 0' }}>
                  Signed-out devices ({p.signedOut.length})
                </summary>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {p.signedOut.map((d) => <DeviceRow key={d.id} device={d} current={false} onChanged={load} />)}
                </ul>
              </details>
            ) : null}
          </Card>
        ))}
      </div>
    </>
  );
}
