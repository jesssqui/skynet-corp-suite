// Projects and playbooks (D9): the facts the server and devices share — a playbook's steps (when each
// is due, who does it, what it does), how a run turns them into tasks, renewal dates and skipped offers,
// the monthly cycles of a repeating run (a retainer), the links a step carries (URLs now, D10's files
// later) and the example playbooks offered on the Playbooks page. The record types are registered by the
// server's playbooks module (server/src/modules/playbooks/entities.js). See CLAUDE.md, "Projects and
// playbooks (D9)".
import { addDays } from './planner.js';
import { addMonths, BUSINESS_IDS } from './crm.js';
import { OWNERS, SHARED } from './actors.js';

/** once = one run makes everything (a project, a job, onboarding); monthly = a retainer: the steps again each month. */
export const PLAYBOOK_REPEATS = Object.freeze(['once', 'monthly']);
/** What a step does: a task (the default), or set a renewal date on the client's service (made when missing). */
export const STEP_ACTIONS = Object.freeze(['task', 'renewal']);
export const OFFSET_UNITS = Object.freeze(['days', 'weeks', 'months', 'years']);
/** Who a step's task goes to: whoever runs it, the business's default owner, or a fixed person / the shared list. */
export const STEP_OWNERS = Object.freeze(['runner', 'business', ...OWNERS]);
// `starting` (D9 review): a run is created starting and set active by its LAST write, so a run whose saving
// stopped part-way (the device ran out of space, the app was closed) is seen as unfinished, never as under way.
export const RUN_STATUSES = Object.freeze(['active', 'done', 'stopped', 'starting']);
/** What a step did when the run started (the run's own copy says so). */
export const RUN_STEP_OUTCOMES = Object.freeze(['task', 'skipped', 'renewal']);

export const PLAYBOOK_NAME_MAX = 200;
export const STEP_TITLE_MAX = 300; // a task's title
export const STAGE_MAX = 100;
export const STEP_TEXT_MAX = 5000; // notes, links
export const RUN_NAME_MAX = 300;
/** Steps in one playbook: a run writes one copy and one task each, offline, in one go. */
export const MAX_STEPS = 60;
/** How far a step may be from the start: ten years either way (in its unit). */
export const OFFSET_LIMITS = Object.freeze({ days: 3650, weeks: 520, months: 120, years: 10 });
/** A repeating run's month is made this many days before it starts (so it shows on the Monday plan). */
export const MONTH_LEAD_DAYS = 7;

export const REPEAT_LABELS = Object.freeze({ once: 'Once', monthly: 'Every month' });
export const STEP_OWNER_LABELS = Object.freeze({
  runner: 'Whoever runs it', business: 'The business’s default owner', owner: 'Owner', partner: 'Partner', shared: 'Shared list',
});
export const RUN_STATUS_LABELS = Object.freeze({ active: 'Under way', done: 'Done', stopped: 'Stopped', starting: 'Not finished' });

export const repeatOf = (x) => (x?.repeat === 'monthly' ? 'monthly' : 'once');
export const actionOf = (step) => (step?.action === 'renewal' ? 'renewal' : 'task');
export const unitOf = (step) => (OFFSET_UNITS.includes(step?.offset_unit) ? step.offset_unit : 'days');
export const runStatus = (run) => (RUN_STATUSES.includes(run?.status) ? run.status : 'active');
export const isActiveRun = (run) => Boolean(run) && runStatus(run) === 'active';
/** Under way or not finished saving: what the lists show as open. */
export const isOpenRun = (run) => Boolean(run) && ['active', 'starting'].includes(runStatus(run));

/** Is an offset (whole number) within ten years either way in its unit? */
export function isOffset(offset, unit = 'days') {
  const limit = OFFSET_LIMITS[unit] ?? OFFSET_LIMITS.days;
  return Number.isInteger(offset) && Math.abs(offset) <= limit;
}

/** The day a step falls on: the run's start (or a month's start, for a repeating run) plus its offset, on the calendar. */
export function stepDate(start, step) {
  const raw = Number.isInteger(step?.offset_amount) ? step.offset_amount : 0;
  // Clamped to the unit's limit (review fix): a pair split by two devices' edits can't push a date centuries out.
  const limit = OFFSET_LIMITS[unitOf(step)];
  const n = Math.max(-limit, Math.min(limit, raw));
  switch (unitOf(step)) {
    case 'weeks': return addDays(start, 7 * n);
    case 'months': return addMonths(start, n);
    case 'years': return addMonths(start, 12 * n);
    default: return addDays(start, n);
  }
}

