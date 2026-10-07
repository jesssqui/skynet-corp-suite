// Who is making a sync request: { actor, deviceId }, from the signed-in session.
//
// The auth module's guard puts the session on req.auth (and app.js refuses the request
// before it gets here when there is none, or when the device was signed out). The actor
// is the account's (owner / partner); the device id is the one bound to the session at
// sign-in, so a device can't speak for another one or for the other person.
// A device may still say which device it thinks it is (X-Suite-Device header, or deviceId
// in the body / query): if that differs from the session's, the request is refused rather
// than stamped with the wrong device (its steps' HLC stamps would not match anyway).
import { ACTORS } from '@suite/shared/actors';
import { HttpError } from '../../lib/httpError.js';

export { ACTORS };

function claimed(req, header, name) {
  const fromHeader = req.get(header);
  const fromBody = req.body && typeof req.body === 'object' ? req.body[name] : undefined;
  const fromQuery = req.query?.[name];
  return [fromHeader, fromBody, fromQuery].filter((v) => v !== undefined && v !== '');
}

/** @returns {{ actor: string, deviceId: string }} */
export function identify(req) {
  const auth = req.auth;
  if (!auth) throw new HttpError(401, 'Sign in to continue', undefined, { code: 'not_signed_in' });
  const deviceId = auth.device.id;
  const actor = auth.user.actor;
  if (claimed(req, 'x-suite-device', 'deviceId').some((v) => v !== deviceId)) {
    throw new HttpError(409, 'This request names a different device than the one signed in here', undefined, { code: 'device_mismatch' });
  }
  if (claimed(req, 'x-suite-actor', 'actor').some((v) => v !== actor)) {
    throw new HttpError(403, 'This request names a different person than the one signed in', undefined, { code: 'actor_mismatch' });
  }
  return { actor, deviceId };
}
