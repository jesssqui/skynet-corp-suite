// Importing leads from a research / outreach export (D8b): one CSV row -> one lead in the pipeline,
// with its outreach history on the lead's own timeline and, when the export dates a next step, a
// task. Pure (no database, no clock of its own): the server's crm module (leadImport.js) matches the
// rows against what is already here and writes them; tests run in shared/test/leadImport.test.js.
//
// Written for Great White North Design's research export (schema_version 1.0: lead_id, company_name,
// contact_email, business_phone, pipeline_stage, first_contacted_on, next_action_on, do_not_email …)
// but it reads columns by name, so a file with only some of them works too (company_name is the one
// it needs). Nothing is guessed: what a field can't hold goes into the lead's notes, never dropped.
//
// Decisions (see CLAUDE.md, "Importing leads (D8b)"):
//  - every row is a lead for Great White North Design (`agency`), kind website, source scraped;
//  - the stage is `lead` — also for rows already emailed: an email with no reply isn't a conversation
//    ("talking" is set by hand when someone answers); the emailing is kept as an `email` entry on the
//    lead's timeline, dated from the file;
//  - rows the export excluded (outreach_bucket / do_not_email "excluded") come in as LOST — not a fit —
//    so the pipeline remembers them and a later import never offers them again;
//  - the lead has no consent record (consent belongs to a contact, and a prospect has none): the notes
//    say consent isn't cleared (CASL) and repeat the export's do-not-email flags;
//  - a task is made only when the file gives a next-step DATE; the rest show as "No next step" like any
//    open lead (C4a's rule), which is the suite telling the truth.
import { normalizeEmail, isEmail, normalizePhone, isPhone } from './normalize.js';
import { nameKey } from './intake.js';
import { BUSINESS_IDS } from './crm.js';
import { TASK_TITLE_MAX } from './planner.js';

export const LEAD_IMPORT_LIMITS = Object.freeze({ maxChars: 5 * 1024 * 1024, maxRows: 2_000 });

const NOTES_MAX = 20_000; // the lead's notes field
const LOST_NOTE_MAX = 500;
const NAME_MAX = 200;
const LEAD_STAGE = 'lead';

