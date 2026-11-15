/**
 * Kassa Service Worker — Offline-Unterstützung
 *
 * Strategie:
 *  1. Seitenaufrufe (index.html) → Network-First mit Zeitlimit, Cache nur als
 *     Offline-Rückfall; gehashte Assets (JS/CSS/Icons) → Cache-First
 *  2. Verkäufe (POST /api/belege/barzahlung mit Idempotency-Key und
 *     X-Kassa-Offline: puffern) → bei Netzausfall IndexedDB-Warteschlange +
 *     Nachsenden. Alle anderen POSTs (Storno, Sonderbelege, FinanzOnline …)
 *     gehen nie in die Warteschlange: offline schlagen sie sofort fehl.
 *  3. ALLE GET /api/* → Network-First mit Cache-Fallback
 *
 * Warteschlange (Prüfbericht 2026-11, RKSV):
 *  - Gespeichert werden nur URL, Body, Content-Type und Idempotency-Key — NIE der
 *    Login-Token. Beim Nachsenden holt der SW den aktuellen Token von der Seite
 *    (TOKEN_ANFRAGE); ohne angemeldete Seite wartet die Warteschlange.
 *  - Der Idempotency-Key macht das Nachsenden sicher: War der Verkauf schon
 *    gebucht (nur die Antwort ging verloren), liefert das Backend den Beleg.
 *  - Fachliche Ablehnung (4xx außer 401/408/429): Der Verkauf bleibt mit Grund
 *    markiert stehen, bis der Kassier ihn erneut versucht oder bewusst verwirft —
 *    nichts geht still verloren. 401 = neu anmelden; 5xx/Netz = später erneut.
 *
 * Hinweis: Früher liefen Artikel/Kategorien/Pos-Konfig über Stale-While-Revalidate.
 * Das lieferte nach dem Anlegen/Ändern zunächst die VERALTETE Cache-Version und
 * aktualisierte den Cache nur im Hintergrund → der neue Posten erschien erst beim
 * nächsten Aufruf („einen Reload hinterher"). Darum jetzt einheitlich Network-First:
 * online immer frisch, der Cache dient nur als Offline-Fallback.
 */

// App-Version aus der Registrierungs-URL (/sw.js?v=<version>) — je Release neu.
// Neue Version ⇒ neue SW-URL ⇒ Browser installiert neu ⇒ frische Caches,
// activate räumt alle kassa-*-Caches fremder Versionen ab.
const APP_VERSION         = new URLSearchParams(self.location.search).get('v') || 'dev'
const CACHE_VERSION       = 'kassa-' + APP_VERSION
const STATIC_CACHE        = CACHE_VERSION + '-static'
const API_CACHE           = CACHE_VERSION + '-api'
const OFFLINE_QUEUE_STORE = 'offline-queue'
const DB_NAME             = 'kassa-sw-db'
const DB_VERSION          = 1
const NETZ_ZEITLIMIT_MS   = 4000
// Verkauf: so lange auf die Antwort warten, dann puffern (großzügig über einem normalen Verkauf;
// kommt die Antwort doch noch, ist das dank Idempotency-Key unschädlich)
const VERKAUF_ZEITLIMIT_MS = 10000

const SHELL_ASSETS = ['/index.html']

// ---------------------------------------------------------------------------
// IndexedDB — Offline-Warteschlange
// ---------------------------------------------------------------------------

// Nur diese Header werden gespeichert und nachgesendet — nie Authorization.
var GESPEICHERTE_HEADER = ['content-type', 'idempotency-key']

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

/** Eine Anfrage an den Store; arbeit(store) liefert den IDBRequest, dessen Ergebnis zurückkommt. */
async function mitStore(modus, arbeit) {
  var db = await openDb()
  return new Promise(function(resolve, reject) {
    var store = db.transaction(OFFLINE_QUEUE_STORE, modus).objectStore(OFFLINE_QUEUE_STORE)
    var req   = arbeit(store)
    req.onsuccess = function() { resolve(req.result) }
    req.onerror   = function() { reject(req.error) }
  })
}

function nurGespeicherteHeader(headers) {
  var aus = {}
  Object.keys(headers || {}).forEach(function(name) {
    if (GESPEICHERTE_HEADER.indexOf(name.toLowerCase()) >= 0) aus[name.toLowerCase()] = headers[name]
  })
  return aus
}

