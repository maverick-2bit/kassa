/**
 * Wächter für die Zugriffsrechte des Installationsordners (ops/install.ps1, ops/install-offline.ps1).
 *
 * Ein Ordner direkt unter C:\ erbt "Authentifizierte Benutzer: Ändern". Im Installationsordner liegen die .env
 * (JWT_SECRET, MASTER_PASSPHRASE, Datenbank-Passwort) und ops\updater\updater.sh — das Skript läuft im
 * Update-Dienst als Root mit Zugriff auf den Docker-Socket. Jedes lokale Windows-Konto konnte die Geheimnisse
 * lesen oder das Skript ändern. Die Installer schränken den Ordner deshalb auf SYSTEM, Administratoren und das
 * installierende Benutzerkonto ein (Docker Desktop läuft unter diesem Konto; die Gruppe "Administratoren"
 * zählt in einem nicht erhöhten Prozess nicht).
 *
 * Das Verhalten selbst (Rechte vor/nach, Zugriff des normalen Prozesses, Vererbung auf neue Dateien) ist auf
 * Windows PowerShell 5.1 von Hand geprüft; dieser Test hält die Bausteine im Skript fest, damit sie nicht
 * stillschweigend verschwinden — er läuft überall, auch ohne Windows.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const WURZEL = fileURLToPath(new URL('../../../', import.meta.url))
const lies = (pfad: string) => readFileSync(join(WURZEL, pfad), 'utf8').replace(/\r\n/g, '\n')

describe.each(['ops/install.ps1', 'ops/install-offline.ps1'])('%s: Ordnerrechte', (datei) => {
  const skript = lies(datei)
  const funktion = skript.slice(
    skript.indexOf('function Schuetze-Installationsordner'),
    skript.indexOf('\n}\n', skript.indexOf('function Schuetze-Installationsordner')) + 3,
  )

  it('hat die Funktion', () => {
    expect(funktion).toContain('function Schuetze-Installationsordner')
    expect(funktion.length).toBeGreaterThan(200)
  })

  it('kappt die Vererbung und vergibt Rechte nur an SYSTEM, Administratoren und den installierenden Benutzer (als SID)', () => {
    expect(funktion).toContain('/inheritance:r')
    expect(funktion).toContain('/grant:r')
    expect(funktion).toContain("'*S-1-5-18:(OI)(CI)F'")        // SYSTEM
    expect(funktion).toContain("'*S-1-5-32-544:(OI)(CI)F'")    // Administratoren (sprachunabhängig)
    expect(funktion).toMatch(/WindowsIdentity\]::GetCurrent\(\)\.User\.Value/)   // der installierende Benutzer
    expect(funktion).toContain('(OI)(CI)M')
  })

  it('vergibt nichts an Authentifizierte Benutzer, Benutzer oder Jeden — auch nicht per Name', () => {
    const rechte = skript.slice(skript.indexOf('function Schuetze-Installationsordner'))
      .split('\n').filter(z => /grant|icacls/.test(z) && !z.trim().startsWith('#')).join('\n')
    for (const verboten of ['S-1-5-11', 'S-1-5-32-545', 'S-1-1-0', 'Authenticated', 'Authentifizierte', 'Everyone', 'Jeder', 'Users']) {
      expect(rechte, verboten).not.toContain(verboten)
    }
  })

  it('setzt bestehende Inhalte auf die neue Vererbung zurück (Update einer älteren Installation)', () => {
    expect(funktion).toMatch(/icacls\.exe \(Join-Path \$Ordner '\*'\) \/reset \/T/)
  })

  it('läuft vor dem Kopieren des Codes und der .env-Erzeugung — die erben die Rechte dann von Anfang an', () => {
    const aufruf = skript.indexOf('\nSchuetze-Installationsordner $Ziel')
    expect(aufruf, 'Aufruf fehlt').toBeGreaterThan(0)
    expect(aufruf).toBeLessThan(skript.indexOf('robocopy $'))
    expect(aufruf).toBeLessThan(skript.indexOf('Set-Content -Path $envDatei'))
    // und vor dem ersten Docker-Befehl, der den Ordner liest (Build bzw. Image-Import)
    const docker = skript.search(/^\s*(docker compose up -d --build|docker load -i)/m)   // der Befehl selbst, nicht der Kommentar darüber
    expect(docker, 'Docker-Befehl nicht gefunden').toBeGreaterThan(0)
    expect(aufruf).toBeLessThan(docker)
  })

  it('ein Fehler beim Setzen der Rechte bricht die Installation nicht ab (nur Hinweis)', () => {
    expect(funktion).toMatch(/catch \{[\s\S]*Hinweis/)
  })

  it('startet der Installer als SYSTEM, nimmt er den Benutzer an der Konsole — ohne einen Benutzer ändert er nichts', () => {
    expect(funktion).toContain("-eq 'S-1-5-18'")
    expect(funktion).toContain('Finde-InteraktivenBenutzerSid')
    expect(funktion).toMatch(/if \(-not \$sid\)[\s\S]*return/)
  })
})
