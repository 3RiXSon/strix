/* Strix Mobile service worker: offline app shell only.
   API responses are never cached — scan state must always be live, and a
   cached "running" would lie after the phone wakes. Installability needs a
   SW on secure contexts (localhost / https / Tailscale); on plain LAN http
   registration simply fails and the app still works as a web page. */
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./manifest.webmanifest", "./icon.svg"];
const CACHE = "strix-mobile-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") return; // network only
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("./index.html")))
  );
});
