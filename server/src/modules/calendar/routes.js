import { Router } from 'express';

/**
 * If-None-Match against our ETag (weak comparison, a list or "*"). Not Express's req.fresh: that
 * also says "not fresh" when the request carries Cache-Control: no-cache, which fetch clients add to
 * every conditional request — but a 304 is the right answer to a conditional request either way.
 */
export function matchesEtag(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => bare(t) === bare(etag));
}

/**
 * The feed itself — the one calendar route without a session (a calendar app can't sign in): GET
 * (and HEAD) /api/calendar/feed/<token>.ics only. The token is the key; nothing else is reachable
 * with it (it is not a session), and every other path under /api/calendar needs a session.
 *  paused (System → Connections) → 503 + Retry-After, nothing looked up;
 *  this address locked out (too many unknown links) → 429 + Retry-After;
 *  unknown, replaced or turned-off link → 404 "Not found" (plain text, no detail);
 *  else 200 text/calendar with an ETag (304 when the calendar already has this version);
 *  an error while answering → 503 + Retry-After, logged **without the path** (it holds the token).
 */
export function createCalendarPublicRouter(ctx, service) {
  const router = Router();
  router.get('/feed/:file', (req, res) => {
    // Everything inside one try: an error (SQLITE_BUSY, a bug) must never reach app.js's error handler
    // with the token in req.originalUrl. Logged without the path; answered with a plain 503.
    try {
      return answerFeed(req, res, service);
    } catch (err) {
      ctx.log?.error?.('calendar feed: could not answer a feed request:', err?.message ?? err);
      if (res.headersSent) return res.end();
      return res.status(503).set('Retry-After', '300').type('text/plain').send('The task calendar can’t be read right now.');
    }
  });
  return router;
}

function answerFeed(req, res, service) {
  res.set('Cache-Control', 'private, no-cache');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  if (service.isPaused()) {
    return res.status(503).set('Retry-After', '900').type('text/plain').send('The task calendar is switched off for now.');
  }
  const ip = req.ip ?? 'unknown';
  const wait = service.lockedFor(ip);
  if (wait > 0) {
    return res.status(429).set('Retry-After', String(Math.ceil(wait / 1000))).type('text/plain').send('Too many attempts.');
  }
  const m = /^(.+)\.ics$/.exec(req.params.file ?? '');
  const actor = m ? service.actorForToken(m[1]) : null;
  if (!actor) {
    service.failed(ip);
    return res.status(404).type('text/plain').send('Not found');
  }
  service.succeeded(ip);
  const feed = service.feedFor(actor, { baseUrl: `${req.protocol}://${req.host}` });
  service.markFetched(actor);
  res.set('ETag', feed.etag);
  res.set('Content-Disposition', 'inline; filename="suite-tasks.ics"');
  if (matchesEtag(req.get('if-none-match'), feed.etag)) return res.status(304).end();
  return res.type('text/calendar; charset=utf-8').send(feed.body);
}

const NO_STORE = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** Signed in (app.js puts requireSession in front): each person manages their own link. */
export function createCalendarRouter(ctx, service) {
  const router = Router();
  const info = () => ({ publicUrl: ctx.config.calendar.publicUrl, timeZone: service.timeZone });

  // GET /api/calendar/link -> { feed: { on, createdAt, lastFetchedAt, paused }, publicUrl, timeZone }
  router.get('/link', (req, res) => {
    res.json({ feed: service.state(req.auth.user.actor), ...info() });
  });

  // POST /api/calendar/link {} -> { token, path, replaced, feed, publicUrl } — makes or replaces the
  // link (the old one stops working at once). The token is in this answer only.
  router.post('/link', NO_STORE, (req, res) => {
    res.json({ ...service.makeLink({ actor: req.auth.user.actor, deviceId: req.auth.device?.id ?? null }), ...info() });
  });

  // DELETE /api/calendar/link -> { turnedOff, feed } — calendars subscribed to it get 404 from now on.
  router.delete('/link', (req, res) => {
    res.json({ ...service.turnOff({ actor: req.auth.user.actor, deviceId: req.auth.device?.id ?? null }), ...info() });
  });

  return router;
}
