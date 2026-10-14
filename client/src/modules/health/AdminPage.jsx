import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { PageHeader, Card, Badge, Notice } from '../../ui/index.js';
import { useAuth } from '../../auth/session.jsx';
import { BusinessesCard, ownerLabel } from '../crm/BusinessesPage.jsx';
import SystemTabs from './SystemTabs.jsx';

// Admin (System → Admin): the things that change how the suite runs. Our businesses (add, colour,
// who new tasks go to, archive) are the same card as Clients → Businesses. People: who has an
// account and whether two-factor is on. Accounts are made and changed only in Terminal on the Mac
// mini (the CLI), never from a browser, so this page says how and shows the commands.

const cli = {
  fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', background: 'var(--surface-2)',
  borderRadius: 'var(--radius-sm)', padding: 'var(--space-2) var(--space-3)', overflowX: 'auto', whiteSpace: 'nowrap', margin: 0,
};

function PeopleCard({ me }) {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    api.get('/api/auth/people')
      .then((r) => live && setPeople(r.people))
      .catch((err) => live && setError(err.message));
    return () => { live = false; };
  }, []);
  return (
    <Card title="People who sign in">
      {error ? <Notice tone="warn">Needs a connection to the suite to show who signs in. ({error})</Notice> : null}
      {!people && !error ? <span style={{ color: 'var(--text-muted)' }}>Loading…</span> : null}
      {people ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-3)' }}>
          {people.map((p) => (
            <li key={p.actor} style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)', display: 'grid', gap: 'var(--space-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{p.displayName}{p.actor === me ? ' (you)' : ''}</span>
                <Badge tone="neutral">{ownerLabel(p.actor, me)}</Badge>
                {p.twoFactorOn ? <Badge tone="ok">Two-factor on</Badge> : <Badge tone="danger">No two-factor</Badge>}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Username {p.username}</div>
              <pre style={cli} aria-label={`Commands for ${p.displayName}`}>{`npm run user:password -- ${p.username}\nnpm run user:reset-2fa -- ${p.username}`}</pre>
            </li>
          ))}
        </ul>
      ) : null}
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', margin: 'var(--space-3) 0 0' }}>
        Run these in Terminal on the Mac mini, in the suite’s folder. A password change or a new authenticator signs that person out everywhere.
      </p>
    </Card>
  );
}

export default function AdminPage() {
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  return (
    <>
      <SystemTabs />
      <PageHeader title="Admin" subtitle="Our businesses, and who signs in" />
      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', alignItems: 'start' }}>
        <BusinessesCard />
        <PeopleCard me={me} />
      </div>
    </>
  );
}
