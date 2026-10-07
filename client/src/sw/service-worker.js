// The suite's service worker (served as /sw.js). It keeps the built app — HTML, JS, CSS,
// icons, manifest — so the home-screen app opens with no signal. It never answers /api:
// records live in IndexedDB, written and read by the sync engine (src/sync/).
//
// Not bundled by Vite: the build (vite.config.js, plugin "suite-service-worker") copies this
// file to dist/sw.js and fills in MANIFEST below with { version, files } — every file of
// that build. A new build is a new version: the browser installs it in the background,
// the open app keeps running its own version (same cache, so nothing it needs disappears) and
// offers "Reload"; the old cache is deleted only when the new version takes over.
/* global self, caches */
const MANIFEST = self.__SUITE_PRECACHE__;
const PREFIX = 'suite-shell-';
const SHELL = `${PREFIX}${MANIFEST.version}`;
const INDEX = '/index.html';
const FILES = new Set(MANIFEST.files);

async function fill() {
  const cache = await caches.open(SHELL);
  // cache: 'reload' — straight from the server, not the browser's HTTP cache.
  await cache.addAll(MANIFEST.files.map((url) => new Request(url, { cache: 'reload' })));
}

self.addEventListener('install', (event) => {
  // No skipWaiting: an open app keeps the version it started with until the person reloads.
  // (The very first install has no app to replace and takes over at activate.)
  event.waitUntil(fill());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== SHELL) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (type === 'SKIP_WAITING') self.skipWaiting(); // the person tapped Reload
  else if (type === 'RECACHE') event.waitUntil(fill().catch(() => {})); // after clearLocalData emptied the caches
  else if (type === 'VERSION') event.ports?.[0]?.postMessage({ version: MANIFEST.version });
});

async function fromShell(path, request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(path);
  return hit ?? fetch(request); // not cached (just cleared): the network, if there is one
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The API is never cached here: it is the network or nothing (the engine keeps its own copy).
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    // Every page of the app is the same index.html (client-side routes).
    event.respondWith(fromShell(INDEX, request));
  } else if (FILES.has(url.pathname)) {
    event.respondWith(fromShell(url.pathname, request));
  }
});
