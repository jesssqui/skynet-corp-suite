// Connections (C8): every connection between the suite and another app or service — last
// success, queue, last error — with an off switch that pauses it (either person may switch;
// the server logs who). These are server settings, not synced records: the page needs a
// connection to the suite, and says so offline.
import { useState } from 'react';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { useAuth } from '../../auth/session.jsx';
import { PageHeader, Card, Badge, Notice, Switch, Button, EmptyState } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { actorLabel } from '../crm/logic.js';
import SystemTabs from '../health/SystemTabs.jsx';

const STATE = {
  on: { tone: 'ok', label: 'On' },
  paused: { tone: 'warn', label: 'Paused' },
  always_on: { tone: 'accent', label: 'Always on' },
  not_connected: { tone: 'neutral', label: 'Not connected yet' },
};

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

function Fact({ label, children, testId }) {
  return (
    <div style={{ display: 'grid', gap: 2, minWidth: 0 }} data-testid={testId}>
      <span style={{ ...muted, fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

/** "3 waiting", "Up to date", the connection's own label for it. */
function queueText(c) {
  if (c.queueLabel) return c.queueLabel;
  if (c.queueSize === null || c.queueSize === undefined) return '—';
  return c.queueSize === 0 ? 'Nothing waiting' : `${c.queueSize} waiting`;
}

function ConnectionCard({ c, me, offline, onSwitch, busy }) {
  const st = STATE[c.state] ?? STATE.on;
  const placeholder = c.state === 'not_connected';
  return (
    <Card style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <div data-connection={c.id} data-state={c.state} style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: '1 1 220px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 650, margin: 0 }}>{c.name}</h2>
              <Badge tone={st.tone}>{st.label}</Badge>
            </div>
            {c.description ? <p style={{ ...muted, margin: 'var(--space-1) 0 0' }}>{c.description}</p> : null}
          </div>
          {c.pausable ? (
            <Switch
              checked={c.state === 'on'}
              onChange={(on) => onSwitch(c, !on)}
              label={c.state === 'on' ? 'On' : 'Off'}
              disabled={offline || busy}
              testId={`switch-${c.id}`}
            />
          ) : null}
        </div>

        {placeholder ? (
          <p style={{ ...muted, margin: 0 }} data-testid={`placeholder-${c.id}`}>Not connected yet · comes with {c.comesWith}</p>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <Fact label="Last success" testId={`last-success-${c.id}`}>{c.lastSuccessAt ? formatDateTime(c.lastSuccessAt) : 'Never'}</Fact>
            <Fact label={c.id === 'backup' ? 'Behind' : 'Queue'} testId={`queue-${c.id}`}>{queueText(c)}</Fact>
            <Fact label="Last error" testId={`last-error-${c.id}`}>
              {c.lastError
                ? <span style={{ color: 'var(--danger)' }}>{c.lastError}{c.lastErrorAt ? ` · ${formatDateTime(c.lastErrorAt)}` : ''}</span>
                : 'None'}
            </Fact>
          </div>
        )}
        {c.detail ? <p style={{ ...muted, margin: 0 }}>{c.detail}</p> : null}
        {c.state === 'always_on' ? <p style={{ ...muted, margin: 0 }} data-testid={`always-on-${c.id}`}>{c.alwaysOnReason}</p> : null}
        {c.state === 'paused' ? (
          <Notice tone="warn">
            Paused{c.changedBy ? ` by ${(actorLabel(c.changedBy, me) ?? '').toLowerCase()}` : ''}{c.changedAt ? ` · ${formatDateTime(c.changedAt)}` : ''}.
            {' '}Nothing goes in or out; what comes up waits here and is sent when it is switched on again.
          </Notice>
        ) : null}
      </div>
    </Card>
  );
}

export default function ConnectionsPage() {
  const { session } = useAuth();
  const me = session?.user?.actor;
  const { data, error, loading, offline, reload, replace } = useServerData('/api/connections');
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);

  async function onSwitch(c, paused) {
    setBusy(c.id);
    setProblem(null);
    try {
      const { connection } = await api.put(`/api/connections/${c.id}`, { paused });
      replace((d) => ({ ...d, connections: d.connections.map((x) => (x.id === connection.id ? connection : x)) }));
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server: the switch wasn’t changed.' : err.message);
    } finally {
      setBusy(null);
    }
  }

  const list = data?.connections ?? [];
  return (
    <>
      <SystemTabs />
      <PageHeader
        title="Connections"
        subtitle="Everything the suite talks to, and how it is doing"
        actions={<Button onClick={reload} disabled={loading}>Check again</Button>}
      />
      {offline ? (
        <Notice tone="warn" style={{ marginBottom: 'var(--space-4)' }}>
          Can’t reach the suite server. Connections are the server’s own settings, so this page needs a connection
          {data ? '; what you see is from the last check' : ''}, and the switches wait until it’s back.
        </Notice>
      ) : null}
      {error && !offline ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{error.message}</Notice> : null}
      {problem ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{problem}</Notice> : null}
      {!data && loading ? <EmptyState title="Loading…" /> : null}
      <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="connections">
        {list.map((c) => <ConnectionCard key={c.id} c={c} me={me} offline={offline} busy={busy === c.id} onSwitch={onSwitch} />)}
      </div>
      {data ? (
        <p style={{ ...muted, marginTop: 'var(--space-4)' }}>
          Switching a connection off pauses it without breaking anything: its work waits and catches up when it’s
          switched on. Either of you can switch; the server keeps who did.
        </p>
      ) : null}
    </>
  );
}
