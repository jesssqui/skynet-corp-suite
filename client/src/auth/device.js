// This browser's (or home-screen app's) device id, and the local copy that goes with it.
//
// The server gives the id at sign-in (POST /api/auth/login/code -> device.id) and it is
// also this device's sync id (C2b stamps its changes with it). It is sent back at the next
// sign-in so an expired session continues as the same device, unsent changes and all.
//
// clearLocalData() is what happens when this device is signed out — by its own Sign out button
// or from the other person's Devices page (the server answers 401 device_signed_out). Today the
// only local data is the device id. C2b MUST extend this to delete everything it stores for the
// signed-in person: the IndexedDB copy of records, the outbox (unsent changes are dropped on
// purpose: a signed-out phone may be lost), the kept sent steps, the HLC, the pull cursor,
// and any service-worker caches of API responses. The theme choice is not personal data and stays.
const DEVICE_KEY = 'suite.deviceId';

export function getDeviceId() {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

export function setDeviceId(id) {
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    /* private mode: the id lasts for this page only; the server makes a new device next time */
  }
}

/** Remove everything stored on this device for the signed-in person. */
export async function clearLocalData() {
  try {
    localStorage.removeItem(DEVICE_KEY);
    // C2b: delete the offline database, outbox and caches here (see the comment at the top).
  } catch {
    /* storage unavailable: nothing was stored */
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
