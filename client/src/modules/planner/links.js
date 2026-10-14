// Links a task's notes may carry to a page elsewhere in the suite, shown as a link on the task's row (no React;
// client/test/helpdesk.test.js). D14: the helpdesk's tasks name their ticket ("/helpdesk/tickets/<id>") — no customer
// data is in a task, so the row's "Open the ticket" is how a phone gets from Today to the email.

/** The ticket path in a task's notes, or null. */
export function ticketPathIn(notes) {
  const m = /\/helpdesk\/tickets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(String(notes ?? ''));
  return m ? `/helpdesk/tickets/${m[1]}` : null;
}
