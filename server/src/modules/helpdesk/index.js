// The helpdesk (D14): each store's support mailbox, read over IMAP (read only), into tickets — the order each is about
// looked up live, saved answers to copy, a task per open ticket on the shared list, the 24-hour flag. Nothing is ever
// sent: replies are written in the person's own mail app. See CLAUDE.md, "Helpdesk (D14)".
import { fileURLToPath } from 'node:url';
import { createHelpdeskService } from './service.js';
import { createHelpdeskRouter } from './routes.js';

export default {
  name: 'helpdesk',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createHelpdeskService,
  createRouter: createHelpdeskRouter,
  // The mailboxes (server, username, encrypted app password, folders) and their change log are server settings about
  // access, like D12's stores: a restore must never bring back a removed mailbox or a replaced password, nor lose one
  // added since. Tickets, messages and what was read are NOT kept: they roll back with the restore and the folders are
  // read again from the restored position (a message already held is never held twice) — and a restore never brings
  // back a customer email that retention had deleted… unless the backup still held it: retention runs again at start.
  keepOnRestore: ['helpdesk_mailboxes', 'helpdesk_changes'],
  start(_ctx, service) {
    service.start();
  },
};
