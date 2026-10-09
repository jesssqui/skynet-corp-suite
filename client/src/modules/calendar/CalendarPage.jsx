// Account → Calendar (C6a): this person's task calendar link for Apple Calendar — make it, replace
// it (the old one stops working at once) or turn it off. The link is shown once, when it is made
// (only its hash is kept on the server), with how to subscribe on the iPhone and the Mac.
// Needs a connection (server settings, not synced).
import { useState } from 'react';
import { PageHeader, Card, Button, Notice, Badge } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import AccountTabs from '../auth/AccountTabs.jsx';
import { feedLinks, linkReachProblem } from './links.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const code = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--text-sm)', background: 'var(--surface-2)',
  padding: '6px 10px', borderRadius: 'var(--radius-sm)', overflowWrap: 'anywhere', userSelect: 'all', minWidth: 0,
};
const stack = { display: 'grid', gap: 'var(--space-3)' };
const row = { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' };
const steps = { margin: 0, paddingLeft: '1.2em', display: 'grid', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' };

function CopyButton({ text, label = 'Copy', testId }) {
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
  return <Button onClick={copy} data-testid={testId}>{copied ? 'Copied' : label}</Button>;
}

function ShownOnce({ links }) {
  return (
    <Notice tone="ok">
      <div style={stack} data-testid="calendar-new-link">
        <strong>Subscribe with this link now — it is shown only once.</strong>
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={muted}>Copy it, then paste it into Add Subscribed Calendar (iPhone) or New Calendar Subscription (Mac)</span>
          <div style={row}>
            <code style={code} data-testid="calendar-url">{links.url}</code>
            <CopyButton text={links.url} label="Copy link" testId="copy-calendar-url" />
          </div>
        </div>
        <span style={{ fontSize: 'var(--text-xs)' }}>
          Anyone with this link can read your dated task titles: keep it to yourself. Leaving this page hides it for good;
          if it’s lost, replace it and subscribe again.
        </span>
      </div>
    </Notice>
  );
}

function HowTo() {
  return (
    <Card title="Subscribe">
      <div style={stack}>
        <div>
          <strong style={{ fontSize: 'var(--text-sm)' }}>iPhone</strong>
          <ol style={steps}>
            <li>Copy the link (above, right after you make it) — on the iPhone itself, or send it to yourself.</li>
            <li>Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → <em>Add Subscribed Calendar</em>
              {' '}(older iOS: Settings → Calendar → Accounts).</li>
            <li>Paste the link as the Server → Next → Save.</li>
            <li>Subscribed calendars aren’t pushed: in Calendar Accounts → Fetch New Data, pick <em>Every 15 minutes</em>.</li>
          </ol>
        </div>
        <div>
          <strong style={{ fontSize: 'var(--text-sm)' }}>Mac</strong>
          <ol style={steps}>
            <li>Calendar → File → <em>New Calendar Subscription…</em> → paste the link → Subscribe.</li>
            <li>Location: <strong>On My Mac</strong>, not iCloud — iCloud’s servers can’t reach your tailnet, so the calendar
              would stay empty. Auto-refresh: every 15 minutes → OK.</li>
          </ol>
        </div>
        <p style={{ ...muted, margin: 0 }}>
          Tailscale must be on for the calendar to update; without it, the calendar keeps what it last read.
        </p>
      </div>
    </Card>
  );
}

function WhatsInIt({ timeZone }) {
  return (
    <Card title="What’s in it">
      <ul style={{ ...steps, listStyle: 'disc' }}>
        <li>Your own tasks and the shared list’s (marked “[Shared]”) that have a due date — from 30 days ago to a year ahead.
          Overdue ones stay on their due date; one overdue by more than 30 days drops out of the calendar (it’s still open in
          the suite).</li>
        <li>A task with a time shows at that time ({timeZone ?? 'local time'}) for its estimate, or 30 minutes; the rest are
          all-day.</li>
        <li>Finished and deleted tasks drop out at the next refresh. It’s read-only: change tasks in the suite (each event
          links back to its task).</li>
        <li data-testid="calendar-privacy">Task titles go as written — including the suite’s own tasks, like “Balance owing over 30 days:
          Lefty’s, $412.50” — and show in Apple Calendar on your phone and Mac (lock screen, notifications). Notes, contacts and
          other details are not sent.</li>
      </ul>
    </Card>
  );
}

export default function CalendarPage() {
  const { data, error, offline, replace } = useServerData('/api/calendar/link');
  const [made, setMade] = useState(null);
  const [confirming, setConfirming] = useState(null); // 'replace' | 'off'
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const origin = data?.publicUrl ?? window.location.origin;
  const reach = data?.publicUrl ? null : linkReachProblem(origin);
  const feed = data?.feed;

  async function act(kind) {
    setBusy(true);
    setProblem(null);
    try {
      if (kind === 'off') {
        const r = await api.del('/api/calendar/link');
        replace((d) => ({ ...d, feed: r.feed }));
        setMade(null);
      } else {
        const r = await api.post('/api/calendar/link', {});
        replace((d) => ({ ...d, feed: r.feed }));
        setMade(feedLinks(r.publicUrl ?? window.location.origin, r.path));
      }
      setConfirming(null);
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server: nothing was changed.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Account" subtitle="Your tasks in Apple Calendar" actions={<AccountTabs />} />
      {offline ? <Notice tone="warn" style={{ marginBottom: 'var(--space-4)' }}>No connection to the suite: the calendar link can’t be changed right now.</Notice> : null}
      {error && !offline && !data ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{error.message}</Notice> : null}
      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', alignItems: 'start' }}>
        <Card title="Task calendar">
          {!data ? <p style={muted}>{offline ? 'Needs a connection.' : 'Loading…'}</p> : (
            <div style={stack}>
              <div style={row} data-testid="calendar-state">
                {feed.on ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
                <span style={muted}>
                  {feed.on
                    ? `Link made ${formatDateTime(feed.createdAt)} · ${feed.lastFetchedAt ? `last read by a calendar ${formatDateTime(feed.lastFetchedAt)}` : 'not read by a calendar yet'}`
                    : 'Make a link, then subscribe to it in Apple Calendar on your iPhone and Mac.'}
                </span>
              </div>
              {feed.paused ? <Notice tone="warn">Calendar links are switched off on System → Connections: calendars keep what they last read until it’s on again.</Notice> : null}
              {reach ? (
                <Notice tone="warn">
                  <span data-testid="calendar-reach">{reach === 'local'
                    ? `This page is open at ${origin}, so a link made here only works on this Mac. To subscribe on the iPhone, open the suite at its Tailscale address (https://…ts.net) and make the link there.`
                    : `This page is open over plain http (${origin}): open the suite at its Tailscale https address and make the link there.`}</span>
                </Notice>
              ) : null}
              {made ? <ShownOnce links={made} /> : null}
              {confirming ? (
                <Notice tone="warn">
                  <div style={stack}>
                    <span>
                      {confirming === 'replace'
                        ? 'A new link replaces this one at once: calendars subscribed to the old link stop updating. Subscribe again with the new one (and remove the old subscription).'
                        : 'Calendars subscribed to this link stop updating at once. You can make a new link later.'}
                    </span>
                    <div style={row}>
                      <Button variant={confirming === 'off' ? 'danger' : 'primary'} onClick={() => act(confirming)} disabled={busy || offline}>
                        {busy ? 'Working…' : confirming === 'replace' ? 'Replace the link' : 'Turn it off'}
                      </Button>
                      <Button onClick={() => setConfirming(null)}>Cancel</Button>
                    </div>
                  </div>
                </Notice>
              ) : (
                <div style={row}>
                  {feed.on ? (
                    <>
                      <Button onClick={() => setConfirming('replace')} disabled={busy || offline}>Replace link…</Button>
                      <Button variant="ghost" onClick={() => setConfirming('off')} disabled={busy || offline}>Turn off…</Button>
                    </>
                  ) : (
                    <Button variant="primary" onClick={() => act('make')} disabled={busy || offline}>{busy ? 'Making…' : 'Make my calendar link'}</Button>
                  )}
                </div>
              )}
              {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
            </div>
          )}
        </Card>
        <HowTo />
        <WhatsInIt timeZone={data?.timeZone} />
      </div>
    </>
  );
}
