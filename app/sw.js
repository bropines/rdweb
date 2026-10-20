// rdweb service worker: the installed app starts offline or when GitHub Pages
// is unreachable. Built into dist/sw.js by app/vite.config.ts, which fills in
// VERSION (this build) and PRECACHE (index.html and what it loads up front).
//
// - Navigations: network first; the cached app when offline or slow to answer.
// - Same-origin GETs under the app's path (hashed assets, lazy chunks such as
//   xterm.js or the terminal font, icons): cache first, cached on first use.
// - Everything else (other origins, non-GET requests) is left alone; WebSocket
//   connections to RustDesk servers never pass through a service worker.
const VERSION = "__RDWEB_SW_VERSION__";
const PRECACHE = ["__RDWEB_PRECACHE__"];

const PREFIX = "rdweb-"; // other sites may share this origin (user.github.io/*)
const CACHE = PREFIX + VERSION;
const BASE = new URL("./", self.location.href); // /rdweb/
const INDEX = BASE.href;
const NAVIGATION_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  // bypass the HTTP cache: a stale index.html must not land in this version
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((path) => new Request(new URL(path, BASE), { cache: "reload" })))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "skip-waiting") void self.skipWaiting();
  else if (type === "version") event.ports[0]?.postMessage(VERSION);
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(navigate(event, url));
    return;
  }
  if (url.href === self.location.href || url.pathname.endsWith(".map") || request.headers.has("range")) return;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return; // DevTools quirk
  event.respondWith(cacheFirst(event, request));
});

/** The page itself (/rdweb/ or /rdweb/index.html), kept for offline starts. */
function isIndex(url) {
  return url.pathname === BASE.pathname || url.pathname === `${BASE.pathname}index.html`;
}

async function navigate(event, url) {
  const network = fetch(event.request);
  if (isIndex(url)) {
    // keep the latest page for offline starts, also when the cache answers first
    // (this callback runs, and clones, before the page gets the response)
    event.waitUntil(
      network
        .then((response) => {
          if (!response.ok || response.type !== "basic") return undefined;
          const copy = response.clone();
          return caches.open(CACHE).then((cache) => cache.put(INDEX, copy));
        })
        .catch(() => {}),
    );
  }
  const timeout = new Promise((resolve) => setTimeout(resolve, NAVIGATION_TIMEOUT_MS, null));
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
  } catch {
    // offline or the host is unreachable
  }
  const cached = await caches.open(CACHE).then((cache) => cache.match(INDEX));
  return cached ?? network; // nothing cached yet: wait for the network after all
}

async function cacheFirst(event, request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") event.waitUntil(cache.put(request, response.clone()));
  return response;
}
