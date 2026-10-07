// Registers the service worker (production builds only) and runs the update flow:
// a new version installs in the background, UpdateBanner offers "Reload", and only
// then does the new version take over (and the page reloads into it). An open app is
// never switched to files it didn't start with.

let state = { ready: false, updateReady: false, updated: false };
const listeners = new Set();
let waitingWorker = null;
let reloadRequested = false;

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of [...listeners]) fn(state);
}

export function getUpdateState() {
  return state;
}

export function subscribeUpdate(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function track(reg) {
  const offer = (worker) => {
    waitingWorker = worker;
    set({ updateReady: true });
  };
  // A version that finished installing while no page let it take over.
  if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      // installed + an existing controller = an update (the first install just takes over)
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
    });
  });
}

/** The person tapped Reload: let the new version take over, then reload into it. */
export function applyUpdate() {
  reloadRequested = true;
  // Still waiting: let it take over (controllerchange then reloads). Already taken over by another tab: just reload.
  if (waitingWorker?.state === 'installed') waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  else window.location.reload();
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // A page opened without a service worker (the first visit) gets one when it installs
  // (clients.claim): that first controllerchange is not an update.
  let controlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadRequested) {
      window.location.reload();
    } else if (!controlled) {
      controlled = true;
    } else {
      // Another tab let a new version take over: this one still runs the old files; offer a reload.
      set({ updated: true, updateReady: false });
    }
  });

  const go = async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch (err) {
      // Opened offline: the script can't be fetched to check for updates, but the installed
      // worker keeps serving the app. Follow it anyway (a waiting update still gets offered).
      reg = await navigator.serviceWorker.getRegistration('/').catch(() => null);
      if (!reg) {
        console.warn('Service worker not registered; the app will not open offline:', err);
        return;
      }
    }
    set({ ready: true });
    track(reg);
    // Home-screen apps rarely navigate, so also look for a new version when the app comes back
    // to the foreground (at most every 10 minutes), when it is back online, and every hour.
    let lastCheck = Date.now();
    const check = () => {
      lastCheck = Date.now();
      reg.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck > 10 * 60 * 1000) check();
    });
    window.addEventListener('online', check);
    setInterval(check, 60 * 60 * 1000);
  };
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}
