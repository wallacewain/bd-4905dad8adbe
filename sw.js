// Offline: the app itself is kept up to date (network first); recordings are served from the phone once saved.
const SHELL = "shell-v1";
const FILES = ["./", "index.html", "app.js", "sched.js", "course.json", "manifest.json", "icon-180.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith(".mp3")) {
    // recordings: from the phone if saved, else the network (and keep it for next time)
    e.respondWith(caches.open("audio-v1").then(async c => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok && res.status === 200) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // everything else: fresh when online, the saved copy when not
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) caches.open(SHELL).then(c => c.put(e.request, res.clone()));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