/** Summe des Verkaufs für die Anzeige in der Warteschlange (Bar + Karte + Sonstige) */
function summeAusBody(body) {
  try {
    var z = JSON.parse(body).zahlung || {}
    return (z.barCent || 0) + (z.karteCent || 0) + (z.sonstigeCent || 0)
  } catch (e) {
    return null
  }
}

// Einträge dieses Formats sind geprüft (Idempotency-Key, kein Token); ältere bereinigt das Aktivieren
var EINTRAG_FORMAT = 2
var VERKAUF_PFAD   = '/api/belege/barzahlung'

async function queueRequest(request) {
  var body = await request.clone().text()
  var headers = {}
  request.headers.forEach(function(wert, name) { headers[name] = wert })
  return mitStore('readwrite', function(store) {
    return store.add({
      format:    EINTRAG_FORMAT,
      url:       request.url,
      method:    request.method,
      headers:   nurGespeicherteHeader(headers),
      body:      body,
      summeCent: summeAusBody(body),
      createdAt: Date.now(),
      versuche:  0,
      fehler:    null,
    })
  })
}

function getAllQueued() {
  return mitStore('readonly', function(store) { return store.getAll() })
}

function removeQueued(id) {
  return mitStore('readwrite', function(store) { return store.delete(id) })
}

/**
 * Eintrag lesen, ändern, zurückschreiben — in EINER Transaktion: ein gleichzeitiges Löschen
 * (Verwerfen, erfolgreiches Nachsenden) kann den Eintrag so nicht wieder auferstehen lassen.
 * Fehlt er inzwischen: nichts tun.
 */
async function aendereEintrag(id, aendern) {
  var db = await openDb()
  return new Promise(function(resolve, reject) {
    var store = db.transaction(OFFLINE_QUEUE_STORE, 'readwrite').objectStore(OFFLINE_QUEUE_STORE)
    var get = store.get(id)
    get.onsuccess = function() {
      var eintrag = get.result
      if (!eintrag) return resolve()
      aendern(eintrag)
      var put = store.put(eintrag)
      put.onsuccess = function() { resolve() }
      put.onerror   = function() { reject(put.error) }
    }
    get.onerror = function() { reject(get.error) }
  })
}

/**
 * Einträge älterer SW-Versionen: Die nahmen JEDEN POST auf /api/belege/* auf (auch Storno,
 * Sonderbelege, FinanzOnline-Registrierung samt PIN), mit allen Headern samt Login-Token und ohne
 * Idempotency-Key. Beim Aktivieren: Token weg; nichts davon wird mehr ungefragt gesendet —
 *  - Verkauf ohne Schlüssel: markiert, der Kassier prüft in der Belegliste, ob er schon gebucht
 *    ist (kein Schutz vor Doppelbuchung), und sendet ihn dann erneut oder verwirft ihn;
 *  - alles andere: Inhalt gelöscht (kann einen PIN tragen), nur noch Verwerfen möglich.
 */
