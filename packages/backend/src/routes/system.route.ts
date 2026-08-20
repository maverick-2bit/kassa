/**
 * System-Routen — Versions-/Update-Verwaltung für den In-App-Updater.
 *
 *  GET  /system/status  (auth) — installierte Version, neueste bekannte Version
 *                          (GitHub), ob ein Update verfügbar ist, ob der Updater-
 *                          Dienst läuft, sowie der aktuelle Update-Status.
 *  POST /system/update  (admin) — löst das Update aus: legt die „request"-Datei im
 *                          geteilten Kontroll-Volume an, die der Updater-Dienst
 *                          abholt. 409 wenn kein Updater-Dienst läuft.
 *
 * Das Backend startet oder baut hier NICHTS selbst — es gibt nur das Startsignal.
 * Den eigentlichen Rebuild macht der abgeschottete 'updater'-Container.
 */

import type { FastifyPluginAsync } from 'fastify'
import { createRequire } from 'module'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const require = createRequire(import.meta.url)
const { version: INSTALLIERT } = require('../../package.json') as { version: string }

const CONTROL_DIR = process.env.UPDATE_CONTROL_DIR ?? '/control'
const BRANCH      = process.env.KASSA_BRANCH ?? 'master'
const GITHUB_VERSION_URL = `https://raw.githubusercontent.com/maverick-2bit/kassa/${BRANCH}/package.json`

// Neueste Version von GitHub — kurz gecacht, damit nicht jeder Statusaufruf fetcht.
let cache: { version: string | null; geprueft: number } = { version: null, geprueft: 0 }
const CACHE_MS = 10 * 60_000

async function holeNeuesteVersion(frisch = false): Promise<string | null> {
  const jetzt = Date.now()
  if (!frisch && cache.version && jetzt - cache.geprueft < CACHE_MS) return cache.version
  try {
    // frisch: eindeutige Query als Cache-Buster gegen das GitHub-CDN — sonst
    // kann auch eine erzwungene Prüfung noch minutenlang den alten Stand sehen.
    const url = frisch ? `${GITHUB_VERSION_URL}?frisch=${jetzt}` : GITHUB_VERSION_URL
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return cache.version
    const pkg = (await res.json()) as { version?: string }
    if (pkg.version) cache = { version: pkg.version, geprueft: jetzt }
    return cache.version
  } catch {
    return cache.version // offline → letzter bekannter Wert (oder null)
  }
}

/** Semver-ähnlicher Vergleich: ist a echt neuer als b? */
function istNeuer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** Läuft der Updater-Dienst? (frischer Heartbeat < 30 s im Kontroll-Volume) */
async function updaterLaeuft(): Promise<boolean> {
  try {
    const hb = await readFile(join(CONTROL_DIR, 'heartbeat'), 'utf8')
    const alter = Date.now() - new Date(hb.trim()).getTime()
    return Number.isFinite(alter) && alter >= 0 && alter < 30_000
  } catch {
    return false
  }
}

async function leseUpdateStatus(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(CONTROL_DIR, 'status.json'), 'utf8'))
  } catch {
    return { status: 'idle' }
  }
}

export const systemRoute: FastifyPluginAsync = async (fastify) => {
  const guard     = { onRequest: [fastify.authenticate] }
  const adminOnly = { onRequest: [fastify.requireRolle('admin')] }

  fastify.get('/system/status', guard, async (request) => {
    // ?frisch=1 (Knopf „Nach Updates suchen"): Caches umgehen — im Eventbetrieb
    // darf eine dringende Umstellung nicht an der 10-Minuten-Anzeige hängen.
    const frisch = (request.query as { frisch?: string }).frisch === '1'
    const [neueste, updaterVerfuegbar, update] = await Promise.all([
      holeNeuesteVersion(frisch),
      updaterLaeuft(),
      leseUpdateStatus(),
    ])
    return {
      installiert:       INSTALLIERT,
      neueste:           neueste ?? null,
      updateVerfuegbar:  !!neueste && istNeuer(neueste, INSTALLIERT),
      updaterVerfuegbar,
      update,
    }
  })

  // LAN-Adressen des Servers — für die Geräte-Seite (QR-Codes für Handys &
  // Displays). Am Kassen-Rechner selbst heißt der Browser-Host oft nur
  // „localhost"; ein QR mit localhost wäre für jedes andere Gerät wertlos.
  fastify.get('/system/netzwerk', guard, async () => {
    // Im Container sieht os.networkInterfaces() NUR die Docker-Bridge (172.x) —
    // die LAN-IP des Wirts ist von hier aus prinzipiell nicht ermittelbar.
    // Dann lieber ehrlich leer melden, als eine falsche Adresse in QR-Codes zu
    // gießen (Test-PC-Befund: „Kassa am Handy funktioniert nicht").
    const { existsSync } = await import('node:fs')
    if (existsSync('/.dockerenv')) {
      return { ips: [], imContainer: true }
    }
    const os = await import('node:os')
    const ips: string[] = []
    for (const [name, schnittstellen] of Object.entries(os.networkInterfaces())) {
      // Virtuelle Adapter aussortieren (Docker-Bridge, WSL/Hyper-V-Switch,
      // VirtualBox) — deren Adressen erreicht vom Handy aus niemand. Erkennung
      // über den Interface-NAMEN, nicht über den Adressbereich: 172.16/12 kann
      // auch ein echtes Firmen-LAN sein.
      if (/vethernet|wsl|docker|virtualbox|vmware|hyper-v|loopback/i.test(name)) continue
      for (const s of schnittstellen ?? []) {
        if (s.family === 'IPv4' && !s.internal && !s.address.startsWith('172.17.')) {
          ips.push(s.address)
        }
      }
    }
    return { ips, imContainer: false }
  })

  fastify.post('/system/update', adminOnly, async (_request, reply) => {
    if (!(await updaterLaeuft())) {
      return reply.status(409).send({
        fehler:
          'Update-Dienst nicht aktiv. Bitte einmal das Setup (Kassa-Setup) erneut ausführen — ' +
          'es fügt den Update-Dienst hinzu; danach funktioniert „Jetzt aktualisieren" per Klick.',
      })
    }
    try {
      await writeFile(join(CONTROL_DIR, 'request'), `${new Date().toISOString()}\n`, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EACCES' || code === 'EPERM') {
        return reply.status(500).send({
          fehler:
            'Update konnte nicht angefordert werden: kein Schreibrecht am Update-Volume (EACCES). ' +
            'Auf dem Kassen-PC einmal ausführen: docker compose -p kassa exec updater chown -R 1000:1000 /control ' +
            '— ab v0.7.124 repariert der Update-Dienst die Berechtigung bei jedem Start selbst.',
        })
      }
      return reply.status(500).send({
        fehler: 'Update konnte nicht angefordert werden: ' + (err instanceof Error ? err.message : String(err)),
      })
    }
    return reply.status(202).send({ angefordert: true })
  })
}
