// The helpdesk (D14), signed in (/api/helpdesk; writes follow the JSON/Origin rules every /api write follows). Nothing
// here can change a mailbox or send an email: every call to a mail server is a read (imap.js). Every answer is no-store
// (customer emails), and no route puts a customer's name, email or words in its address — ids only.
//   GET    /mailboxes                       the mailboxes (never a password)
//   POST   /mailboxes { name?, host, username, password, inboxFolder?, sentFolder?, address?, storeId?, businessId?, ignoreFrom? }
//                                           checked with a real login (both folders opened), then saved
//   GET    /mailboxes/:id
//   PUT    /mailboxes/:id { name?, inboxFolder?, sentFolder?, address?, storeId?, businessId?, ignoreFrom? }
//   PUT    /mailboxes/:id/password { username?, password }   checked first
//   DELETE /mailboxes/:id                   forget it here, with its tickets (revoke the app password too)
//   POST   /mailboxes/:id/pull              read it now (409 when paused)
//   GET    /tickets?mailbox=&state=waiting|answered|closed|all&limit=&offset=
//   GET    /tickets/:id                     the ticket and its messages (plain text)
//   POST   /tickets/:id/close | /reopen
//   POST   /tickets/:id/order               its order, looked up live in the store — never stored; the route answers
//                                           every error itself and logs nothing about the customer (like D12's lookup)
import { Router } from 'express';

export function createHelpdeskRouter(ctx, service) {
  const log = ctx?.log;
  const router = Router();
  const who = (req) => ({ actor: req.auth.user.actor, deviceId: req.auth.device?.id ?? null });
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/mailboxes', (_req, res) => res.json({ mailboxes: service.listMailboxes() }));
  router.post('/mailboxes', async (req, res) => {
    const b = req.body ?? {};
    const mailbox = await service.addMailbox({
      name: b.name, host: b.host, port: b.port, username: b.username, password: b.password, inboxFolder: b.inboxFolder, sentFolder: b.sentFolder,
      address: b.address || undefined, storeId: b.storeId, businessId: b.businessId || undefined, ignoreFrom: b.ignoreFrom,
    }, who(req));
    res.status(201).json({ mailbox });
  });
  router.get('/mailboxes/:id', (req, res) => res.json({ mailbox: service.mailbox(req.params.id) }));
  router.put('/mailboxes/:id', async (req, res) => {
    const b = req.body ?? {};
    const pick = ['name', 'inboxFolder', 'sentFolder', 'address', 'storeId', 'businessId', 'ignoreFrom'];
    res.json({ mailbox: await service.updateMailbox(req.params.id, Object.fromEntries(pick.filter((k) => b[k] !== undefined).map((k) => [k, b[k]])), who(req)) });
  });
  router.put('/mailboxes/:id/password', async (req, res) => {
    const { username, password } = req.body ?? {};
    res.json({ mailbox: await service.replacePassword(req.params.id, { username, password }, who(req)) });
  });
  router.delete('/mailboxes/:id', (req, res) => res.json(service.removeMailbox(req.params.id, who(req))));
  router.post('/mailboxes/:id/pull', async (req, res) => res.json(await service.pullNow(req.params.id)));

  router.get('/tickets', (req, res) => {
    const { mailbox = null, state = 'waiting', limit, offset } = req.query;
    res.json(service.listTickets({ mailboxId: typeof mailbox === 'string' && mailbox ? mailbox : null, state: String(state), limit, offset }));
  });
  router.get('/tickets/:id', (req, res) => res.json(service.ticket(req.params.id)));
  router.post('/tickets/:id/close', (req, res) => res.json({ ticket: service.closeTicket(req.params.id, { actor: req.auth.user.actor, reason: 'no_reply_needed' }) }));
  router.post('/tickets/:id/reopen', (req, res) => res.json({ ticket: service.reopenTicket(req.params.id) }));
  router.post('/tickets/:id/order', async (req, res) => {
    try {
      res.json(await service.lookupOrder(req.params.id));
    } catch (err) {
      const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status === 500) log?.error?.(`helpdesk order lookup failed for ticket ${req.params.id} (${err?.name ?? 'Error'}; nothing about the customer is logged)`);
      res.status(status).json({ error: status === 500 ? 'The lookup failed: try again' : err.message, code: err?.code ?? 'lookup_failed' });
    }
  });
  return router;
}
