/* EN Speaking service worker: network first, so a new version on GitHub is used as soon as it is online;
   the cached copy is used only when there is no connection. API calls are never cached. */
const CACHE = 'ens-shell-2.12.0';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'gemini.js', 'prompts.json', 'manifest.webmanifest', 'favicon.ico', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // OpenAI, Google, fonts: straight to the network
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' })
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match('index.html')))
  );
});
