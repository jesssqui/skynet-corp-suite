// Automations (C8): each one with what it does, when it runs (in plain English), on/off,
// silent/alert, when it last ran and what it did ("Never run" until it has), the next run and
// Run now (it only creates what is missing). Server settings: the page needs a connection.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { useAuth } from '../../auth/session.jsx';
import { store } from '../../sync/index.js';
import { PageHeader, Card, Badge, Notice, Switch, Button, Segmented, EmptyState, Icon } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { actorLabel } from '../crm/logic.js';
import SystemTabs from '../health/SystemTabs.jsx';
import { useUnreadAlerts } from './AlertsBell.jsx';
import { unreadText } from './alerts.js';
import { runText, runWhat, runWhen, nextRunText } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

function Row({ label, children, testId }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '76px 1fr', gap: 'var(--space-3)', alignItems: 'baseline' }}>
      <span style={{ ...muted, fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 'var(--text-sm)', minWidth: 0, overflowWrap: 'anywhere' }} data-testid={testId}>{children}</span>
    </div>
  );
}

function AutomationCard({ a, me, offline, scheduled, onChange, onRun, busy, result }) {
  const last = a.lastRun;
  return (
    <Card>
      <div data-automation={a.id} style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: '1 1 260px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 650, margin: 0 }}>{a.name}</h2>
              {a.enabled ? null : <Badge>Off</Badge>}
            </div>
            <p style={{ ...muted, margin: 'var(--space-1) 0 0' }}>{a.description}</p>
          </div>
          <Switch
            checked={a.enabled}
            onChange={(on) => onChange(a, { enabled: on })}
            label={a.enabled ? 'On' : 'Off'}
            disabled={offline || busy}
            testId={`enabled-${a.id}`}
          />
        </div>

        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <Row label="When" testId={`when-${a.id}`}>{a.when}</Row>
          <Row label="Last run" testId={`last-run-${a.id}`}>
            {last ? (
              <>
                <span style={{ display: 'block', ...(last.status === 'error' ? { color: 'var(--danger)' } : {}) }}>{runWhat(last)}</span>
                <span style={{ display: 'block', ...muted, fontSize: 'var(--text-xs)' }}>{runWhen(last, me)}</span>
              </>
            ) : <strong>Never run</strong>}
          </Row>
          <Row label="Next run" testId={`next-run-${a.id}`}>{nextRunText(a, { scheduled })}</Row>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <Segmented
            label={`${a.name}: silent or alert`}
            value={a.alert ? 'alert' : 'silent'}
            onChange={(v) => !offline && !busy && onChange(a, { alert: v === 'alert' })}
            options={[
              { value: 'silent', label: 'Silent' },
              { value: 'alert', label: 'Alert', icon: <Icon name="bell" size={14} /> },
            ]}
          />
          <Button variant="primary" onClick={() => onRun(a)} disabled={offline || busy} data-testid={`run-${a.id}`}>
            <Icon name="play" size={16} />
            {busy === 'run' ? 'Running…' : 'Run now'}
          </Button>
        </div>
        {result ? (
          <Notice tone={result.status === 'error' ? 'danger' : result.createdCount ? 'ok' : 'info'}>
            <span data-testid={`result-${a.id}`}>{result.status === 'error' ? `Failed: ${result.error}` : result.summary}</span>
          </Notice>
        ) : null}
        {a.recent.length > 1 ? (
          <details>
            <summary style={{ ...muted, cursor: 'pointer' }}>Earlier runs</summary>
            <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-4)', ...muted }}>
              {a.recent.slice(1).map((r) => <li key={r.id}>{runText(r, me)}</li>)}
            </ul>
          </details>
        ) : null}
        {a.changedBy ? (
          <p style={{ ...muted, fontSize: 'var(--text-xs)', margin: 0 }}>
            Switches last changed by {(actorLabel(a.changedBy, me) ?? '').toLowerCase()} · {formatDateTime(a.changedAt)}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

export default function AutomationsPage() {
  const { session } = useAuth();
  const me = session?.user?.actor;
  const { data, error, loading, offline, reload, replace } = useServerData('/api/automations');
  const [busy, setBusy] = useState({});
  const [results, setResults] = useState({});
  const [problem, setProblem] = useState(null);
  const unread = useUnreadAlerts();

  const put = (automation) => replace((d) => ({ ...d, automations: d.automations.map((x) => (x.id === automation.id ? automation : x)) }));
  const failText = (err) => (err.status === 0 ? 'Can’t reach the suite server: nothing was changed.' : err.message);

  async function onChange(a, patch) {
    setBusy((b) => ({ ...b, [a.id]: 'switch' }));
    setProblem(null);
    try {
      put((await api.put(`/api/automations/${a.id}`, patch)).automation);
    } catch (err) {
      setProblem(failText(err));
    } finally {
      setBusy((b) => ({ ...b, [a.id]: null }));
    }
  }

  async function onRun(a) {
    setBusy((b) => ({ ...b, [a.id]: 'run' }));
    setProblem(null);
    try {
      const { run, automation } = await api.post(`/api/automations/${a.id}/run`, {});
      put(automation);
      setResults((r) => ({ ...r, [a.id]: run }));
      if (run.createdCount) store.syncNow().catch(() => {}); // bring its tasks (and alert) to this device now
    } catch (err) {
      setProblem(failText(err));
    } finally {
      setBusy((b) => ({ ...b, [a.id]: null }));
    }
  }

  return (
    <>
      <SystemTabs />
      <PageHeader
        title="Automations"
        subtitle="The suite notices things and sets up the work: tasks and alerts only, never anything sent out"
        actions={(
          <Link to="/alerts" style={{ alignSelf: 'center', fontSize: 'var(--text-sm)', display: 'inline-flex', gap: 6, alignItems: 'center' }} data-testid="alerts-link">
            <Icon name="bell" size={16} />
            {unread.length ? unreadText(unread.length) : 'Alerts'}
          </Link>
        )}
      />
      {offline ? (
        <Notice tone="warn" style={{ marginBottom: 'var(--space-4)' }}>
          Can’t reach the suite server. Automations run on the server, so this page needs a connection
          {data ? '; what you see is from the last check' : ''}. Their tasks and alerts are on this device as usual.
        </Notice>
      ) : null}
      {data && !data.scheduled ? (
        <Notice tone="info" style={{ marginBottom: 'var(--space-4)' }}>
          The scheduler is off on this server (development), so nothing runs by itself here. Run now works.
        </Notice>
      ) : null}
      {error && !offline ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{error.message}</Notice> : null}
      {problem ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{problem}</Notice> : null}
      {!data && loading ? <EmptyState title="Loading…" /> : null}
      <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="automations">
        {(data?.automations ?? []).map((a) => (
          <AutomationCard
            key={a.id}
            a={a}
            me={me}
            offline={offline}
            scheduled={data.scheduled}
            busy={busy[a.id]}
            result={results[a.id]}
            onChange={onChange}
            onRun={onRun}
          />
        ))}
      </div>
      {data ? (
        <p style={{ ...muted, marginTop: 'var(--space-4)' }}>
          Times are the server’s ({data.timeZone}). Each runs once per period — a restart or a missed night never makes
          it twice — and Run now only adds what is missing. Alert puts a note in Alerts for both of you; silent
          ones just add their tasks.
        </p>
      ) : null}
    </>
  );
}
