// Files on a task (D10), inside its sheet: drop or upload files, add links and password pointers. They
// also list on the Files tab of the task's client (or account).
import { useMemo } from 'react';
import { useRecords } from '../../sync/index.js';
import { FilesPanel } from './FilesPanel.jsx';

const h3 = { fontSize: 'var(--text-sm)', fontWeight: 600 };

export function TaskFiles({ task }) {
  const { records } = useRecords('file', { where: { task_id: task.id } }, [task.id]);
  const items = useMemo(() => [...records]
    .sort((a, b) => String(b._sync?.createdAt ?? b.id).localeCompare(String(a._sync?.createdAt ?? a.id)))
    .map((file) => ({ file, where: { on: 'task', taskId: task.id } })), [records, task.id]);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="task-files">
      <span style={h3}>Files{task.client_id ? ' (also on the client’s Files tab)' : ''}</span>
      <FilesPanel owner={{ field: 'task_id', id: task.id }} items={items} testId="task-files-panel" emptyText="No files on this task." />
    </div>
  );
}
