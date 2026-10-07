// This browser's (or home-screen app's) device id, and the local copy that goes with it.
//
// The server gives the id at sign-in (POST /api/auth/login/code -> device.id) and it is
// also this device's sync id (every offline change is stamped with it). It is sent back at
// the next sign-in so an expired session continues as the same device, unsent changes and all.
//
// clearLocalData() is what happens when this device is signed out — by its own Sign out button,
// from the other person's Devices page (the server answers 401 device_signed_out), or when
// sign-in hands this browser a different device id (another person, or a signed-out device).
// It deletes everything stored for the signed-in person: the offline database (records,
// the outbox including unsent changes — on purpose, a signed-out phone may be lost — the kept
// sent steps, changes that need attention, the HLC and the pull cursors), the remembered
// session, and every Cache Storage cache except the public app shell. The theme choice is not
// personal data and stays.
import { deleteLocalDb } from '../sync/localdb.js';

const DEVICE_KEY = 'suite.deviceId';
const SESSION_KEY = 'suite.session';

const storage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // some private modes throw on access
  }
};

export function getDeviceId() {
  try {
    return storage()?.getItem(DEVICE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setDeviceId(id) {
  try {
    storage()?.setItem(DEVICE_KEY, id);
  } catch {
    /* private mode: the id lasts for this page only; the server makes a new device next time */
  }
}

/**
 * The last session this device saw ({ user, device, session }), so the app can open offline
 * as the same person on the same device. Only kept while the device id matches.
 */
export function readSessionCache() {
  try {
    const cached = JSON.parse(storage()?.getItem(SESSION_KEY) ?? 'null');
    return cached?.device?.id && cached.device.id === getDeviceId() ? cached : null;
  } catch {
    return null;
  }
}

export function saveSessionCache(session) {
  try {
    storage()?.setItem(SESSION_KEY, JSON.stringify({ user: session.user, device: session.device, session: session.session }));
  } catch {
    /* storage full or unavailable: the app just won't open offline */
  }
}

const PENDING_KEY = 'suite.signOutPending';

/**
 * Signing out without a connection can't tell the server, and the session cookie (HttpOnly) stays
 * in the browser: remember the device id so the sign-out is sent before anything else next time,
 * instead of the old session quietly resuming. Kept apart from clearLocalData on purpose.
 */
export function readPendingSignOut() {
  try {
    return storage()?.getItem(PENDING_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setPendingSignOut(deviceId) {
  try {
    if (deviceId) storage()?.setItem(PENDING_KEY, deviceId);
    else storage()?.removeItem(PENDING_KEY);
  } catch {
    /* storage unavailable */
  }
}

const CLEAR_TIMEOUT_MS = 5000;

/**
 * Delete every Cache Storage cache except the app shell (`suite-shell-*`). The shell holds only the
 * public built app — the same files the server gives anyone — and is what lets the app open with no
 * signal, including a new version waiting to take over, so it stays.
 */
async function clearServiceWorkerCaches() {
  const caches = globalThis.caches;
  if (!caches?.keys) return;
  for (const name of await caches.keys()) {
    if (!name.startsWith('suite-shell-')) await caches.delete(name);
  }
}

/** Remove everything stored on this device for the signed-in person. */
export async function clearLocalData() {
  try {
    storage()?.removeItem(DEVICE_KEY);
    storage()?.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: nothing was stored */
  }
  // Closes this page's connections first; other tabs close theirs when asked (versionchange).
  // If one doesn't, the delete still happens as soon as it does; don't hang the sign-out on it.
  let timer;
  await Promise.race([
    deleteLocalDb().catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, CLEAR_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  try {
    await clearServiceWorkerCaches();
  } catch {
    /* no Cache Storage here */
  }
}

/** True when running from the home screen (standalone) rather than in a browser tab. */
export function isInstalled() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  } catch {
    return false;
  }
}
