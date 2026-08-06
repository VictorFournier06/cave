// Cave service worker — offline app shell + last-known data.
// Shell is cache-first (instant, works offline). /api GETs are network-first with
// a cache fallback, so the cellar still loads with no signal. Writes never touch
// the SW — the app queues them itself (see index.html) and replays on reconnect.
const CACHE = "cave-v42";
const SHELL = ["/", "/index.html", "/styles.css", "/manifest.webmanifest",
  "/icon-192.png", "/icon-512.png", "/icon-192-maskable.png", "/icon-512-maskable.png", "/apple-touch-icon.png"];
// Seed the data too, so the cellar is browsable offline on the very first session.
const SEED = ["/api/wines", "/api/meta"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all([c.addAll(SHELL), ...SEED.map((u) => fetch(u).then((r) => c.put(u, r)).catch(() => {}))]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k)))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // writes go straight to network / app queue
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    e.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
        .catch(() => caches.match(req)),
    );
    return;
  }
  // page navigations: network-first so a new deploy lands immediately when online,
  // falling back to the cached page offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/", copy)); } return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match("/"))),
    );
    return;
  }
  // other static assets (icons, etc.): cache-first
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
        .catch(() => undefined),
    ),
  );
});