const UNIT_WORDS = { days: ['day', 'days'], weeks: ['week', 'weeks'], months: ['month', 'months'], years: ['year', 'years'] };
/** "On the start day", "3 days after the start", "1 year after the start", "2 days before the start". */
export function offsetText(step, { start = 'the start' } = {}) {
  const n = Number.isInteger(step?.offset_amount) ? step.offset_amount : 0;
  if (n === 0) return `On ${start === 'the start' ? 'the start day' : start}`;
  const [one, many] = UNIT_WORDS[unitOf(step)];
  return `${Math.abs(n)} ${Math.abs(n) === 1 ? one : many} ${n > 0 ? 'after' : 'before'} ${start}`;
}

/**
 * Who a step's task goes to. `override` (the run's "Who does it": owner | partner | shared) wins; else the
 * step's own rule — runner = whoever ran it, business = the business's default owner (or the shared list).
 */
export function stepOwner(step, { runner, business = null, override = null }) {
  if (OWNERS.includes(override)) return override;
  const rule = STEP_OWNERS.includes(step?.owner) ? step.owner : 'runner';
  if (rule === 'runner') return OWNERS.includes(runner) ? runner : SHARED;
  if (rule === 'business') return OWNERS.includes(business?.default_owner) ? business.default_owner : SHARED;
  return rule;
}

/** Does the step only happen while the client lacks a service of ours ("Offer social media")? Both halves set. */
export const hasOfferCondition = (step) => Boolean(step?.only_if_lacks_business && step?.only_if_lacks_kind);

/**
 * Why an offer step is skipped for this account, or null to go ahead (D8's cross-sell rule): the account
 * already has a relationship of that business and kind (any status: an ended one was a "no thanks"), or it
 * is age-restricted and that business has no relationship with it at all (never sell another brand to it).
 * No account picked → skipped too (the condition is about a client).
 * @param {object} step
 * @param {{ account: object|null, relationships: object[], businessName?: (id) => string, kindLabel?: (kind) => string }} ctx
 *        relationships = the account's live relationships (any status), including one this run is about to make
 */
export function offerSkipReason(step, { account, relationships = [], businessName = () => 'that business', kindLabel = (k) => k }) {
  if (!hasOfferCondition(step)) return null;
  if (!account) return 'No client picked, so there is no one to offer it to';
  const biz = step.only_if_lacks_business;
  const mine = relationships.filter((r) => r.account_id === account.id && r.business_id === biz);
  if (mine.some((r) => r.kind === step.only_if_lacks_kind)) {
    return `Already has ${businessName(biz)} · ${kindLabel(step.only_if_lacks_kind)}`;
  }
  if (account.age_restricted && !mine.length) {
    return `Age-restricted: ${businessName(biz)} doesn’t work with them, so it can’t be offered`;
  }
  return null;
}

// ---- links (URLs now, D10's files later) --------------------------------------------------------------

/** A file stored by the suite (D10): "file:<its id>" on a line of a step's links. */
export const FILE_LINK_PREFIX = 'file:';
const URL_RE = /\b(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+)/i;

/**
 * A step's links, one per line: a web address (with an optional label before it: "Brand guide
 * https://…"), a suite file ("file:<id>" — the seam for D10's files: no file code here), or plain words
 * (a note such as "the client's Google Drive folder"). Blank lines dropped.
 * → [{ kind: 'url', href, label } | { kind: 'file', id, label } | { kind: 'text', text }]
 */
export function parseLinks(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toLowerCase().startsWith(FILE_LINK_PREFIX)) {
      const [id, ...rest] = line.slice(FILE_LINK_PREFIX.length).trim().split(/\s+/);
      if (id) {
        out.push({ kind: 'file', id, label: rest.join(' ') || null });
        continue;
      }
    }
    const m = URL_RE.exec(line);
    if (m) {
      const url = m[1].replace(/[),.;]+$/, '');
      const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const label = line.replace(m[1], '').trim().replace(/[\s:–—-]+$/, '').replace(/^[\s:–—-]+/, '');
      out.push({ kind: 'url', href, label: label || null });
      continue;
    }
    out.push({ kind: 'text', text: line });
  }
  return out;
}