async function bereinigeAlteEintraege() {
  var eintraege = await getAllQueued()
  for (var i = 0; i < eintraege.length; i++) {
    if (eintraege[i].format === EINTRAG_FORMAT) continue
    await aendereEintrag(eintraege[i].id, function(x) {
      var pfad = ''
      try { pfad = new URL(x.url).pathname } catch (e) { /* kaputte URL: wie fremder Eintrag */ }
      x.headers   = nurGespeicherteHeader(x.headers)
      x.summeCent = pfad === VERKAUF_PFAD ? summeAusBody(x.body) : null
      x.versuche  = x.versuche || 0
      x.format    = EINTRAG_FORMAT
      if (pfad !== VERKAUF_PFAD) {
        x.body         = null
        x.nurVerwerfen = true
        x.fehler = { status: 0, am: Date.now(), meldung: 'Aus einer älteren Version gespeichert (' + (pfad || 'unbekannt') +
          ', z. B. Storno oder Sonderbeleg) — wird nicht mehr nachgesendet. Bitte bei Bedarf von Hand erledigen und hier verwerfen.' }
      } else if (!x.headers['idempotency-key']) {
        x.fehler = { status: 0, am: Date.now(), meldung: 'Aus einer älteren Version gespeichert, ohne Schutz vor Doppelbuchung: ' +
          'erst in der Belegliste prüfen, ob dieser Verkauf schon gebucht ist — dann verwerfen, sonst erneut senden.' }
      } else if (x.fehler === undefined) {
        x.fehler = null
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      // no-cache: beim Server nachfragen statt eine alte index.html aus dem
      // HTTP-Cache des Browsers in den neuen Cache zu übernehmen
      .then(function(cache) {
        return cache.addAll(SHELL_ASSETS.map(function(url) { return new Request(url, { cache: 'no-cache' }) }))
          .catch(function() {})
      })
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
    })
      // Login-Token aus Warteschlangen-Einträgen älterer Versionen entfernen
      .then(function() { return bereinigeAlteEintraege().catch(function() {}) })
      .then(function() { return self.clients.claim() })
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

  // Verkauf, den die Kassa ausdrücklich zum Puffern freigibt (Idempotency-Key +
  // X-Kassa-Offline) → bei Netzausfall in die Warteschlange. Alle anderen POSTs
  // gehen ungefiltert ans Netz und schlagen offline sofort fehl.
  if (request.method === 'POST' &&
      url.pathname === '/api/belege/barzahlung' &&
      request.headers.get('idempotency-key') &&
      request.headers.get('x-kassa-offline') === 'puffern') {
    event.respondWith(handleVerkaufPost(request))
    return
  }

  // ALLE GET /api/* → Network-First (online immer frisch, Cache nur Offline-Fallback)
  if (request.method === 'GET' && url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API_CACHE))
    return
  }

  // Navigationen (index.html) → Network-First.
  //
  // WICHTIG, nicht Cache-First: index.html verweist auf die gehashten Bundle-
  // Dateien. Käme sie aus dem Cache, liefe nach einem Update ewig das alte
  // Bundle. Und weil die SW-Registrierungs-URL /sw.js?v=<version> aus genau
  // diesem alten Bundle stammt, fragt der Browser immer wieder dieselbe URL an,
  // bekommt „unverändert" und installiert nie einen neuen SW — die Kassa käme
  // aus eigener Kraft nie wieder aus dem alten Stand heraus.
  //
  // Offline-Rückfall immer unter dem festen Schlüssel /index.html: auch eine
  // offline erstmals aufgerufene Route (/verkauf, ?kasse=…) bekommt so die
  // App-Hülle statt einer Fehlerseite. Hängt das WLAN, nach 4 s ebenfalls.
  if (request.mode === 'navigate') {
    event.respondWith(seiteNetzZuerst(request))
    return
  }

  // Übrige Shell-Dateien (gehashte Assets, Icons) → Cache-First.
  // Die sind unveränderlich: neue Version ⇒ neuer Dateiname.
  if (request.method === 'GET') {
    event.respondWith(cacheFirst(request))
    return
  }
})

