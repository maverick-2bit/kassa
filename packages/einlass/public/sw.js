// Einlass-App offline startbar halten: die App-Hülle (HTML/JS/CSS/Icon) kommt
// aus dem Cache, wenn am Eingang das Netz weg ist. Die API geht NIE über den
// Cache — Tickets und Scans verwaltet die App selbst (IndexedDB).
//
// Seitenaufrufe: NETZ ZUERST (mit Zeitlimit), Cache nur als Rückfall. Würde
// die Startseite zuerst aus dem Cache kommen, registrierte die alte Seite
// immer wieder den alten SW (die Version steckt in ihrem JS) — neue Versionen
// kämen nie an. Die gehashten Assets dagegen ändern sich nie: Cache zuerst.
//
// App-Version aus der Registrierungs-URL (/sw.js?v=<version>) — je Release neu;
// activate räumt alle einlass-*-Caches fremder Versionen ab.
const APP_VERSION = new URLSearchParams(self.location.search).get('v') || 'dev'
const CACHE = 'einlass-' + APP_VERSION
const SHELL = ['/', '/index.html', '/manifest.json', '/icon.svg']
const NETZ_ZEITLIMIT_MS = 4000

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('einlass-') && k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  )
})

function mitZeitlimit(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Zeitlimit')), ms)
    promise.then(v => { clearTimeout(t); resolve(v) }, err => { clearTimeout(t); reject(err) })
  })
}

self.addEventListener('fetch', e => {
  const { request } = e
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return   // API: nie aus dem Cache

  if (request.mode === 'navigate') {
    const netz = fetch(request).then(res => {
      if (res.ok) {
        const clone = res.clone()
        caches.open(CACHE).then(c => c.put('/index.html', clone))
      }
      return res
    })
    // Zeitlimit/offline → Cache; ohne Cache-Eintrag (Erststart im lahmen WLAN)
    // weiter aufs Netz warten statt aufzugeben
    e.respondWith(
      mitZeitlimit(netz, NETZ_ZEITLIMIT_MS)
        .catch(() => caches.match('/index.html').then(c => c ?? netz))
    )
    return
  }

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