/** One link as a line of plain text (for a task's notes). */
export function linkLine(link) {
  if (link.kind === 'url') return link.label ? `${link.label}: ${link.href}` : link.href;
  if (link.kind === 'file') return `File ${link.label ? `“${link.label}” ` : ''}(${FILE_LINK_PREFIX}${link.id})`;
  return link.text;
}

// ---- repeating runs (retainers) ----------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "November 2026" for any day of that month. */
export const monthLabel = (ymd) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
/** The start of a repeating run's month n (0 = the run's start), counted from the start date each time (Jan 31 → Feb 28 → Mar 31). */
export const cycleStart = (start, n) => addMonths(start, n);
/** The key of a month of a run: "2026-11" (its start's month). */
export const cycleKey = (start, n) => cycleStart(start, n).slice(0, 7);

/**
 * The months (n ≥ 1) of a repeating run the suite should have made by `today`: each one from
 * MONTH_LEAD_DAYS before it starts until it is over (the next one starts) — months that went by entirely
 * (the server was off) are not made late — and none starting after the run's end date. Month 0 is made by
 * the device that ran it. → [{ n, start, key, label }], oldest first.
 */
export function dueCycles(run, today) {
  if (!run?.start_date || repeatOf(run) !== 'monthly') return [];
  const out = [];
  const ym = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
  const first = Math.max(1, ym(today) - ym(run.start_date) - 1);
  for (let n = first; n < first + 3; n += 1) {
    const s = cycleStart(run.start_date, n);
    if (run.end_date && s > run.end_date) break;
    if (addDays(s, -MONTH_LEAD_DAYS) > today) break;
    if (cycleStart(run.start_date, n + 1) <= today) continue; // over
    out.push({ n, start: s, key: s.slice(0, 7), label: monthLabel(s) });
  }
  return out;
}

// ---- a step as a task --------------------------------------------------------------------------------

/**
 * A task's fields for one step of a run (the device for the run's first month, the server for a
 * repeating run's later ones). `step` = the run's own copy of the step (run_step); `cycle` = { start,
 * label } for a repeating run's month (its title says which month), else the run's start.
 */
export function stepTaskFields({ step, run, owner, cycle = null, playbookName = null, businessName = null }) {
  const start = cycle?.start ?? run.start_date;
  const title = cycle?.label ? `${step.title} · ${cycle.label}` : step.title;
  const lines = [];
  if (step.notes) lines.push(step.notes);
  if (hasOfferCondition(step)) {
    // As D8's cross-sell tasks: another business's consent never counts.
    const seller = businessName?.(step.only_if_lacks_business) ?? 'the business making the offer';
    lines.push(`Email them about it only if ${seller} has their email consent (see the client page); otherwise call or ask in person.`);
  }
  const links = parseLinks(step.links);
  if (links.length) lines.push(['Files and links:', ...links.map((l) => `- ${linkLine(l)}`)].join('\n'));
  lines.push(`From the playbook “${playbookName ?? run.playbook_name ?? run.name}”: ${run.name}.`);
  return {
    title: title.slice(0, STEP_TITLE_MAX),
    notes: lines.join('\n\n'),
    owner,
    business_id: run.business_id,
    client_id: run.client_id ?? null,
    account_id: run.account_id ?? null,
    relationship_id: run.relationship_id ?? null,
    due_date: stepDate(start, step),
    estimate_minutes: Number.isInteger(step.estimate_minutes) && step.estimate_minutes > 0 ? step.estimate_minutes : null,
    run_id: run.id,
    run_step_id: step.id,
  };
}

/** A step's fields as the run copies them (everything that describes the step; not its playbook or position). */
export const STEP_COPY_FIELDS = Object.freeze([
  'position', 'title', 'stage', 'action', 'offset_amount', 'offset_unit', 'owner', 'estimate_minutes', 'notes', 'links',
  'service_name', 'service_period', 'service_amount_cents', 'only_if_lacks_business', 'only_if_lacks_kind',
]);

