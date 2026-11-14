/**
 * Wächter für „HTTPS im LAN" (Docker-Dienst lan-https, ops/caddy/Caddyfile.lan).
 *
 * Caddy betreibt dort eine eigene Zertifizierungsstelle; im selben Ordner wie das
 * öffentliche Stammzertifikat liegt ihr PRIVATER Schlüssel. Der Test hält fest:
 *  - ausgeliefert wird nur root.crt (fester Pfad, kein freier Dateizugriff auf den CA-Ordner)
 *  - Caddy greift nie in einen Vertrauensspeicher ein und holt keine öffentlichen Zertifikate
 *  - jede App wird über ihren Caddy-Eingang 8090 erreicht (Client-IP, nginx-client-ip.test.ts)
 *  - Compose: eigenes Profil, Wächter gegen leere KASSA_LAN_IP, CA-Volume
 *  - Installer und Offline-Paket kennen den Dienst
 * Die Port-Tabelle selbst prüft packages/frontend/src/lib/geraeteAdressen.test.ts.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const WURZEL = fileURLToPath(new URL('../../../', import.meta.url))
const lies = (pfad: string) => readFileSync(join(WURZEL, pfad), 'utf8').replace(/\r\n/g, '\n')

const caddy = lies('ops/caddy/Caddyfile.lan')
const ohneKommentare = caddy.split('\n').filter(z => !z.trim().startsWith('#')).join('\n')

describe('Caddyfile.lan', () => {
  it('liefert aus dem CA-Ordner nur das Stammzertifikat', () => {
    const block = ohneKommentare.match(/handle \/kassa-ca\.crt \{([\s\S]*?)\n\t\}/)
    expect(block, 'handle /kassa-ca.crt fehlt').not.toBeNull()
    expect(block![1]).toMatch(/rewrite \* \/root\.crt/)
    expect(block![1]).toMatch(/file_server/)
    // Der CA-Ordner taucht nur in diesem einen Block auf
    const vorkommen = ohneKommentare.split('pki/authorities/local').length - 1
    expect(vorkommen).toBe(1)
    expect(ohneKommentare).not.toMatch(/root\.key|intermediate\.key|browse/)
  })

  it('keine Eingriffe in Vertrauensspeicher, keine öffentliche CA, kein Redirect auf Port 80', () => {
    expect(ohneKommentare).toMatch(/^\tskip_install_trust$/m)
    expect(ohneKommentare).toMatch(/^\tauto_https disable_redirects$/m)
    expect(ohneKommentare).toMatch(/^\tdefault_sni \{\$KASSA_LAN_IP\}$/m)
    expect(ohneKommentare).not.toMatch(/acme|email/i)
    expect(ohneKommentare).toMatch(/\(app\) \{\n\ttls internal\n/)
  })

  it('jede App über ihren Caddy-Eingang 8090', () => {
    const ziele = [...ohneKommentare.matchAll(/reverse_proxy (\S+)/g)].map(m => m[1])
    expect(ziele).toEqual(['{args[0]}:8090'])
    const apps = [...ohneKommentare.matchAll(/import app (\w+)/g)].map(m => m[1]).sort()
    expect(apps).toEqual(['einlass', 'frontend', 'kds', 'kellner', 'terminal'])
  })

  it('die Einrichtungsseite läuft über http (das Gerät vertraut der CA vorher noch nicht)', () => {
    expect(ohneKommentare).toMatch(/^http:\/\/:9079 \{$/m)
    expect(lies('ops/caddy/lan/index.html')).toContain('href="/kassa-ca.crt"')
  })
})

describe('docker-compose.yml: Dienst lan-https', () => {
  const compose = lies('docker-compose.yml')
  const dienst  = compose.slice(compose.indexOf('\n  lan-https:'), compose.indexOf('\nvolumes:'))

  it('nur mit Profil, mit eigener Konfiguration und CA-Volume', () => {
    expect(dienst).toMatch(/profiles: \["lan-https"\]/)
    expect(dienst).toContain('./ops/caddy/Caddyfile.lan:/etc/caddy/Caddyfile:ro')
    expect(dienst).toContain('./ops/caddy/lan:/srv/kassa-lan:ro')
    expect(dienst).toContain('lan_https_data:/data')
    expect(compose).toMatch(/\nvolumes:[\s\S]*\n  lan_https_data:\n/)
  })

  it('startet nicht ohne KASSA_LAN_IP (sonst Zertifikat für die falsche Adresse)', () => {
    expect(dienst).toContain('KASSA_LAN_IP: ${KASSA_LAN_IP:-}')
    expect(dienst).toMatch(/\[ -n "\$\$KASSA_LAN_IP" \] \|\| \{[^}]*exit 1; \}; exec caddy run/)
  })

  it('Ports nur für die Apps des Personals (kein 80/443 — die gehören Kasse bzw. Proxy-Profil)', () => {
    const ports = [...dienst.matchAll(/- "(\d+):\d+"/g)].map(m => Number(m[1]))
    expect(ports).not.toContain(80)
    expect(ports).not.toContain(443)
  })
})

describe('Installer und Offline-Paket', () => {
  it('beide Windows-Installer laden ops\\lan-https.ps1 und öffnen die Ports nur bei aktivem Dienst', () => {
    for (const datei of ['ops/install.ps1', 'ops/install-offline.ps1']) {
      const t = lies(datei)
      expect(t, datei).toContain("Join-Path $Ziel 'ops\\lan-https.ps1'")
      expect(t, datei).toContain('Initialize-LanHttps -EnvDatei $envDatei -Erstinstallation:$erstinstallation')
      expect(t, datei).toMatch(/if \(\$lanHttpsAktiv\) \{ foreach \(\$eintrag in \$LanHttpsPorts\.GetEnumerator\(\)\)/)
      // erst NACH dem Merken, ob die .env neu ist
      expect(t.indexOf('$erstinstallation = -not (Test-Path $envDatei)')).toBeLessThan(t.indexOf("Schritt 'Erzeuge .env"))
    }
  })

  it('Update überschreibt eine eingetragene IP nie (nur Hinweis)', () => {
    const ps1 = lies('ops/lan-https.ps1')
    const sh  = lies('ops/install.sh')
    expect(ps1).toMatch(/elseif \(\$ip -and \$ip -ne \$eingetragen\) \{\n(\s+Hinweis[^\n]*\n){3}\s+\}/)
    expect(sh).toMatch(/elif \[ -n "\$LAN_IP_ERKANNT" \] && \[ "\$LAN_IP_ERKANNT" != "\$eingetragen" \]; then\n(\s+hinweis[^\n]*\n){2}\s+fi/)
  })

  it('das Offline-Paket enthält das Caddy-Image (sonst scheitert die Erstinstallation ohne Internet)', () => {
    expect(lies('ops/erstelle-offline-paket.ps1')).toContain('docker compose --profile lan-https config --images')
  })

  it('.env.example beschreibt die Schalter (auskommentiert)', () => {
    const env = lies('.env.example')
    expect(env).toMatch(/^# COMPOSE_PROFILES=lan-https$/m)
    expect(env).toMatch(/^# KASSA_LAN_IP=/m)
    expect(env).not.toMatch(/^COMPOSE_PROFILES=/m)
  })
})
