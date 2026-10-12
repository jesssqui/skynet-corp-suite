// A lead's campaigns (D8c) on its page: the ones it is in (✕ takes it out) and a picker to add it to
// another — it can be in several. Each tap is saved at once, offline.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, SelectField } from '../../ui/index.js';
import { store } from '../../sync/index.js';
import { useAction } from './parts.jsx';
import { campaignOptions, leadCampaignList, joinCampaign, leaveCampaign } from './campaigns.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const h2 = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 };

export function CampaignsCard({ lead, campaigns, memberships, inIds }) {
  const { busy, error, run } = useAction();
  const [pick, setPick] = useState('');
  const mine = leadCampaignList(campaigns, inIds);
  const options = campaignOptions(campaigns).filter((o) => !inIds.has(o.value));
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
        <h2 style={h2}>Campaigns</h2>
        <Link to="/crm/campaigns" className="crm-link-button">Manage ›</Link>
      </div>
      {mine.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }} data-testid="lead-campaign-list">
          {mine.map((c) => (
            <li key={c.id} className="crm-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', borderRadius: 999, border: '1px solid var(--border)' }}>
              <span>{c.label}</span>
              <button
                type="button"
                aria-label={`Take out of ${c.label}`}
                disabled={busy}
                onClick={() => run(() => leaveCampaign(store, memberships, lead.id, c.id))}
                style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}
              >✕</button>
            </li>
          ))}
        </ul>
      ) : <p style={{ ...muted, margin: 0 }}>Not in a campaign.</p>}
      {options.length ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <SelectField
            id="lead-add-campaign"
            label="Add to a campaign"
            value={pick}
            disabled={busy}
            onChange={(v) => { setPick(''); if (v) run(() => joinCampaign(store, memberships, lead.id, v)); }}
            options={[{ value: '', label: 'Pick one…' }, ...options]}
          />
        </div>
      ) : null}
      {error ? <p role="alert" style={{ color: 'var(--danger)', margin: 'var(--space-2) 0 0' }}>{error}</p> : null}
    </Card>
  );
}
