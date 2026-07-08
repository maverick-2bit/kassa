// App-Version aus der Registrierungs-URL (/sw.js?v=<version>) — je Release neu.
// Neue Version ⇒ neue SW-URL ⇒ Browser installiert neu ⇒ frischer Cache,
// activate räumt alle kellner-*-Caches fremder Versionen ab.
const APP_VERSION = new URLSearchParams(self.location.search).get('v') || 'dev'
const CACHE = 'kellner-' + APP_VERSION
const SHELL  = ['/', '/index.html']

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('kellner-') && k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  const { request } = e
  const url = new URL(request.url)

  // API: Network-first, kein Cache
  if (url.pathname.startsWith('/api/')) return

  // App-Shell: Cache-first
  e.respondWith(
    caches.match(request).then(cached => cached ?? fetch(request).then(res => {
      if (res.ok) {
        const clone = res.clone()
        caches.open(CACHE).then(c => c.put(request, clone))
      }
      return res
    }))
  )
})
