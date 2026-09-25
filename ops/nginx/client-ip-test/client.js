// Pruef-Client fuer den Client-IP-Verhaltenstest (ops/nginx/client-ip-test/test.sh).
// Laeuft im selben Docker-Netz wie die App-nginx (Aliase frontend, kellner, ...),
// das Echo-Backend (Alias backend) und Caddy (Alias caddy, KASSA_DOMAIN=ipt.localhost).
// Prueft je App und Eingang, welche Client-IP beim Backend ankommt:
//   :80   direkt  -> eigene Adresse, egal was an Headern mitkommt
//   :8090 Caddy   -> letzter X-Forwarded-For-Eintrag
//   :8091 Tunnel  -> CF-Connecting-IP
//   Caddy (echte Caddyfile) -> eigene Adresse, gefaelschte Header wirkungslos
// Dazu Cache-Header: index.html und sw.js nie ungefragt aus dem HTTP-Cache,
// gehashte Schriften dagegen ein Jahr.
// Exit-Code 1, sobald eine Pruefung fehlschlaegt. Bewusst reines ASCII (wird
// auch per Zwischenablage auf Test-PCs uebertragen).
const http = require('http')
const https = require('https')
const os = require('os')

const eigen = Object.values(os.networkInterfaces()).flat()
  .find(i => i.family === 'IPv4' && !i.internal).address
const ergebnisse = []