async function handleVerkaufPost(request) {
  var fuerWarteschlange = request.clone()
  // Hängendes WLAN: ein fetch scheitert dann oft nicht, sondern wartet ewig (TCP-Zeitlimit) —
  // die Kasse stünde so lange still. Nach dem Zeitlimit abbrechen und puffern.
  var abbruch = new AbortController()
  var zeitlimit = setTimeout(function() { abbruch.abort() }, VERKAUF_ZEITLIMIT_MS)
  try {
    return await fetch(request, { signal: abbruch.signal })
  } catch (e) {
    // Netz weg, Zeitlimit — oder die Antwort ging verloren, nachdem der Server schon gebucht hat.
    // Alles sicher: Der Idempotency-Key verhindert beim Nachsenden den Doppelbeleg.
    var id = await queueRequest(fuerWarteschlange)
    notifyClients({ type: 'BELEG_QUEUED', id: id })
    return new Response(
      JSON.stringify({ _offline: true, _queueId: id }),
      { status: 202, headers: { 'Content-Type': 'application/json', 'X-Offline-Queue': '1' } }
    )
  } finally {
    clearTimeout(zeitlimit)
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

// Seitenaufruf: Netz zuerst. cache: 'no-cache' = beim Server nachfragen (304
// genügt) statt einer index.html, die der Browser heuristisch noch für frisch
// hält (nginx schickte früher kein Cache-Control). Zeitlimit/offline → App-
// Hülle aus dem Cache; ohne Cache-Eintrag weiter aufs Netz warten.
function seiteNetzZuerst(request) {
  var netz = fetch(amHttpCacheVorbei(request)).then(function(response) {
    if (response.ok) {
      var kopie = response.clone()
      caches.open(STATIC_CACHE).then(function(cache) { cache.put('/index.html', kopie) })
    }
    return response
  })
  return mitZeitlimit(netz, NETZ_ZEITLIMIT_MS).catch(function() {
    return caches.match('/index.html').then(function(cached) { return cached || netz })
  })
}

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
  return new Promise(function(resolve, reject) {
    var t = setTimeout(function() { reject(new Error('Zeitlimit')) }, ms)
    promise.then(
      function(v)   { clearTimeout(t); resolve(v) },
      function(err) { clearTimeout(t); reject(err) }
    )
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
// Nachsenden (Background Sync + Messages)
// ---------------------------------------------------------------------------

var TOKEN_ZEITLIMIT_MS = 2000

self.addEventListener('sync', function(event) {
  if (event.tag === 'kassa-beleg-sync') {
    event.waitUntil(syncQueue())
  }
})

self.addEventListener('message', function(event) {
  var d = event.data
  if (!d) return
  var arbeit = null
  if (d.type === 'SYNC_NOW') {
    arbeit = syncQueue(d.token).then(function() { notifyClients({ type: 'SYNC_DONE' }) })
  }
  if (d.type === 'GET_QUEUE_COUNT') {
    arbeit = getAllQueued().then(function(items) {
      if (event.source) event.source.postMessage({ type: 'QUEUE_COUNT', count: items.length })
    })
  }
  if (d.type === 'GET_QUEUE') {
    arbeit = getAllQueued().then(function(items) {
      if (event.source) event.source.postMessage({ type: 'QUEUE_LISTE', eintraege: items.map(zurAnzeige) })
    })
  }
  // Kassier: abgelehnten Verkauf noch einmal senden (z. B. nach neuer Anmeldung).
  // Einträge, die nur noch verworfen werden können (Altbestand ohne Inhalt), bleiben unberührt.
  if (d.type === 'ERNEUT_VERSUCHEN') {
    arbeit = aendereEintrag(d.id, function(e) { if (!e.nurVerwerfen) e.fehler = null })
      .then(function() { return syncQueue(d.token) })
      .then(function() { notifyClients({ type: 'SYNC_DONE' }) })
  }
  // Kassier: abgelehnten Verkauf bewusst verwerfen (er wird dann nicht gebucht)
  if (d.type === 'VERWERFEN') {
    arbeit = removeQueued(d.id).then(function() { notifyClients({ type: 'SYNC_DONE' }) })
  }
  // Der Browser darf den SW nicht beenden, solange die Arbeit läuft
  if (arbeit && typeof event.waitUntil === 'function') event.waitUntil(arbeit.catch(function() {}))
})

/** Was die Oberfläche von einem Eintrag sieht — ohne Body (der kann einen Freigabe-PIN tragen) */
function zurAnzeige(e) {
  return {
    id: e.id, createdAt: e.createdAt, summeCent: e.summeCent == null ? null : e.summeCent,
    fehler: e.fehler || null, nurVerwerfen: !!e.nurVerwerfen,
  }
}

/** Login-Token der Seite holen — der SW speichert ihn nie. Ohne Antwort: null. */
function frageToken(client) {
  return new Promise(function(resolve) {
    var kanal = new MessageChannel()
    var t = setTimeout(function() { resolve(null) }, TOKEN_ZEITLIMIT_MS)
    kanal.port1.onmessage = function(e) {
      clearTimeout(t)
      resolve((e.data && e.data.token) || null)
    }
    client.postMessage({ type: 'TOKEN_ANFRAGE' }, [kanal.port2])
  })
}

async function holeToken() {
  var clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (var i = 0; i < clients.length; i++) {
    var token = await frageToken(clients[i])
    if (token) return token
  }
  return null
}

/** Grund der Ablehnung für den Kassier — mit Hinweis, wenn offline keine Freigabe möglich war */
async function fehlerText(response) {
  var text = 'HTTP ' + response.status
  var code = null
  try {
    var data = await response.json()
    if (data && typeof data.fehler === 'string') text = data.fehler
    if (data && typeof data.code === 'string') code = data.code
  } catch (e) { /* kein JSON */ }
  if (code === 'freigabe_erforderlich') {
    text += ' — Die Freigabe lässt sich nachträglich nicht erteilen: Verkauf verwerfen und mit Freigabe-PIN neu kassieren.'
  }
  return text
}

// Nur ein Nachsende-Lauf gleichzeitig (sync-Ereignis und SYNC_NOW können zusammenfallen).
// Kommt währenddessen ein neuer Anstoß (z. B. „Erneut senden"), läuft danach noch ein Durchgang:
// Der laufende hat seine Liste schon gelesen und sähe den freigegebenen Eintrag nicht mehr.
var laufenderSync = null
var nochEinLauf   = null   // Token oder '': Anstoß während eines Laufs; null: keiner

function syncQueue(tokenVorgabe) {
  if (laufenderSync) {
    nochEinLauf = tokenVorgabe || nochEinLauf || ''
    return laufenderSync
  }
  laufenderSync = (async function() {
    var token = tokenVorgabe
    for (;;) {
      await syncLauf(token)
      if (nochEinLauf === null) break
      token = nochEinLauf || undefined
      nochEinLauf = null
    }
  })().finally(function() { laufenderSync = null })
  return laufenderSync
}

/** Nachsenden mit Zeitlimit — ein hängendes WLAN darf den Lauf nicht für immer blockieren */
function sendeMitZeitlimit(url, init) {
  var abbruch = new AbortController()
  var t = setTimeout(function() { abbruch.abort() }, VERKAUF_ZEITLIMIT_MS)
  init.signal = abbruch.signal
  return fetch(url, init).finally(function() { clearTimeout(t) })
}

async function syncLauf(tokenVorgabe) {
  await bereinigeAlteEintraege().catch(function() {})
  var offen = (await getAllQueued()).filter(function(e) { return !e.fehler && e.format === EINTRAG_FORMAT })
  if (offen.length === 0) return

  var token = tokenVorgabe || await holeToken()
  if (!token) {
    notifyClients({ type: 'SYNC_ANMELDUNG_NOETIG' })
    return
  }

  // In Erfassungsreihenfolge (IndexedDB liefert nach aufsteigender ID)
  for (var i = 0; i < offen.length; i++) {
    var item = offen[i]
    var headers = nurGespeicherteHeader(item.headers)
    headers['authorization'] = 'Bearer ' + token
    var response
    try {
      response = await sendeMitZeitlimit(item.url, { method: item.method, headers: headers, body: item.body })
    } catch (e) {
      break // noch offline oder Zeitlimit — später weiter (der Schlüssel schützt vor Doppelbuchung)
    }

    if (response.ok) {
      await removeQueued(item.id)
      notifyClients({ type: 'BELEG_SYNCED', id: item.id, status: response.status })
    } else if (response.status === 401) {
      // Anmeldung abgelaufen: nichts markieren, nach dem neuen Login geht es weiter
      notifyClients({ type: 'SYNC_ANMELDUNG_NOETIG' })
      break
    } else if (response.status >= 500 || response.status === 408 || response.status === 429) {
      // Server gerade nicht bereit — der Eintrag bleibt offen, später erneut
      await aendereEintrag(item.id, function(e) { e.versuche = (e.versuche || 0) + 1 })
      notifyClients({ type: 'BELEG_SYNC_FEHLER', id: item.id, status: response.status })
      break
    } else {
      // Fachlich abgelehnt (400/403/404/409/422 …): stehen lassen, mit Grund markieren, nicht
      // automatisch wiederholen. Der Kassier entscheidet: erneut versuchen oder verwerfen.
      var meldung = await fehlerText(response)
      await aendereEintrag(item.id, function(e) {
        e.versuche = (e.versuche || 0) + 1
        e.fehler   = { status: response.status, meldung: meldung, am: Date.now() }
      })
      notifyClients({ type: 'BELEG_SYNC_FEHLER', id: item.id, status: response.status, meldung: meldung })
    }
  }
}

async function notifyClients(message) {
  var clients = await self.clients.matchAll({ includeUncontrolled: true })
  clients.forEach(function(client) { client.postMessage(message) })
}
