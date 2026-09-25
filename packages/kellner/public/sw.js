// Kellner-App: die App-Hülle (HTML/JS/CSS/Icon) kommt aus dem Cache, wenn das
// Netz weg ist. API und SSE-Strom gehen NIE über den Cache.
//
// Seitenaufrufe: NETZ ZUERST (mit Zeitlimit), Cache nur als Rückfall — immer
// unter dem festen Schlüssel /index.html, egal über welche URL (/tab/…,
// ?mandantId=…) die App geöffnet wurde. Früher kam die Seite zuerst aus dem
// Cache: die alte Seite registrierte immer wieder den alten SW (die Version
// steckt in ihrem JS), die Handys blieben auf der alten Version hängen.
// Die gehashten Assets dagegen ändern sich nie: Cache zuerst.
//
// cache: 'no-cache' = der Browser fragt beim Server nach (304 genügt), statt
// eine index.html aus seinem HTTP-Cache zu nehmen. Die alte nginx.conf schickte
// für index.html kein Cache-Control — der Browser hielt sie heuristisch noch
// tagelang für frisch, und der SW hätte darüber wieder die alte Seite bekommen.
//
// App-Version aus der Registrierungs-URL (/sw.js?v=<version>) — je Release neu;
// activate räumt alle kellner-*-Caches fremder Versionen ab.
const APP_VERSION = new URLSearchParams(self.location.search).get('v') || 'dev'
const CACHE = 'kellner-' + APP_VERSION
const SHELL = ['/index.html', '/manifest.json', '/icon.svg']
const NETZ_ZEITLIMIT_MS = 4000

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(url => new Request(url, { cache: 'no-cache' }))))
      // Vorab-Cache ist nur für den Offline-Start da — scheitert er (Netz
      // wackelt), darf das die Installation des neuen SW nicht verhindern.
      .catch(() => {})
      .then(() => self.skipWaiting())
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

// Browser, die eine Navigations-Anfrage nicht mit geänderten Optionen kopieren
// können (der Konstruktor wirft dort), holen sie unverändert — dann sorgt allein
// nginx (Cache-Control: no-cache) für die frische Seite.
function amHttpCacheVorbei(request) {
  try {
    return new Request(request, { cache: 'no-cache' })
  } catch (e) {
    return request
  }
}

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
  // API: nie aus dem Cache. SSE (KDS-Nachrichten): ein sauber beendeter Strom
  // landete sonst im Cache und würde bei jedem Neuverbinden wiederholt.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sse/')) return

  if (request.mode === 'navigate') {
    const netz = fetch(amHttpCacheVorbei(request)).then(res => {
      if (res.ok) {
        const clone = res.clone()
        caches.open(CACHE).then(c => c.put('/index.html', clone))
      }
      return res
    })
    // Zeitlimit/offline → Cache; ohne Cache-Eintrag weiter aufs Netz warten
    // statt aufzugeben (Erststart im lahmen WLAN)
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