function hole(o) {
  return new Promise(fertig => {
    const lib = o.https ? https : http
    const req = lib.request({
      host: o.host, port: o.port, path: o.path, headers: o.headers, servername: o.servername,
      rejectUnauthorized: false, timeout: 8000,
    }, r => {
      let text = ''
      r.on('data', d => { text += d })
      r.on('end', () => {
        try { fertig({ status: r.statusCode, body: JSON.parse(text) }) }
        catch (e) { fertig({ status: r.statusCode, roh: text.slice(0, 60) }) }
      })
    })
    req.on('error', e => fertig({ status: 0, fehler: e.message }))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

function holeKopf(host, pfad) {
  return new Promise(fertig => {
    const req = http.request({ host: host, port: 80, path: pfad, timeout: 8000 }, r => {
      r.resume()
      r.on('end', () => fertig({ status: r.statusCode, kopf: r.headers }))
    })
    req.on('error', e => fertig({ status: 0, fehler: e.message, kopf: {} }))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

// index.html und sw.js darf der Browser nie ungefragt aus seinem HTTP-Cache
// nehmen (ohne Cache-Control haelt er sie heuristisch tagelang fuer frisch) --
// sonst kommen neue Versionen bzw. Service-Worker-Updates erst spaeter an.
const NO_CACHE = (kopf, cc) =>
  /\bno-cache\b/.test(cc) && !/immutable|max-age=[1-9]/.test(cc) ? '' : 'soll no-cache'
// Gehashte Assets (Vite: /assets/<name>-<hash>.<ext>) aendern sich nie -- faellt
// eine Endung aus der Asset-Regel, landet sie in "location /" und damit bei no-cache.
const IMMUTABLE = (kopf, cc) =>
  /\bimmutable\b/.test(cc) && !/\bno-cache\b/.test(cc) ? '' : 'soll immutable'

async function pruefeKopf(name, host, pfad, test) {
  const r = await holeKopf(host, pfad)
  const cc = r.kopf['cache-control'] || ''
  const fehler = r.status !== 200 ? 'HTTP ' + r.status + (r.fehler ? ' ' + r.fehler : '') : test(r.kopf, cc)
  ergebnisse.push(!fehler)
  console.log((fehler ? 'FEHLER ' : 'OK     ') + name.padEnd(46) + ' -> cache-control: ' + (cc || '-') +
    (fehler ? '  (' + fehler + ')' : ''))
}

const GEFAELSCHT = { 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.7', 'cf-connecting-ip': '6.6.6.8' }

async function pruefe(name, o, soll) {
  let r = await hole(o)
  // Caddy/nginx brauchen nach dem Start einen Moment: Verbindungsfehler kurz wiederholen
  for (let versuch = 1; r.status === 0 && versuch <= 5; versuch++) {
    await new Promise(w => setTimeout(w, 1000))
    r = await hole(o)
  }
  const ist = r.body ? r.body.xRealIp : 'HTTP ' + r.status + ' ' + (r.fehler || r.roh || '')
  const ok = !!r.body && ist === soll && r.body.xff === soll
  ergebnisse.push(ok)
  console.log((ok ? 'OK     ' : 'FEHLER ') + name.padEnd(46) + ' -> ' + ist +
    (ok ? '' : '  (soll ' + soll + ', xff=' + (r.body && r.body.xff) + ')'))
}

// Jede location, die zum Backend fuehrt
const ZIELE = [
  ['frontend', '/api/x'], ['frontend', '/sse/x'], ['kellner', '/api/x'], ['kellner', '/sse/x'],
  ['kds', '/api/x'], ['kds', '/api/kds/events'], ['gast', '/api/gast/x'], ['terminal', '/api/terminal/x'],
  ['kundendisplay', '/api/x'], ['kundendisplay', '/sse/display'], ['abholmonitor', '/sse/abholung'],
  ['tickets', '/api/ticketshop/x'], ['einlass', '/api/einlass/x'],
]
// Alle Apps -- jede hat mindestens einen Weg zum Backend
const APPS = [...new Set(ZIELE.map(([app]) => app))]
// Subdomain der echten Caddyfile -> App + ein Backend-Pfad
const CADDY = {
  kasse: ['frontend', '/api/x'], kds: ['kds', '/api/x'], kundendisplay: ['kundendisplay', '/api/x'],
  gast: ['gast', '/api/gast/x'], kellner: ['kellner', '/api/x'], terminal: ['terminal', '/api/terminal/x'],
  abholmonitor: ['abholmonitor', '/sse/abholung'], tickets: ['tickets', '/api/ticketshop/x'],
  einlass: ['einlass', '/api/einlass/x'],
}

;(async () => {
  console.log('Pruef-Client (echter Absender): ' + eigen)
  for (const [app, p] of ZIELE) {
    await pruefe(app + ':80   ' + p + ' gefaelscht', { host: app, port: 80, path: p, headers: GEFAELSCHT }, eigen)
    await pruefe(app + ':8090 ' + p + ' Caddy-XFF', { host: app, port: 8090, path: p,
      headers: Object.assign({}, GEFAELSCHT, { 'x-forwarded-for': '6.6.6.7, 203.0.113.9' }) }, '203.0.113.9')
    await pruefe(app + ':8090 ' + p + ' ohne XFF', { host: app, port: 8090, path: p,
      headers: { 'x-real-ip': '6.6.6.6' } }, eigen)
    await pruefe(app + ':8091 ' + p + ' CF-IP', { host: app, port: 8091, path: p,
      headers: Object.assign({}, GEFAELSCHT, { 'cf-connecting-ip': '198.51.100.4' }) }, '198.51.100.4')
    await pruefe(app + ':8091 ' + p + ' ohne CF', { host: app, port: 8091, path: p,
      headers: { 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.7' } }, eigen)
  }
  for (const [sub, [, p]] of Object.entries(CADDY)) {
    const host = sub + '.ipt.localhost'
    await pruefe('Caddy ' + host + ' gefaelscht', { https: true, host: 'caddy', port: 443, servername: host,
      path: p, headers: Object.assign({ host: host }, GEFAELSCHT) }, eigen)
  }
  // Cache-Header: index.html in allen Apps, sw.js in den Apps mit Service Worker
  for (const app of APPS) {
    await pruefeKopf(app + ' / (index.html)', app, '/', NO_CACHE)
    await pruefeKopf(app + ' /tab/7 (Rueckfall auf index.html)', app, '/tab/7', NO_CACHE)
    await pruefeKopf(app + ' /assets/probe.woff2', app, '/assets/probe.woff2', IMMUTABLE)
  }
  for (const app of ['frontend', 'kellner']) {
    await pruefeKopf(app + ' /sw.js', app, '/sw.js', NO_CACHE)
  }
  // Frontend und KDS setzen no-cache per "expires": ein add_header in der location
  // wuerde die Security-Header des server-Blocks fuer index.html abschalten
  await pruefeKopf('frontend / behaelt CSP + X-Frame-Options', 'frontend', '/', kopf =>
    kopf['content-security-policy'] && kopf['x-frame-options'] === 'DENY' ? '' : 'Security-Header fehlen')
  await pruefeKopf('kds / behaelt X-Frame-Options + nosniff', 'kds', '/', kopf =>
    kopf['x-frame-options'] === 'DENY' && kopf['x-content-type-options'] === 'nosniff' ? '' : 'Security-Header fehlen')
  const ok = ergebnisse.filter(Boolean).length
  console.log('ERGEBNIS: ' + ok + '/' + ergebnisse.length + ' OK')
  process.exitCode = ok === ergebnisse.length ? 0 : 1
})()
