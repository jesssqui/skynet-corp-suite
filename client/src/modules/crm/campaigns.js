// Campaigns (D8c), without React: the add/edit form, the pickers, the page's counts, and joining or
// leaving a campaign. Campaigns and a lead's memberships are synced records, so all of it works offline.
import { campaignTree, campaignScope, campaignsByLead, inCampaign, membershipFor, campaignLabel } from '@suite/shared/campaigns';
import { isOpenLead } from '@suite/shared/leads';
import { textOrNull } from './logic.js';

export { campaignTree, campaignScope, campaignsByLead, inCampaign, campaignLabel };

export const campaignForm = {
  defaults: { name: '', parent_id: '', notes: '', archived: false },
  toFields: (v) => {
    const name = textOrNull(v.name);
    return {
      fields: { name, parent_id: v.parent_id || null, notes: textOrNull(v.notes), archived: Boolean(v.archived) },
      problems: name ? {} : { name: 'Give the campaign a name' },
    };
  },
};

/** The live campaigns that can be picked: not archived (unless `keep`). `mainOnly` = top level only. */
export function pickableCampaigns(campaigns, { mainOnly = false, keep = null, excludeId = null } = {}) {
  return campaigns.filter((c) => c.id !== excludeId && (!mainOnly || !c.parent_id) && (!c.archived || c.id === keep));
}

/** Select options in tree order: "Email Outreach", "Email Outreach › In Person Visit" … */
export function campaignOptions(campaigns, opts = {}) {
  const ok = new Set(pickableCampaigns(campaigns, opts).map((c) => c.id));
  const out = [];
  for (const top of campaignTree(campaigns)) {
    if (ok.has(top.id)) out.push({ value: top.id, label: top.name });
    for (const kid of top.children) if (ok.has(kid.id)) out.push({ value: kid.id, label: `${top.name} › ${kid.name}` });
  }
  return out;
}

/** The campaigns a lead is in, as labelled { id, label } in tree order. */
export function leadCampaignList(campaigns, idSet) {
  if (!idSet?.size) return [];
  const out = [];
  for (const top of campaignTree(campaigns)) {
    if (idSet.has(top.id)) out.push({ id: top.id, label: top.name });
    for (const kid of top.children) if (idSet.has(kid.id)) out.push({ id: kid.id, label: `${top.name} › ${kid.name}` });
  }
  return out;
}

/** Per campaign (and a main one counting its sub-campaigns' leads): open, won, lost, and the lead total. */
export function campaignCounts(campaigns, leads, byLead) {
  const out = new Map();
  for (const c of campaigns) {
    const scope = campaignScope(campaigns, c.id);
    const n = { total: 0, open: 0, won: 0, lost: 0 };
    for (const l of leads) {
      if (!inCampaign(byLead.get(l.id), scope)) continue;
      n.total += 1;
      if (isOpenLead(l)) n.open += 1;
      else if (l.stage === 'won') n.won += 1;
      else n.lost += 1;
    }
    out.set(c.id, n);
  }
  return out;
}

/** Add a lead to a campaign (nothing happens when it is already in it). Returns true when it was added. */
export async function joinCampaign(store, memberships, leadId, campaignId) {
  if (membershipFor(memberships, leadId, campaignId).length) return false;
  await store.create('lead_campaign', { lead_id: leadId, campaign_id: campaignId });
  return true;
}

/** Take a lead out of a campaign (every membership record of the pair, in case two devices both added it). */
export async function leaveCampaign(store, memberships, leadId, campaignId) {
  const rows = membershipFor(memberships, leadId, campaignId);
  for (const m of rows) await store.remove('lead_campaign', m.id);
  return rows.length;
}
