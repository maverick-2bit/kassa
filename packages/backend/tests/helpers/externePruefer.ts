/**
 * Aufruf der externen RKSV-Prüfer aus Backend-Tests (Burn-in, Integrationstest):
 *
 *  - Python-Zweitprüfer  scripts/rksv/dep7_pruefer.py   (nur Python 3 nötig)
 *  - BMF-Prüftool        scripts/rksv/bmf-pruefer.mjs   (Java; nur wenn BMF_PRUEFTOOL_DIR gesetzt ist)
 *
 * Beide bekommen denselben Export: DEP7 + cryptographicMaterialContainer.json im Format des BMF-Prüftools.
 * Eine ähnliche Fassung der Export-Hilfen gibt es für die rksv-Tests (packages/rksv/tests/helpers/pruef-export.ts) —
 * absichtlich getrennt, damit die Pakete keine Testhilfen voneinander importieren.
 */

import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const PYTHON_SKRIPT = join(REPO_WURZEL, 'scripts', 'rksv', 'dep7_pruefer.py')
const BMF_SKRIPT    = join(REPO_WURZEL, 'scripts', 'rksv', 'bmf-pruefer.mjs')

// ---------------------------------------------------------------------------
// Export schreiben
// ---------------------------------------------------------------------------

export interface PruefDateien {
  ordner:    string
  dep7:      string
  container: string
}

/**
 * Schreibt `dep-export.json` (DEP7) und `cryptographicMaterialContainer.json` (AES-Schlüssel + Zertifikat) in `ordner`.
 * Der Eintrag im Container ist über die Seriennummer erreichbar, wie sie im Beleg steht.
 */
export function schreibePruefDateien(ordner: string, dep7: unknown, aesSchluessel: Buffer, zertifikatDER: Buffer): PruefDateien {
  mkdirSync(ordner, { recursive: true })
  const id = new X509Certificate(zertifikatDER).serialNumber
  const container = {
    base64AESKey: aesSchluessel.toString('base64'),
    certificateOrPublicKeyMap: {
      [id]: { id, signatureDeviceType: 'CERTIFICATE', signatureCertificateOrPublicKey: zertifikatDER.toString('base64') },
    },
  }
  const dateien = { ordner, dep7: join(ordner, 'dep-export.json'), container: join(ordner, 'cryptographicMaterialContainer.json') }
  writeFileSync(dateien.dep7, JSON.stringify(dep7, null, 2))
  writeFileSync(dateien.container, JSON.stringify(container, null, 2))
  return dateien
}

// ---------------------------------------------------------------------------
// Python-Zweitprüfer
// ---------------------------------------------------------------------------

/** Erster funktionierender Python-3-Aufruf (Windows: Starter `py`; der Microsoft-Store-Platzhalter `python3` zählt nicht). */
export function findePython(): string[] | null {
  for (const kandidat of [['python3'], ['python'], ['py', '-3']]) {
    const r = spawnSync(kandidat[0]!, [...kandidat.slice(1), '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], { encoding: 'utf8' })
    if (r.status === 0) return kandidat
  }
  return null
}

export interface ZweitpruefBericht {
  geprueft: number
  signaturenGeprueft: number
  ausfallbelege: number
  verstoesseGesamt: number
  verstoesseJeRegel: Record<string, number>
  verstoesse: { beleg: number; regel: string; detail: string }[]
}

export interface ZweitpruefLauf { exit: number; bericht: ZweitpruefBericht | null; ausgabe: string }

export function fuehreZweitpruefungAus(dateien: PruefDateien, extra: string[] = []): ZweitpruefLauf {
  const python = findePython()
  if (!python) throw new Error('Kein Python 3 gefunden')
  const berichtDatei = join(dateien.ordner, 'zweitpruefer-bericht.json')
  // -I: isolierter Modus (keine Umgebungsvariablen, kein aktuelles Verzeichnis im Suchpfad)
  const r = spawnSync(python[0]!, [...python.slice(1), '-I', PYTHON_SKRIPT,
    '--dep7', dateien.dep7, '--crypto', dateien.container, '--bericht', berichtDatei, ...extra], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let bericht: ZweitpruefBericht | null = null
  try { bericht = JSON.parse(readFileSync(berichtDatei, 'utf8')) as ZweitpruefBericht } catch { /* Skript vorher abgebrochen */ }
  return { exit: r.status ?? -1, bericht, ausgabe: `${r.stdout}${r.stderr}` }
}

// ---------------------------------------------------------------------------
// BMF-Prüftool (Java)
// ---------------------------------------------------------------------------

export interface BmfZusammenfassung {
  ok:          boolean
  ausgefuehrt: boolean
  hinweis?:    string
  fehlgeschlagen: { datei: string; name: string; meldung: string }[]
  zaehler:     Record<string, number>
}

/** Läuft nur, wenn `BMF_PRUEFTOOL_DIR` (entpacktes Prüftool) gesetzt ist — sonst `ausgefuehrt: false`. */
export function fuehreBmfPrueftoolAus(dateien: PruefDateien): BmfZusammenfassung {
  if (!process.env.BMF_PRUEFTOOL_DIR) {
    return { ok: true, ausgefuehrt: false, hinweis: 'BMF_PRUEFTOOL_DIR nicht gesetzt (Java-Prüftool wird nur im Nacht-Workflow ausgeführt)', fehlgeschlagen: [], zaehler: {} }
  }
  const ausgabe = join(dateien.ordner, 'bmf-pruefer')
  const r = spawnSync(process.execPath, [BMF_SKRIPT, '--dep', dateien.dep7, '--crypto', dateien.container, '--out', ausgabe],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 })
  try {
    return { ausgefuehrt: true, ...(JSON.parse(readFileSync(join(ausgabe, 'bmf-zusammenfassung.json'), 'utf8')) as Omit<BmfZusammenfassung, 'ausgefuehrt'>) }
  } catch {
    return { ok: false, ausgefuehrt: true, hinweis: `bmf-pruefer.mjs lieferte keine Zusammenfassung (Exit ${r.status}): ${(r.stdout + r.stderr).slice(-500)}`, fehlgeschlagen: [], zaehler: {} }
  }
}
