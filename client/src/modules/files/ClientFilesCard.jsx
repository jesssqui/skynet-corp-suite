// The client page's Files card (D10): the newest few of everything kept for the client (its own files,
// its accounts', its tasks'), adding to the client, and a link to the Files tab with a tab per account.
// AccountFilesLink is the "Files (N)" line on each account.
import { Link } from 'react-router-dom';
import { Card, Icon } from '../../ui/index.js';
import { useClientFiles } from './data.js';
import { filesOnTab } from './logic.js';
import { FilesPanel } from './FilesPanel.jsx';

const SHOWN = 5;
const h2 = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' };

export function ClientFilesCard({ clientId }) {
  const { data } = useClientFiles(clientId);
  if (!data?.client) return null;
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
        <h2 style={h2}>Files</h2>
        <Link to={`/crm/clients/${clientId}/files`} style={{ fontSize: 'var(--text-sm)', fontWeight: 600, minHeight: 'var(--tap)', display: 'inline-flex', alignItems: 'center', gap: 2 }} data-testid="client-files-link">
          All files ({data.items.length})<Icon name="chevron" size={14} />
        </Link>
      </div>
      <FilesPanel
        owner={{ field: 'client_id', id: clientId }}
        items={data.items}
        showWhere
        accountsById={data.accountsById}
        tasksById={data.tasksById}
        limit={SHOWN}
        moreLink={`/crm/clients/${clientId}/files`}
        testId="client-files"
        emptyText="No files yet: contracts, logos, links to shared folders, where their passwords are kept."
      />
    </Card>
  );
}

/** "Files (N)" under an account: its own files and its tasks', on its tab. */
export function AccountFilesLink({ clientId, accountId }) {
  const { data } = useClientFiles(clientId);
  const n = data?.client ? filesOnTab(data.items, accountId).length : 0;
  return (
    <Link to={`/crm/clients/${clientId}/files?tab=${accountId}`} style={{ fontSize: 'var(--text-sm)', fontWeight: 600, minHeight: 'var(--tap)', display: 'inline-flex', alignItems: 'center', gap: 4, width: 'fit-content' }} data-testid="account-files-link">
      <Icon name="note" size={14} />Files ({n})
    </Link>
  );
}
