// Who is making a sync request: { actor, deviceId }.
//
// STAND-IN UNTIL C1 (sign-in). Today the device says who it is in headers
// (X-Suite-Device, X-Suite-Actor) or in the push body / pull query. That is only
// acceptable because the server is reachable from the tailnet only and both
// people have full access anyway. C1 replaces identify() with the signed-in
// session (actor from the session, device id bound to that session) and keeps
// the same return shape, so nothing else in the sync module changes.
import { isId } from '@suite/shared/ids';
import { HttpError } from '../../lib/httpError.js';

/** The two people who use the suite. C1 turns these into real accounts. */
export const ACTORS = ['owner', 'partner'];

function pick(req, header, name) {
  const fromHeader = req.get(header);
  const fromBody = req.body && typeof req.body === 'object' ? req.body[name] : undefined;
  const fromQuery = req.query?.[name];
  const given = [fromHeader, fromBody, fromQuery].filter((v) => v !== undefined && v !== '');
  if (new Set(given).size > 1) throw new HttpError(400, `${name} given twice with different values`);
  return given[0];
}

/** @returns {{ actor: string, deviceId: string }} */
export function identify(req) {
  const deviceId = pick(req, 'x-suite-device', 'deviceId');
  const actor = pick(req, 'x-suite-actor', 'actor');
  if (!isId(deviceId)) throw new HttpError(400, 'deviceId must be a UUIDv7 made on the device (X-Suite-Device)');
  if (!ACTORS.includes(actor)) throw new HttpError(400, `actor must be one of ${ACTORS.join(', ')} (X-Suite-Actor)`);
  return { actor, deviceId };
}
