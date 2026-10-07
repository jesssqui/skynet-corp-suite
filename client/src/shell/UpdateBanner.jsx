import { useEffect, useState } from 'react';
import { Button } from '../ui/index.js';
import { applyUpdate, getUpdateState, subscribeUpdate } from '../sw/register.js';

/** "A new version is ready": the open app keeps its own version until the person reloads. */
export default function UpdateBanner() {
  const [state, setState] = useState(getUpdateState);
  useEffect(() => subscribeUpdate(setState), []);
  if (!state.updateReady && !state.updated) return null;
  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap',
        background: 'var(--accent-soft)', borderRadius: 'var(--radius)', padding: 'var(--space-2) var(--space-2) var(--space-2) var(--space-4)',
        marginBottom: 'var(--space-4)', fontSize: 'var(--text-sm)', fontWeight: 550,
      }}
    >
      <span>{state.updated ? 'The suite was updated in another window.' : 'A new version of the suite is ready.'}</span>
      <Button variant="primary" onClick={applyUpdate} style={{ minHeight: 36 }}>Reload</Button>
    </div>
  );
}
