/**
 * Kassa Service Worker — Offline-Unterstützung
 *
 * Strategie:
 *  1. App-Shell (HTML/JS/CSS) → Cache-First
 *  2. Artikel, Kategorien, Pos-Konfig → Stale-While-Revalidate
 *  3. POST /api/belege/* (offline) → IndexedDB-Queue + Background Sync
 *  4. Alle anderen GET /api/* → Network-First mit Cache-Fallback
 */

const CACHE_VERSION       = 'kassa-v1'
const STATIC_CACHE        = CACHE_VERSION + '-static'
const API_CACHE           = CACHE_VERSION + '-api'
const OFFLINE_QUEUE_STORE = 'offline-queue'
const DB_NAME             = 'kassa-sw-db'
const DB_VERSION          = 1

const SHELL_ASSETS = ['/', '/index.html']

const CACHEABLE_API = [
  '/api/artikel',
  '/api/kategorien',
  '/api/modifikator-gruppen',
  '/api/artikel-modifikator-gruppen',
  '/api/pos-konfig',
]

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function openDb() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = function(e) {
      var db = e.target.result
      if (!db.objectStoreNames.contains(OFFLINE_QUEUE_STORE)) {
        var store = db.createObjectStore(OFFLINE_QUEUE_STORE, { keyPath: 'id', autoIncrement: true })
        store.createIndex('createdAt', 'createdAt')
      }
    }
    req.onsuccess = function(e) { resolve(e.target.result) }
    req.onerror   = function(e) { reject(e.target.error) }
  })
}

async function queueRequest(request) {
  var db   = await openDb()
  var body = await request.clone().text()
  var entry = {
    url:       request.url,
    method:    request.method,
    headers:   Object.fromEntries(request.headers.entries()),
    body:      body,
    createdAt: Date.now(),
    versuche:  0,
  }
  return new Promise(function(resolve, reject) {
    var tx    = db.transaction(OFFLINE_QUEUE_STORE, 'readwrite')
    var store = tx.objectStore(OFFLINE_QUEUE_STORE)
    var req   = store.add(entry)
    req.onsuccess = function() { resolve(req.result) }
    req.onerror   = function() { reject(req.error) }
  })
}

async function getAllQueued() {
  var db = await openDb()
  return new Promise(function(resolve, reject) {
    var tx    = db.transaction(OFFLINE_QUEUE_STORE, 'readonly')
    var store = tx.objectStore(OFFLINE_QUEUE_STORE)
    var req   = store.getAll()
    req.onsuccess = function() { resolve(req.result) }
    req.onerror   = function() { reject(req.error) }
  })
}

async function removeQueued(id) {
  var db = await openDb()
  return new Promise(function(resolve, reject) {
    var tx    = db.transaction(OFFLINE_QUEUE_STORE, 'readwrite')
    var store = tx.objectStore(OFFLINE_QUEUE_STORE)
    var req   = store.delete(id)
    req.onsuccess = function() { resolve() }
    req.onerror   = function() { reject(req.error) }
  })
}

async function updateVersuche(id, versuche) {
  var db = await openDb()
  return new Promise(function(resolve, reject) {
    var tx    = db.transaction(OFFLINE_QUEUE_STORE, 'readwrite')
    var store = tx.objectStore(OFFLINE_QUEUE_STORE)
    var get   = store.get(id)
    get.onsuccess = function() {
      var entry = get.result
      if (!entry) return resolve()
      entry.versuche = versuche
      var put = store.put(entry)
      put.onsuccess = function() { resolve() }
      put.onerror   = function() { reject(put.error) }
    }
    get.onerror = function() { reject(get.error) }
  })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(function(cache) { return cache.addAll(SHELL_ASSETS).catch(function() {}) })
      .then(function() { return self.skipWaiting() })
  )
})

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys
          .filter(function(k) { return k.startsWith('kassa-') && !k.startsWith(CACHE_VERSION) })
          .map(function(k) { return caches.delete(k) })
      )
    }).then(function() { return self.clients.claim() })
  )
})

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

