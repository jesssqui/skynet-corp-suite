// The helpdesk's synced record type (D14): a saved answer — text the person copies into their mail app (a Copy button,
// or a mailto: link with the body). Registered with the sync module at start-up; devices learn it from
// GET /api/sync/info, so saved answers work offline. No customer data: what we write, not what they wrote.
//
// `mailbox_id` names the support mailbox (store) it is for — an id with no sync ref: mailboxes are server settings, not
// synced records. null = every mailbox. New fields are nullable and never renamed (CLAUDE.md, rule 5).
export const SAVED_ANSWER_ENTITY = {
  entity: 'saved_answer',
  table: 'helpdesk_saved_answers',
  ops: ['create', 'update', 'delete'],
  fields: {
    title: { type: 'text', max: 200, required: true },
    body: { type: 'text', max: 5000, required: true },
    mailbox_id: { type: 'id' },
    position: { type: 'integer' },
  },
};
