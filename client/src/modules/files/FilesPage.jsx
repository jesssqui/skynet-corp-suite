// A client's Files tab (D10): /crm/clients/:id/files?tab=all|client|<account id>. Everything kept for
// the client — its own files, each account's, and those added to tasks for them — with a tab per
// account. New files go where the tab is (All and the client's tab: the client; an account's tab: that
// account). The list is the device's offline copy; uploading and opening uploads need a connection.
import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Card, Icon } from '../../ui/index.js';
import { useClientFiles } from './data.js';
import { filesOnTab, ownerForTab, tabCounts } from './logic.js';
import { FilesPanel } from './FilesPanel.jsx';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

export default function FilesPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, loading } = useClientFiles(id);
  const asked = params.get('tab') ?? params.get('account') ?? 'all';
  const tab = data?.client && (asked === 'all' || asked === 'client' || data.accountsById.has(asked)) ? asked : 'all';
  const counts = useMemo(() => (data?.client ? tabCounts(data.items, data.accounts) : null), [data]);
  if (!data) return <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>;
  if (!data.client) {
    return (
      <Card>
        <p style={{ margin: 0 }}>This client isn’t on this device (deleted, or not downloaded yet).</p>
        <Link to="/crm">Back to clients</Link>
      </Card>
    );
  }
  const { client, accounts } = data;
  const tabs = [
    { value: 'all', label: `Everything (${counts.all})` },
    { value: 'client', label: `${client.name} (${counts.client})` },
    ...accounts.map((a) => ({ value: a.id, label: `${a.name} (${counts[a.id]})` })),
  ];
  const pickTab = (value) => {
    setParams(value === 'all' ? {} : { tab: value }, { replace: true });
  };
  const items = filesOnTab(data.items, tab);
  const owner = ownerForTab(tab, client.id);
  const ownerName = tab === 'all' || tab === 'client' ? client.name : data.accountsById.get(tab)?.name;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', minWidth: 0 }} data-testid="files-page">
      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <Link to={`/crm/clients/${client.id}`} style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 2, textDecoration: 'none', minHeight: 'var(--tap)', width: 'fit-content' }}>
            <Icon name="back" size={16} /> {client.name}
          </Link>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, overflowWrap: 'anywhere' }}>Files</h1>
          <div className="files-tabs" role="tablist" aria-label="Whose files">
            {tabs.map((t) => (
              <button key={t.value} type="button" role="tab" className="files-tab" aria-selected={t.value === tab} onClick={() => pickTab(t.value)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </Card>
      <Card>
        <p style={{ ...muted, margin: '0 0 var(--space-3)' }}>
          New files are added to <strong>{ownerName}</strong>.{tab === 'all' ? ' Files added to their tasks are listed here too.' : ''}
        </p>
        <FilesPanel
          key={tab}
          owner={owner}
          items={items}
          showWhere={tab === 'all' || accounts.length > 0}
          accountsById={data.accountsById}
          tasksById={data.tasksById}
          testId="files-tab"
          emptyText={tab === 'all' ? 'No files, links or password pointers for this client yet.' : 'Nothing here yet.'}
        />
      </Card>
    </div>
  );
}