/** Headers are matched without case, spaces, byte-order marks or punctuation: "Company Name" = company_name. */
const headerKey = (h) => String(h ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** The columns this import reads (all optional but company_name). */
export const LEAD_IMPORT_COLUMNS = Object.freeze([
  'company_name', 'lead_id', 'industry', 'city', 'province', 'business_phone', 'website_url', 'social_url', 'website_status',
  'google_maps_status', 'google_maps_url', 'google_rating', 'google_review_count', 'source_url', 'qualification_notes', 'contact_email',
  'email_consent_status', 'estimated_value', 'currency', 'priority', 'pipeline_stage', 'opportunity_status', 'offer_code',
  'first_contacted_on', 'last_contacted_on', 'next_action_on', 'next_action', 'reply_status', 'last_outreach_subject',
  'subject_verified', 'sales_angle', 'email_outreach_eligibility', 'outreach_bucket', 'contact_history', 'do_not_email',
  'suppressed_email', 'research_status', 'research_last_reviewed', 'import_notes',
]);

/**
 * A table from readTable ({ headers, rows }) -> [{ rowNumber, cells }] with `cells` keyed by the
 * normalised header. rowNumber is the row in the file as a spreadsheet numbers it (the header is row 1).
 * @throws {Error} code 'no_name_column' when there is no company_name column
 */
export function leadRowsFromTable(table) {
  const keys = table.headers.map(headerKey);
  if (!keys.includes('company_name')) {
    const err = new Error('The file needs a "company_name" column (the business’s name).');
    err.code = 'no_name_column';
    throw err;
  }
  const known = new Set(LEAD_IMPORT_COLUMNS);
  return table.rows.map((cells, i) => {
    const row = {};
    keys.forEach((k, c) => { if (known.has(k) && !(k in row)) row[k] = String(cells[c] ?? '').trim(); });
    return { rowNumber: i + 2, cells: row };
  });
}

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const get = (c, k) => (c[k] ?? '').trim();
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** "2026-10-11" -> that day at noon in the server's local zone, as the suite's UTC time text (a day-only fact, so noon keeps the day right). */
export function dayToIso(day) {
  if (!isDay(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0).toISOString();
}

/** "review_inbox_then_qualify_follow_up" -> "Review inbox then qualify follow up". */
export function humanize(code) {
  const s = String(code ?? '').trim().replace(/[_\s]+/g, ' ').toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

const isExcluded = (c) => /exclud/i.test(get(c, 'outreach_bucket')) || /exclud/i.test(get(c, 'do_not_email'));

/**
 * One row's meaning. `cells` from leadRowsFromTable. Returns
 * { sourceId, name, fields (the lead, without owner), activities, task, warnings, problems, label }:
 *  - `fields`: what `lead` create takes (business, kind, stage, value …); owner and times are the importer's;
 *  - `activities`: [{ type, body, at (ISO | null = the moment of import), stage_from?, stage_to? }];
 *  - `task`: null or { title, notes, due_date };
 *  - `problems` (no name) stop the row; `warnings` are things put into the notes instead.
 */
export function cleanLeadRow(cells, { fileName = null, rowNumber = null } = {}) {
  const c = cells ?? {};
  const problems = [];
  const warnings = [];
  const name = clip(get(c, 'company_name'), NAME_MAX);
  if (!name) problems.push('No business name');

  // ---- contact details: stored clean, or kept in the notes as typed -------------------------------
  const extra = []; // lines for the notes about values that couldn't be stored
  let email = normalizeEmail(get(c, 'contact_email'));
  const suppressed = normalizeEmail(get(c, 'suppressed_email'));
  if (email && !isEmail(email)) {
    warnings.push('The email isn’t a valid address');
    extra.push(`Email as given: ${get(c, 'contact_email')}`);
    email = null;
  } else if (email && suppressed && email === suppressed) {
    extra.push(`Email bounced — not kept as the contact address: ${email}`);
    email = null;
  } else if (!email && suppressed) {
    extra.push(`Email bounced — not kept as the contact address: ${suppressed}`);
  }
  let phone = normalizePhone(get(c, 'business_phone'));
  if (phone && !isPhone(phone)) {
    warnings.push('The phone number can’t be stored in the suite’s form');
    extra.push(`Phone as given: ${get(c, 'business_phone')}`);
    phone = null;
  }

  // ---- value ----------------------------------------------------------------------------------------
  let valueCents = null;
  const money = get(c, 'estimated_value');
  if (money) {
    const n = Number(money.replace(/[$,\s]/g, ''));
    if (Number.isFinite(n) && n >= 0 && n < 10_000_000) valueCents = Math.round(n * 100);
    else warnings.push('The estimated value isn’t a number');
  }
  const cur = get(c, 'currency').toUpperCase();
  const currency = /^[A-Z]{3}$/.test(cur) && cur !== 'CAD' ? cur : null;

  // ---- stage ----------------------------------------------------------------------------------------
  const excluded = isExcluded(c);
  const firstDay = isDay(get(c, 'first_contacted_on')) ? get(c, 'first_contacted_on') : null;
  const lastDay = isDay(get(c, 'last_contacted_on')) ? get(c, 'last_contacted_on') : null;
  const contacted = Boolean(firstDay || lastDay) && get(c, 'reply_status') !== 'not_contacted';
  const reason = get(c, 'import_notes') || get(c, 'contact_history');

  const fields = {
    name,
    source: 'scraped',
    business_id: BUSINESS_IDS.agency,
    kind: 'website',
    stage: excluded ? 'lost' : LEAD_STAGE,
  };
  if (email) fields.email = email;
  if (phone) fields.phone = phone;
  if (valueCents !== null) {
    fields.value_cents = valueCents;
    fields.value_period = 'once';
    if (currency) fields.currency = currency;
  }
  if (excluded) {
    fields.lost_reason = 'not_a_fit';
    fields.lost_note = clip(`Excluded in the research export${reason ? `: ${reason}` : ''}`, LOST_NOTE_MAX);
  }
  const stageDay = lastDay ?? firstDay;
  if (stageDay && !excluded) fields.stage_changed_at = dayToIso(stageDay);

  // ---- the notes: what the research found, and where the outreach stands ---------------------------
  const lines = [];
  lines.push(`Imported from ${fileName ? `“${fileName}”` : 'a research export'}${rowNumber ? ` (row ${rowNumber})` : ''}.`);
  const where = [get(c, 'city'), get(c, 'province')].filter(Boolean).join(', ');
  const about = [get(c, 'industry'), where].filter(Boolean).join(' · ');
  if (about) lines.push(about);
  const web = [];
  if (get(c, 'website_url')) web.push(`Website: ${get(c, 'website_url')}`);
  if (get(c, 'social_url')) web.push(`Social: ${get(c, 'social_url')}`);
  if (get(c, 'website_status')) web.push(`Website status: ${get(c, 'website_status').replace(/_/g, ' ')}`);
  if (web.length) lines.push(web.join(' · '));
  const maps = [];
  if (get(c, 'google_maps_url')) maps.push(`Google Maps: ${get(c, 'google_maps_url')}`);
  if (get(c, 'google_rating')) maps.push(`rating ${get(c, 'google_rating')}${get(c, 'google_review_count') ? ` (${get(c, 'google_review_count')} reviews)` : ''}`);
  else if (get(c, 'google_maps_status')) maps.push(`Google Maps: ${get(c, 'google_maps_status').replace(/_/g, ' ')}`);
  if (maps.length) lines.push(maps.join(' · '));
  if (get(c, 'sales_angle')) lines.push(`Angle: ${get(c, 'sales_angle')}`);
  if (get(c, 'qualification_notes')) lines.push(`Research: ${get(c, 'qualification_notes')}`);
  if (get(c, 'source_url')) lines.push(`Source: ${get(c, 'source_url')}`);
  if (get(c, 'offer_code')) lines.push(`Offer: ${get(c, 'offer_code')}`);
  if (get(c, 'priority')) lines.push(`Priority in the export: ${get(c, 'priority').toLowerCase()}`);
  // Consent: a lead has no consent record, so say where it stands rather than leave it unsaid.
  const consent = get(c, 'email_consent_status');
  lines.push(`Email consent (CASL): not cleared${consent && consent !== 'not_recorded' ? ` — export says “${consent.replace(/_/g, ' ')}”` : ''}. Get it, or use another channel, before sending marketing email.`);
  const flags = [get(c, 'do_not_email'), get(c, 'email_outreach_eligibility')].filter(Boolean);
  if (get(c, 'do_not_email')) lines.push(`Do not email (from the export): ${get(c, 'do_not_email').replace(/^YES\s*-\s*/i, '')}`);
  else if (flags.length) lines.push(`Email eligibility (from the export): ${get(c, 'email_outreach_eligibility')}`);
  if (get(c, 'research_status')) lines.push(`Research status: ${get(c, 'research_status').replace(/_/g, ' ')}${get(c, 'research_last_reviewed') ? ` (reviewed ${get(c, 'research_last_reviewed')})` : ''}`);
  if (get(c, 'import_notes')) lines.push(`Export note: ${get(c, 'import_notes')}`);
  lines.push(...extra);
  fields.notes = clip(lines.join('\n'), NOTES_MAX);

  // ---- the lead's timeline ---------------------------------------------------------------------------
  const activities = [];
  if (contacted) {
    const subject = get(c, 'last_outreach_subject');
    const verified = get(c, 'subject_verified').toLowerCase() === 'true';
    const parts = [`Intro email sent${firstDay ? ` on ${firstDay}` : ''}.`];
    if (subject) parts.push(`Subject: “${subject}”${verified ? '' : ' (taken from the research export, not checked against the sent email)'}.`);
    else parts.push('(Date taken from the research export, not checked against the sent email.)');
    if (get(c, 'reply_status') && get(c, 'reply_status') !== 'none') parts.push(`Reply status: ${get(c, 'reply_status').replace(/_/g, ' ')}.`);
    activities.push({ type: 'email', body: parts.join(' '), at: dayToIso(firstDay ?? lastDay) });
  }
  if (excluded) {
    activities.push({ type: 'stage', stage_from: LEAD_STAGE, stage_to: 'lost', body: fields.lost_note, at: null });
  }

  // ---- the next step (only when the file dates one) -------------------------------------------------
  let task = null;
  const due = get(c, 'next_action_on');
  if (!excluded && due) {
    if (isDay(due)) {
      const what = humanize(get(c, 'next_action')) || 'Follow up';
      task = {
        title: clip(`Follow up: ${name}`, TASK_TITLE_MAX),
        notes: `${what} — from the research export${get(c, 'reply_status') ? ` (reply status: ${get(c, 'reply_status').replace(/_/g, ' ')})` : ''}.`,
        due_date: due,
      };
    } else {
      warnings.push('The next-step date isn’t a date (YYYY-MM-DD): no task made');
    }
  }

  return {
    sourceId: get(c, 'lead_id') || null,
    name,
    nameKey: name ? nameKey(name) : '',
    email,
    phone,
    fields,
    activities,
    task,
    warnings,
    problems,
  };
}
