// Campaigns (D8c): how leads are grouped by the way we reached them. A main campaign ("Email Outreach")
// can have sub-campaigns ("$595 One Off Website Package", "In Person Visit"); two levels, no deeper.
// A lead can be in several campaigns (a `lead_campaign` record per membership). Pure; used by the
// server (seeds, import) and the devices (screens).

/** Starter campaigns, made at first start with these ids (only when an id has never existed). */
export const CAMPAIGN_SEEDS = Object.freeze([
  { key: 'email_outreach', id: '01a1163c-1b00-7273-aed1-8d4ae71d27b1', name: 'Email Outreach', parent: null, position: 1 },
  { key: 'one_off_595', id: '01a1163c-1b01-7593-b888-119295f1fc9c', name: '$595 One Off Website Package', parent: 'email_outreach', position: 2 },
  { key: 'in_person', id: '01a1163c-1b02-7027-8a57-0f455a626437', name: 'In Person Visit', parent: 'email_outreach', position: 3 },
].map((c) => Object.freeze(c)));

export const CAMPAIGN_IDS = Object.freeze(Object.fromEntries(CAMPAIGN_SEEDS.map((c) => [c.key, c.id])));

const byPosition = (a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || String(a.name).localeCompare(String(b.name)) || (a.id < b.id ? -1 : 1);

/**
 * Live campaigns as a tree: [{ ...campaign, children: [...] }]. A sub-campaign whose parent is missing
 * (deleted) is hidden with it; a "sub-campaign" of a sub-campaign (two devices) is shown at the top
 * level rather than lost.
 */
export function campaignTree(campaigns) {
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const tops = [];
  const kids = new Map();
  for (const c of campaigns) {
    const p = c.parent_id ? byId.get(c.parent_id) : null;
    if (c.parent_id && !p) continue; // under a deleted campaign
    if (p && !p.parent_id) {
      if (!kids.has(p.id)) kids.set(p.id, []);
      kids.get(p.id).push(c);
    } else tops.push(c);
  }
  return tops.sort(byPosition).map((c) => ({ ...c, children: (kids.get(c.id) ?? []).sort(byPosition) }));
}

/** A campaign's id and its sub-campaigns' ids: what a filter on a main campaign includes. */
export function campaignScope(campaigns, id) {
  const ids = new Set([id]);
  for (const c of campaigns) if (c.parent_id === id) ids.add(c.id);
  return ids;
}

/** "Email Outreach › In Person Visit" (a main campaign by itself: its name). */
export function campaignLabel(campaign, campaigns) {
  if (!campaign) return '';
  const p = campaign.parent_id ? campaigns.find((c) => c.id === campaign.parent_id) : null;
  return p ? `${p.name} › ${campaign.name}` : campaign.name;
}

/** Lead id -> Set of campaign ids, from the lead_campaign records (campaigns not in `liveIds` left out). */
export function campaignsByLead(memberships, liveIds) {
  const out = new Map();
  for (const m of memberships) {
    if (liveIds && !liveIds.has(m.campaign_id)) continue;
    if (!out.has(m.lead_id)) out.set(m.lead_id, new Set());
    out.get(m.lead_id).add(m.campaign_id);
  }
  return out;
}

/** True when the lead is in the campaign or (for a main one) any of its sub-campaigns. `none` = in no campaign. */
export function inCampaign(leadCampaignIds, scope) {
  if (scope === 'none') return !leadCampaignIds || leadCampaignIds.size === 0;
  if (!leadCampaignIds) return false;
  for (const id of scope) if (leadCampaignIds.has(id)) return true;
  return false;
}

/** The first membership record (oldest id) of each campaign for a lead, so a double-added one is removed once. */
export function membershipFor(memberships, leadId, campaignId) {
  return memberships.filter((m) => m.lead_id === leadId && m.campaign_id === campaignId).sort((a, b) => (a.id < b.id ? -1 : 1));
}
