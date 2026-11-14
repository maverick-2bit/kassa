/**
 * Wächter für die Update-Kette (Prüfbericht 2026-11, Befund 4): Der In-App-Updater läuft als Root mit Docker-Zugriff und
 * darf nur installieren, was mit dem Schlüssel des Betreibers signiert ist; ein fehlgeschlagenes Update nimmt er zurück.
 *
 * Das Verhalten selbst prüfen die Shell-Tests (ops/updater/test-updater.sh: echte SSH-Signaturen, Docker-Attrappe, Mutations-
 * probe; ops/test-fernwartung.sh/.ps1: Installer). Dieser Test hält die tragenden Bausteine im Quelltext fest, damit sie nicht
 * stillschweigend verschwinden — er läuft überall (auch ohne git/ssh/docker) und in jedem Verify.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const WURZEL = fileURLToPath(new URL('../../../', import.meta.url))
const lies = (pfad: string) => readFileSync(join(WURZEL, pfad), 'utf8').replace(/\r\n/g, '\n')

describe('ops/updater/updater.sh: Herkunft und Rückweg', () => {
  const skript = lies('ops/updater/updater.sh')
  const ohneKommentare = skript.split('\n').filter((z) => !z.trim().startsWith('#')).join('\n')

  it('lädt nie die Spitze eines Branches und nutzt kein curl mehr (nur noch git über signierte Tags)', () => {
    expect(ohneKommentare).not.toMatch(/refs\/heads/)
    expect(ohneKommentare).not.toMatch(/archive\/refs/)
    expect(ohneKommentare).not.toMatch(/\bcurl\b/)
    expect(ohneKommentare).not.toMatch(/KASSA_BRANCH/)
  })

  it('prüft jedes Release per git verify-tag mit SSH-Signatur gegen die INSTALLIERTE allowed_signers', () => {
    expect(ohneKommentare).toContain('verify-tag')
    expect(ohneKommentare).toContain('gpg.format=ssh')
    // Vertrauensdatei = Datei des installierten Stands (Workspace), nicht des frisch geladenen Quellcodes
    expect(skript).toMatch(/ALLOWED_SIGNERS="\$\{KASSA_ALLOWED_SIGNERS:-\$WORKSPACE\/ops\/updater\/allowed_signers\}"/)
    // erste Prüfung (Anker "M:signatur") benutzt genau diese Datei
    const signaturZeile = skript.split('\n').find((z) => z.includes('# M:signatur')) ?? ''
    expect(signaturZeile).toContain('gpg.ssh.allowedSignersFile=$ALLOWED_SIGNERS')
    expect(signaturZeile).toContain('verify-tag')
  })

  it('Reihenfolge in run_update: Herkunft prüfen → sichern → Marke → kopieren → bauen → auf gesundes Backend warten', () => {
    const lauf = skript.slice(skript.indexOf('run_update() {'), skript.indexOf('wiederaufnehmen() {'))
    const pos = (s: string) => {
      const i = lauf.indexOf(s)
      expect(i, `fehlt in run_update: ${s}`).toBeGreaterThan(0)
      return i
    }
    const reihenfolge = [
      pos('hole_release "$_tmp" "$_installiert"'),
      pos('sichere_vorher "$_installiert"'),
      pos('> "$RUECKWEG/offen"'),
      pos('spiegeln "$QUELLE" "$WORKSPACE"'),
      pos('compose up -d --build $_dienste'),
      pos('warte_auf_backend "$ZIEL_VERSION"'),
    ]
    expect(reihenfolge).toEqual([...reihenfolge].sort((a, b) => a - b))
  })

  it('der Rückweg liegt NICHT im geteilten Kontroll-Volume (das auch das Backend beschreiben darf)', () => {
    const vorgabe = skript.match(/^RUECKWEG="([^"]*)"/m)?.[1] ?? ''
    expect(vorgabe).toContain('/var/lib/kassa-rueckweg')
    expect(vorgabe).not.toContain('CONTROL')
    expect(vorgabe).not.toContain('control')
  })

  it('der Hauptblock steht GANZ AM ENDE als einzelner Befehl (die Shell liest das Skript, während es sich selbst ersetzt)', () => {
    const zeilen = skript.split('\n').filter((z) => z.trim() !== '')
    expect(zeilen[zeilen.length - 1]).toBe('if [ -z "${KASSA_UPDATER_NUR_FUNKTIONEN:-}" ]; then haupt; fi')
  })

  it('nimmt nichts vom Backend an: keine Befehle/Parameter aus der request-Datei', () => {
    expect(ohneKommentare).not.toMatch(/\$\(\s*cat\s+"\$CONTROL\/request"/)
    expect(ohneKommentare).not.toMatch(/\.\s+"\$CONTROL/)
    expect(ohneKommentare).not.toMatch(/eval\b/)
  })
})

describe('ops/updater/allowed_signers (Prüfschlüssel)', () => {
  const datei = lies('ops/updater/allowed_signers')
  const zeilen = datei.split('\n').filter((z) => z.trim() !== '' && !z.startsWith('#'))

  it('enthält Arbeits- und Reserveschlüssel, jeder nur für git-Signaturen (namespaces="git"), ssh-ed25519', () => {
    expect(zeilen.length).toBeGreaterThanOrEqual(2)
    for (const z of zeilen) {
      expect(z).toMatch(/^[A-Za-z0-9._-]+ namespaces="git" ssh-ed25519 AAAA[A-Za-z0-9+/=]+( .*)?$/)
    }
    expect(datei).toContain('kassa-release ')
    expect(datei).toContain('kassa-release-reserve ')
  })

  it('wird ausdrücklich mit LF-Zeilenenden ausgeliefert (.gitattributes)', () => {
    expect(lies('.gitattributes')).toMatch(/^ops\/updater\/allowed_signers text eol=lf$/m)
  })
})

describe('docker-compose.yml: Updater-Dienst', () => {
  const compose = lies('docker-compose.yml')
  const block = compose.slice(compose.indexOf('\n  updater:'), compose.indexOf('\n  # ── Reverse-Proxy'))

  it('hat keine Branch-Einstellung mehr, und das Skript ist schreibgeschützt eingehängt', () => {
    expect(block).not.toContain('KASSA_BRANCH')
    expect(block).toContain('./ops/updater/updater.sh:/updater.sh:ro')
  })

  it('der Docker-Socket ist genau einmal gemountet — im Updater, nirgends sonst', () => {
    // eine Zeile „- /var/run/docker.sock:/var/run/docker.sock" (Quelle und Ziel stehen beide darin)
    expect(compose.split('\n').filter((z) => z.includes('/var/run/docker.sock:')).length).toBe(1)
    expect(block).toContain('- /var/run/docker.sock:/var/run/docker.sock')
  })
})

describe('Backend: Versionsanzeige folgt den Release-Tags, nicht master', () => {
  const route = lies('packages/backend/src/routes/system.route.ts')
  it('liest die Tags (matching-refs/tags/v) und nicht package.json von master', () => {
    expect(route).toContain('git/matching-refs/tags/v')
    expect(route).not.toContain('KASSA_BRANCH')
    expect(route).not.toMatch(/raw\.githubusercontent\.com[^\n]*package\.json/)
  })
})

describe('Installer und Einzeiler: nie die Spitze von master', () => {
  const dateien = [
    'ops/install.sh', 'ops/install.ps1', 'ops/erstelle-offline-paket.ps1',
    'ops/Kassa-Setup.cmd', 'ops/Kassa-Setup.command', 'ops/DEPLOYMENT.md',
  ]
  it.each(dateien)('%s: keine Adresse auf master', (datei) => {
    const text = lies(datei)
    expect(text).not.toMatch(/raw\.githubusercontent\.com\/maverick-2bit\/kassa\/master/)
    expect(text).not.toMatch(/archive\/refs\/heads\/master/)
  })

  it('die Einzeiler und Wrapper holen das neueste Release-Tag (matching-refs/tags/v)', () => {
    for (const datei of ['ops/install.ps1', 'ops/Kassa-Setup.cmd', 'ops/Kassa-Setup.command', 'ops/DEPLOYMENT.md']) {
      expect(lies(datei), datei).toContain('git/matching-refs/tags/v')
    }
  })
})

describe('Release-Verfahren: Signatur wird geprüft, bevor ein Release unbemerkt ins Leere läuft', () => {
  it('ein Workflow prüft jedes neue Tag vX.Y.Z mit ops/release/pruefe-release.sh (inkl. --master)', () => {
    const workflow = lies('.github/workflows/release-pruefung.yml')
    expect(workflow).toMatch(/tags:\s*\['v\*'\]/)
    expect(workflow).toContain('ops/release/pruefe-release.sh')
    expect(workflow).toContain('--master')
    expect(workflow).toMatch(/fetch-depth:\s*0/)
  })

  it('die CI führt die Updater-Tests samt Mutationsprobe aus', () => {
    const ci = lies('.github/workflows/ci.yml')
    expect(ci).toContain('sh ops/updater/test-updater.sh')
    expect(ci).toContain('sh ops/updater/test-updater.sh mutationen')
  })

  it('alle Bausteine sind da', () => {
    for (const datei of ['ops/release/pruefe-release.sh', 'ops/updater/test-updater.sh', 'ops/updater/allowed_signers', 'ops/updater/updater.sh']) {
      expect(existsSync(join(WURZEL, datei)), datei).toBe(true)
    }
  })

  it('ops/DEPLOYMENT.md beschreibt Herkunft, Rückweg, Schlüssel und den Übergang (Abschnitt 11)', () => {
    const doku = lies('ops/DEPLOYMENT.md')
    for (const stichwort of ['## 11. Update-Kette', '### 11.1', '### 11.2', '### 11.3', '### 11.4 Übergang', 'Reserveschlüssel', 'git tag -s']) {
      expect(doku, stichwort).toContain(stichwort)
    }
  })
})
