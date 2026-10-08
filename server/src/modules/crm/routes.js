// Read API for the CRM (signed in, like every createRouter route). There are no write routes for
// records: devices change them with sync steps (the offline store), server code with
// sync.applyLocal — including the CSV import (C7) below, which writes through applyLocal.
import { Router } from 'express';
import { isId } from '@suite/shared/ids';
import { CLIENT_STATUSES, ACTIVITY_TYPES } from '@suite/shared/crm';
import { HttpError } from '../../lib/httpError.js';
import { LIMITS } from './service.js';

/** One query parameter as a string (or undefined); given twice -> 400. */
function param(query, name, { max = 200 } = {}) {
  const v = query[name];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be given once`);
  if (v.length > max) throw new HttpError(400, `${name} is too long`);
  return v;
}

function idParam(query, name) {
  const v = param(query, name, { max: 36 });
  if (v !== undefined && !isId(v)) throw new HttpError(400, `${name} must be a record id`);
  return v ?? null;
}

function enumParam(query, name, values) {
  const v = param(query, name);
  if (v !== undefined && !values.includes(v)) throw new HttpError(400, `${name} must be one of ${values.join(', ')}`);
  return v ?? null;
}

function paging(query) {
  const int = (name, min, max, dflt) => {
    const v = param(query, name, { max: 9 });
    if (v === undefined) return dflt;
    const n = /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number ${min}–${max}`);
    return n;
  };
  return { limit: int('limit', 1, LIMITS.listMax, LIMITS.listDefault), offset: int('offset', 0, 1_000_000, 0) };
}

export function createCrmRouter(_ctx, service) {
  const router = Router();

  // GET /api/crm/businesses — our businesses and Personal, in display order.
  router.get('/businesses', (_req, res) => {
    res.json({ businesses: service.listBusinesses() });
  });

  // GET /api/crm/clients?q=&business=&status=&limit=&offset= — list / search.
  router.get('/clients', (req, res) => {
    res.json(service.listClients({
      q: param(req.query, 'q') ?? '',
      business: idParam(req.query, 'business'),
      status: enumParam(req.query, 'status', CLIENT_STATUSES),
      ...paging(req.query),
    }));
  });

  // GET /api/crm/clients/:id — the client with its accounts, relationships, services, contacts,
  // consent, links and latest activities.
  router.get('/clients/:id', (req, res) => {
    const out = service.getClient(req.params.id);
    if (!out) throw new HttpError(404, 'No such client');
    res.json(out);
  });

  // GET /api/crm/clients/:id/activities?business=&account=&type=&limit=&offset= — the timeline.
  router.get('/clients/:id/activities', (req, res) => {
    const out = service.listActivities(req.params.id, {
      business: idParam(req.query, 'business'),
      account: idParam(req.query, 'account'),
      type: enumParam(req.query, 'type', ACTIVITY_TYPES),
      ...paging(req.query),
    });
    if (!out) throw new HttpError(404, 'No such client');
    res.json(out);
  });

  // ---- C7: the accounting CSV import (import.js). Needs a connection; writes via applyLocal. ----

  // POST /api/crm/import/preview { text, fileName?, mapping?, business?, kind? } — the rows flagged; nothing written.
  router.post('/import/preview', (req, res) => {
    res.json(service.imports.preview(req.body));
  });

  // POST /api/crm/import/commit { batchId, text, fileName?, mapping?, business?, kind?, choices? }
  // -> 202 { batch } (running in the background), or 200 { batch } when that batch id exists.
  router.post('/import/commit', (req, res) => {
    const { batch, started } = service.imports.commit({ actor: req.auth.user.actor, body: req.body });
    res.status(started ? 202 : 200).json({ batch });
  });

  // GET /api/crm/import/batches — the latest imports (who, when, file, counts), and the running one.
  router.get('/import/batches', (_req, res) => {
    res.json(service.imports.listBatches());
  });

  // GET /api/crm/import/batches/:id — one import's progress and result.
  router.get('/import/batches/:id', (req, res) => {
    const batch = service.imports.getBatch(req.params.id);
    if (!batch) throw new HttpError(404, 'No such import');
    res.json({ batch });
  });

  return router;
}
