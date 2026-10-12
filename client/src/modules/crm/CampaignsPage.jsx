// Campaigns (/crm/campaigns, D8c): the ways we reach leads — a main campaign ("Email Outreach") with
// sub-campaigns under it ("In Person Visit"). Add, rename, move, archive and delete them; each shows how
// many leads are in it (a main campaign counts its sub-campaigns' leads) and links to the pipeline
// filtered by it. A lead can be in several. Offline, like the rest of the CRM.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, Button, Badge, EmptyState, Icon, TextField, SelectField, TextAreaField, CheckboxField } from '../../ui/index.js';
import { useCampaignsData } from './data.js';
import { FormSheet, TextButton } from './parts.jsx';
import { useForm, deleter } from './forms.jsx';
import { campaignForm, campaignTree, campaignCounts, campaignOptions } from './campaigns.js';
import CrmTabs from './CrmTabs.jsx';
import './crm.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

export function CampaignForm({ record = null, initial = null, campaigns, hasChildren = false, onClose, onDone, onDeleted }) {
  const f = useForm(campaignForm, record, { entity: 'campaign', onDone, initial });
  const { v, set, problems } = f;
  const mains = campaignOptions(campaigns, { mainOnly: true, keep: record?.parent_id ?? null, excludeId: record?.id ?? null });
  return (
    <FormSheet
      title={record ? 'Edit campaign' : 'New campaign'}
      testId="campaign-form"
      onClose={onClose}
      onSave={f.save}
      busy={f.busy}
      error={f.error}
      dirty={f.dirty}
      onDelete={deleter(f.run, 'campaign', record, onDeleted)}
      deleteWarning="Delete this campaign? Its sub-campaigns are hidden with it, and the leads in it stay as they are, just no longer in it. Archive it instead to keep the history."
    >
      <TextField id="campaign-name" label="Name" value={v.name} onChange={set('name')} error={problems.name} maxLength={200} autoFocus={!record} />
      {hasChildren ? (
        <p style={{ ...muted, margin: 0 }}>This is a main campaign: it has sub-campaigns, so it can’t go under another one.</p>
      ) : (
        <SelectField
          id="campaign-parent"
          label="Under"
          value={v.parent_id}
          onChange={set('parent_id')}
          options={[{ value: '', label: 'Nothing — a main campaign' }, ...mains]}
          hint="Campaigns go two levels deep: a main campaign, and sub-campaigns under it."
        />
      )}
      <TextAreaField id="campaign-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} rows={3} />
      <CheckboxField id="campaign-archived" label="Archived (hide it from pickers; leads keep it)" checked={Boolean(v.archived)} onChange={set('archived')} />
    </FormSheet>
  );
}

function Counts({ n }) {
  if (!n) return null;
  return (
    <span style={muted} data-testid="campaign-counts">
      {n.total} lead{n.total === 1 ? '' : 's'}{n.total ? ` · ${n.open} open · ${n.won} won · ${n.lost} lost` : ''}
    </span>
  );
}

function CampaignRow({ campaign, counts, onEdit, onAddSub, sub = false }) {
  return (
    <li data-campaign-id={campaign.id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', paddingLeft: sub ? 'var(--space-5)' : 0 }}>
      <strong style={{ overflowWrap: 'anywhere', color: campaign.archived ? 'var(--text-muted)' : 'inherit' }}>{campaign.name}</strong>
      {campaign.archived ? <Badge tone="neutral">Archived</Badge> : null}
      <Counts n={counts} />
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Link to={`/crm/pipeline?campaign=${campaign.id}`} className="crm-link-button">Pipeline ›</Link>
        {onAddSub ? <TextButton onClick={onAddSub}><Icon name="plus" size={14} />Sub-campaign</TextButton> : null}
        <TextButton onClick={onEdit}><Icon name="edit" size={14} />Edit</TextButton>
      </span>
    </li>
  );
}

export default function CampaignsPage() {
  const { data, loading } = useCampaignsData();
  const [sheet, setSheet] = useState(null);
  const close = () => setSheet(null);
  const tree = data ? campaignTree(data.campaigns) : [];
  const counts = data ? campaignCounts(data.campaigns, data.leads, data.campaignsByLead) : new Map();
  const noCampaign = data ? data.leads.filter((l) => !data.campaignsByLead.get(l.id)?.size).length : 0;
  return (
    <>
      <CrmTabs />
      <PageHeader
        title="Campaigns"
        subtitle="Group leads by how we reached them · a lead can be in several"
        actions={<Button variant="primary" disabled={!data} onClick={() => setSheet({})}><Icon name="plus" size={18} />New campaign</Button>}
      />
      {!data ? (
        <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>
      ) : !tree.length ? (
        <Card><EmptyState title="No campaigns yet">Add one with New campaign, then put leads in it from the lead’s page.</EmptyState></Card>
      ) : (
        <Card>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-3)' }} data-testid="campaign-list">
            {tree.map((c) => (
              <li key={c.id} style={{ display: 'grid', gap: 'var(--space-2)' }}>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
                  <CampaignRow campaign={c} counts={counts.get(c.id)} onEdit={() => setSheet({ record: c, hasChildren: c.children.length > 0 })} onAddSub={() => setSheet({ initial: { parent_id: c.id } })} />
                  {c.children.map((k) => (
                    <CampaignRow key={k.id} sub campaign={k} counts={counts.get(k.id)} onEdit={() => setSheet({ record: k })} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p style={{ ...muted, margin: 'var(--space-4) 0 0' }}>
            {noCampaign} lead{noCampaign === 1 ? ' is' : 's are'} in no campaign. <Link to="/crm/pipeline?campaign=none">Show them</Link>
          </p>
        </Card>
      )}
      {sheet ? (
        <CampaignForm record={sheet.record ?? null} initial={sheet.initial ?? null} hasChildren={sheet.hasChildren} campaigns={data.campaigns} onClose={close} onDone={close} onDeleted={close} />
      ) : null}
    </>
  );
}
