/**
 * Wächter für die Client-IP-Kette nginx → Backend (Rate-Limit, Audit).
 *
 * Das Backend glaubt X-Real-IP ungeprüft (getClientIp) — das ist nur sicher,
 * solange JEDER App-nginx den Header auf JEDEM Weg zum Backend überschreibt.
 * Eine vergessene location (neue App, neuer SSE-Pfad) reichte einen vom
 * Client mitgeschickten X-Real-IP durch, und jeder Wert bekäme einen eigenen
 * Zähler. Dieser Test liest deshalb alle packages/<app>/nginx.conf und prüft:
 *  - der Client-IP-Block ist überall identisch (eine Quelle der Wahrheit)
 *  - jede App lauscht auf 80 (direkt), 8090 (Caddy), 8091 (Tunnel)
 *  - jede location mit proxy_pass setzt X-Real-IP UND X-Forwarded-For auf
 *    $kassa_client_ip; kein Rest der alten, fälschbaren Varianten
 *  - Caddy zeigt auf den Caddy-Eingang, die Tunnel-Anleitung auf den Tunnel-Eingang
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const WURZEL = fileURLToPath(new URL('../../../', import.meta.url))
const lies = (pfad: string) => readFileSync(join(WURZEL, pfad), 'utf8').replace(/\r\n/g, '\n')

const APPS = readdirSync(join(WURZEL, 'packages'))
  .filter(app => existsSync(join(WURZEL, 'packages', app, 'nginx.conf')))
  .sort()

const BLOCK_START = '# ── Client-IP je Eingang'
const BLOCK_ENDE  = '# ── Ende Client-IP'

function clientIpBlock(text: string): string | null {
  const start = text.indexOf(BLOCK_START)
  const ende  = text.indexOf(BLOCK_ENDE)
  return start >= 0 && ende > start ? text.slice(start, text.indexOf('\n', ende)) : null
}

/** nginx-Kommentare entfernen (# außerhalb von Anführungszeichen). */
function ohneKommentare(text: string): string {
  return text.split('\n').map(zeile => {
    let quote: string | null = null
    for (let i = 0; i < zeile.length; i++) {
      const c = zeile[i]
      if (quote) { if (c === quote && zeile[i - 1] !== '\\') quote = null }
      else if (c === '"' || c === "'") quote = c
      else if (c === '#') return zeile.slice(0, i)
    }
    return zeile
  }).join('\n')
}

/** Alle location-Blöcke (Kopf + Rumpf, per Klammerzählung). */
function locations(text: string): Array<{ kopf: string; rumpf: string }> {
  const ergebnis: Array<{ kopf: string; rumpf: string }> = []
  const re = /\blocation\s+([^{]*)\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let tiefe = 1
    let i = re.lastIndex
    for (; i < text.length && tiefe > 0; i++) {
      if (text[i] === '{') tiefe++
      else if (text[i] === '}') tiefe--
    }
    ergebnis.push({ kopf: m[1]!.trim(), rumpf: text.slice(re.lastIndex, i - 1) })
  }
  return ergebnis
}

const setztHeader = (rumpf: string, header: string) =>
  new RegExp(`proxy_set_header\\s+${header}\\s+\\$kassa_client_ip\\s*;`, 'i').test(rumpf)

describe('nginx: Client-IP je Eingang (Grundlage des Rate-Limits je Client)', () => {
  it('findet alle neun Apps mit eigenem nginx', () => {
    expect(APPS).toEqual([
      'abholmonitor', 'einlass', 'frontend', 'gast', 'kds', 'kellner', 'kundendisplay', 'terminal', 'tickets',
    ])
  })

  it('der Client-IP-Block ist in allen Apps identisch und vertraut je Eingang genau einer Angabe', () => {
    const vorlage = clientIpBlock(lies('packages/frontend/nginx.conf'))
    expect(vorlage).not.toBeNull()
    for (const app of APPS) {
      expect(clientIpBlock(lies(`packages/${app}/nginx.conf`)), `${app}: Block fehlt oder weicht ab`).toBe(vorlage)
    }
    const code = ohneKommentare(vorlage!)
    // direkt → Absender; 8090 → X-Forwarded-For (Caddy); 8091 → CF-Connecting-IP (Tunnel)
    expect(code).toMatch(/map \$server_port \$kassa_client_ip \{\s*default\s+\$remote_addr;\s*8090\s+\$kassa_ip_caddy;\s*8091\s+\$kassa_ip_tunnel;\s*\}/)
    expect(code).toMatch(/map \$http_x_forwarded_for \$kassa_ip_caddy \{\s*default\s+\$remote_addr;/)
    expect(code).toMatch(/map \$http_cf_connecting_ip \$kassa_ip_tunnel \{\s*default\s+\$remote_addr;/)
    // X-Real-IP des Clients darf nie Quelle sein
    expect(code).not.toMatch(/\$http_x_real_ip/)
  })

  for (const app of APPS) {
    describe(app, () => {
      const text = ohneKommentare(lies(`packages/${app}/nginx.conf`))

      it('lauscht direkt (80), für Caddy (8090) und für den Tunnel (8091)', () => {
        for (const port of [80, 8090, 8091]) expect(text).toMatch(new RegExp(`\\blisten\\s+${port}\\s*;`))
      })

      it('jede location zum Backend überschreibt X-Real-IP und X-Forwarded-For', () => {
        const zumBackend = locations(text).filter(l => /\bproxy_pass\b/.test(l.rumpf))
        expect(zumBackend.length, 'keine location mit proxy_pass gefunden').toBeGreaterThan(0)
        for (const l of zumBackend) {
          expect(setztHeader(l.rumpf, 'X-Real-IP'), `${app} location ${l.kopf}: X-Real-IP`).toBe(true)
          expect(setztHeader(l.rumpf, 'X-Forwarded-For'), `${app} location ${l.kopf}: X-Forwarded-For`).toBe(true)
        }
      })

      it('enthält keine fälschbaren Reste (X-Real-IP $remote_addr, $proxy_add_x_forwarded_for)', () => {
        expect(text).not.toMatch(/\$proxy_add_x_forwarded_for/)
        expect(text).not.toMatch(/X-Real-IP\s+\$remote_addr/i)
      })
    })
  }

  it('Caddy leitet jede App auf ihren Caddy-Eingang (8090)', () => {
    const ziele = [...ohneKommentare(lies('ops/caddy/Caddyfile')).matchAll(/reverse_proxy\s+(\S+)/g)].map(m => m[1]!)
    expect(ziele.length).toBe(APPS.length)
    for (const ziel of ziele) expect(ziel, `Caddy-Ziel ${ziel}`).toMatch(/^[a-z]+:8090$/)
  })

  it('die Tunnel-Anleitung nennt den Tunnel-Eingang (8091), nicht Port 80', () => {
    for (const datei of ['docker-compose.yml', '.env.example']) {
      const text = lies(datei)
      expect(text, datei).toMatch(/tickets\.<domain> → http:\/\/tickets:8091/)
      expect(text, datei).toMatch(/einlass\.<domain> → http:\/\/einlass:8091/)
      expect(text, datei).not.toMatch(/http:\/\/(tickets|einlass):80\b/)
    }
  })
})
