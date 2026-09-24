// Echo-"Backend" fuer den Client-IP-Verhaltenstest (ops/nginx/client-ip-test/test.sh).
// Antwortet auf jede Anfrage mit den Headern, die das echte Backend fuer
// Rate-Limit und Audit auswertet. Bewusst reines ASCII: die Datei wird auch
// per Zwischenablage auf Test-PCs uebertragen.
const http = require('http')

http.createServer((anfrage, antwort) => {
  const r = {
    pfad:     anfrage.url,
    xRealIp:  anfrage.headers['x-real-ip'] || null,
    xff:      anfrage.headers['x-forwarded-for'] || null,
    cf:       anfrage.headers['cf-connecting-ip'] || null,
    absender: anfrage.socket.remoteAddress,
  }
  console.log(JSON.stringify(r))
  antwort.writeHead(200, { 'content-type': 'application/json' })
  antwort.end(JSON.stringify(r))
}).listen(3000, () => console.log('echo bereit'))