/** Steps in their order (position, then id). */
export const byPosition = (a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || (a.id < b.id ? -1 : 1);

/** The stages of a list of steps, in the order they first appear (steps with none: ''). */
export function stagesOf(steps) {
  const out = [];
  for (const s of [...steps].sort(byPosition)) {
    const st = s.stage ?? '';
    if (!out.includes(st)) out.push(st);
  }
  return out;
}

// ---- examples ------------------------------------------------------------------------------------------

const step = (title, more = {}) => ({ title, ...more });
/**
 * The examples offered on the Playbooks page ("Start from an example"): copied into a new playbook the
 * person can change. Nothing is seeded on the server. Offsets are from the run's start day.
 */
export const EXAMPLE_PLAYBOOKS = Object.freeze([
  {
    key: 'website_launch',
    name: 'Website launch',
    business_id: BUSINESS_IDS.agency,
    kind: 'website',
    repeat: 'once',
    for_client: true,
    description: 'Run it on the day the site goes live. It sets the hosting and domain renewal dates a year out, '
      + 'books the follow-up, and offers social media when they don’t have it yet.',
    steps: [
      step('Final checks: forms, links, speed and phone layout', { stage: 'Launch', estimate_minutes: 60 }),
      step('Point the domain and go live', { stage: 'Launch', estimate_minutes: 30 }),
      step('Send the client their logins and a how-to', { stage: 'Launch', offset_amount: 1, estimate_minutes: 30 }),
      step('Hosting', { stage: 'Renewals', action: 'renewal', offset_amount: 1, offset_unit: 'years', service_name: 'Hosting', service_period: 'yearly' }),
      step('Domain', { stage: 'Renewals', action: 'renewal', offset_amount: 1, offset_unit: 'years', service_name: 'Domain', service_period: 'yearly' }),
      step('Follow up: how is the new site working for them?', { stage: 'After launch', offset_amount: 2, offset_unit: 'weeks', estimate_minutes: 15 }),
      step('Ask for a review', { stage: 'After launch', offset_amount: 3, offset_unit: 'weeks', estimate_minutes: 10 }),
      step('Offer social media', {
        stage: 'After launch', offset_amount: 30, estimate_minutes: 15, only_if_lacks_business: BUSINESS_IDS.agency, only_if_lacks_kind: 'social',
        notes: 'They have a new site: a social media retainer keeps it busy.',
      }),
    ],
  },
  {
    key: 'content_retainer',
    name: 'Monthly content retainer',
    business_id: BUSINESS_IDS.agency,
    kind: 'social',
    repeat: 'monthly',
    for_client: true,
    description: 'Every month from the start day: plan, content due for approval, schedule, report.',
    steps: [
      step('Plan this month’s posts', { stage: 'Plan', estimate_minutes: 60 }),
      step('Content due to the client for approval', { stage: 'Create', offset_amount: 7, estimate_minutes: 180 }),
      step('Schedule the approved posts', { stage: 'Publish', offset_amount: 10, estimate_minutes: 45 }),
      step('Send the month’s report', { stage: 'Report', offset_amount: 25, estimate_minutes: 30 }),
    ],
  },
  {
    key: 'packing',
    name: 'Packing a wholesale order',
    business_id: BUSINESS_IDS.wholesale,
    kind: null,
    repeat: 'once',
    for_client: false,
    description: 'Everything on the shared list, so either of you can pack it.',
    steps: [
      step('Pick the products', { stage: 'Packing', owner: SHARED, estimate_minutes: 15 }),
      step('Pack and weigh the box', { stage: 'Packing', owner: SHARED, estimate_minutes: 10 }),
      step('Print the label and book the pickup', { stage: 'Shipping', owner: SHARED, estimate_minutes: 10 }),
      step('Send the tracking number to the customer', { stage: 'Shipping', owner: SHARED, estimate_minutes: 5 }),
    ],
  },
  {
    key: 'onboarding',
    name: 'New client onboarding',
    business_id: BUSINESS_IDS.agency,
    kind: null,
    repeat: 'once',
    for_client: true,
    description: 'The checklist for a new client: welcome, kick-off, their files.',
    steps: [
      step('Send the welcome email and the questionnaire', { stage: 'Welcome', estimate_minutes: 15 }),
      step('Make their folder and save the signed agreement', { stage: 'Welcome', estimate_minutes: 10 }),
      step('Kick-off call', { stage: 'Kick-off', offset_amount: 3, estimate_minutes: 60 }),
      step('Send the notes and next steps from the call', { stage: 'Kick-off', offset_amount: 4, estimate_minutes: 20 }),
    ],
  },
]);