self.addEventListener('fetch', function(event) {
  var request = event.request
  var url = new URL(request.url)

  if (url.origin !== self.location.origin) return
  if (!url.protocol.startsWith('http')) return
  if (url.pathname.startsWith('/sse')) return

  // POST Beleg → Offline-Queue
  if (request.method === 'POST' &&
      url.pathname.startsWith('/api/belege') &&
      !url.pathname.includes('/drucken')) {
    event.respondWith(handleBelegPost(request))
    return
  }

  // GET gecachte API-Pfade → Stale-While-Revalidate
  if (request.method === 'GET' &&
      CACHEABLE_API.some(function(p) { return url.pathname.startsWith(p) })) {
    event.respondWith(staleWhileRevalidate(request, API_CACHE))
    return
  }

  // Alle anderen GET /api/* → Network-First
  if (request.method === 'GET' && url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API_CACHE))
    return
  }

  // App-Shell → Cache-First
  if (request.method === 'GET') {
    event.respondWith(cacheFirst(request))
    return
  }
})

async function handleBelegPost(request) {
  try {
    var response = await fetch(request.clone())
    return response
  } catch (e) {
    var id = await queueRequest(request.clone())
    notifyClients({ type: 'BELEG_QUEUED', id: id })
    return new Response(
      JSON.stringify({ _offline: true, _queueId: id }),
      { status: 202, headers: { 'Content-Type': 'application/json', 'X-Offline-Queue': '1' } }
    )
  }
}

async function networkFirst(request, cacheName) {
  try {
    var response = await fetch(request.clone())
    if (response.ok) {
      var cache = await caches.open(cacheName)
      cache.put(request, response.clone())
    }
    return response
  } catch (e) {
    var cached = await caches.match(request)
    if (cached) return cached
    return new Response(JSON.stringify({ fehler: 'Offline — keine Daten verfügbar' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function staleWhileRevalidate(request, cacheName) {
  var cache  = await caches.open(cacheName)
  var cached = await cache.match(request)
  var fetchPromise = fetch(request.clone()).then(function(response) {
    if (response.ok) cache.put(request, response.clone())
    return response
  }).catch(function() { return null })
  return cached || (await fetchPromise) || new Response('[]', {
    status: 200, headers: { 'Content-Type': 'application/json' }
  })
}

async function cacheFirst(request) {
  var cached = await caches.match(request)
  if (cached) return cached
  try {
    var response = await fetch(request.clone())
    if (response.ok) {
      var cache = await caches.open(STATIC_CACHE)
      cache.put(request, response.clone())
    }
    return response
  } catch (e) {
    var fallback = await caches.match('/index.html')
    return fallback || new Response('Offline', { status: 503 })
  }
}

// ---------------------------------------------------------------------------
// Background Sync + Messages
// ---------------------------------------------------------------------------

self.addEventListener('sync', function(event) {
  if (event.tag === 'kassa-beleg-sync') {
    event.waitUntil(syncQueue())
  }
})

self.addEventListener('message', function(event) {
  if (!event.data) return
  if (event.data.type === 'SYNC_NOW') {
    syncQueue().then(function() { notifyClients({ type: 'SYNC_DONE' }) })
  }
  if (event.data.type === 'GET_QUEUE_COUNT') {
    getAllQueued().then(function(items) {
      if (event.source) event.source.postMessage({ type: 'QUEUE_COUNT', count: items.length })
    })
  }
})

async function syncQueue() {
  var items = await getAllQueued()
  if (items.length === 0) return

  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    try {
      var response = await fetch(item.url, {
        method:  item.method,
        headers: item.headers,
        body:    item.body,
      })
      if (response.ok || response.status === 409) {
        await removeQueued(item.id)
        notifyClients({ type: 'BELEG_SYNCED', id: item.id, status: response.status })
      } else {
        await updateVersuche(item.id, item.versuche + 1)
        notifyClients({ type: 'BELEG_SYNC_FEHLER', id: item.id, status: response.status })
      }
    } catch (e) {
      break // noch offline
    }
  }
}

async function notifyClients(message) {
  var clients = await self.clients.matchAll({ includeUncontrolled: true })
  clients.forEach(function(client) { client.postMessage(message) })
}
