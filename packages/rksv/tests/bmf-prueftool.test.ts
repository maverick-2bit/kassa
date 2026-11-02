/**
 * Das BMF-Prüftool (Java) über Exporte der Kassa — nur wenn BMF_PRUEFTOOL_DIR gesetzt ist (Nacht-Workflow `rksv-nacht`, Java 8).
 *
 * Zwei Fragen:
 *  1. Kontrolle: Besteht das Tool seine eigenen Beispieldaten? (sonst ist jedes weitere Ergebnis wertlos)
 *  2. Was sagt es zu Belegen, die die Signierlogik der Kassa erzeugt?
 *     - AT0 (Software-SEE, „geschlossenes Gesamtsystem"): scheitert schon am Format der Seriennummer (Befund D) und kommt
 *       deshalb nie zu Verkettung, Zähler und Signatur.
 *     - Derselbe Export als offenes System (ZDA AT100): hier greifen alle Prüfungen, auch die Verkettung (Befund A, behoben:
 *       vor der Korrektur meldete das Tool `DEP_CHAINING_VALUE` bei jedem Folgebeleg).
 *
 * Die Einzelheiten der Prüfungen (verificationId je Fehler) landen im Ausgabeordner (RKSV_PRUEF_AUSGABE, sonst Temp).
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll } from 'vitest'
import { REPO_WURZEL, baueEigenenExport, ladeBmfSzenario, type CryptoContainer } from './helpers/pruef-export.js'
import type { DEP7Export } from '../src/types.js'

const SKRIPT = join(REPO_WURZEL, 'scripts', 'rksv', 'bmf-pruefer.mjs')
const AKTIV = !!process.env.BMF_PRUEFTOOL_DIR
const AUSGABE = process.env.RKSV_PRUEF_AUSGABE ?? mkdtempSync(join(tmpdir(), 'kassa-bmf-prueftool-'))

interface Zusammenfassung {
  ok: boolean
  zaehler: Record<string, number>
  fehlgeschlagen: { datei: string; name: string; meldung: string }[]
  laeufe: { szenario: string; ok: boolean; fehlgeschlagen: number }[]
}

function bmf(name: string, dep7: DEP7Export, container: CryptoContainer, varianten = 'certificate,public-key'): Zusammenfassung {
  const ordner = join(AUSGABE, name)
  mkdirSync(ordner, { recursive: true })
  writeFileSync(join(ordner, 'dep-export.json'), JSON.stringify(dep7, null, 2))
  writeFileSync(join(ordner, 'cryptographicMaterialContainer.json'), JSON.stringify(container, null, 2))
  const r = spawnSync(process.execPath, [SKRIPT, '--dep', join(ordner, 'dep-export.json'), '--crypto', join(ordner, 'cryptographicMaterialContainer.json'),
    '--out', join(ordner, 'bmf'), '--varianten', varianten], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 10 * 60_000 })
  writeFileSync(join(ordner, 'runner-ausgabe.txt'), `${r.stdout}\n${r.stderr}`)
  return JSON.parse(readFileSync(join(ordner, 'bmf', 'bmf-zusammenfassung.json'), 'utf8')) as Zusammenfassung
}

describe.skipIf(!AKTIV)('BMF-Prüftool über Exporte der Kassa', () => {
  it('Kontrolle: BMF-Beispiel „geschlossenes System" besteht', () => {
    const s = ladeBmfSzenario('closed-system-1')
    const z = bmf('kontrolle-geschlossen', s.dep7, s.container, 'certificate')
    expect(z.fehlgeschlagen.map(f => `${f.name}: ${f.meldung}`)).toEqual([])
    expect(z.ok).toBe(true)
  }, 180_000)

  it('Kontrolle: BMF-Beispiel „offenes System" besteht', () => {
    const s = ladeBmfSzenario('open-system-1')
    const z = bmf('kontrolle-offen', s.dep7, s.container, 'certificate')
    expect(z.fehlgeschlagen.map(f => `${f.name}: ${f.meldung}`)).toEqual([])
    expect(z.ok).toBe(true)
  }, 180_000)

  describe('Export der Kassa', () => {
    let at0: Awaited<ReturnType<typeof baueEigenenExport>>
    let offen: Awaited<ReturnType<typeof baueEigenenExport>>
    beforeAll(async () => {
      at0   = await baueEigenenExport(60, 'PRUEF-AT0', 'AT0')
      offen = await baueEigenenExport(60, 'PRUEF-OFFEN', 'AT100')
    })

    const arten = (z: Zusammenfassung): string[] => [...new Set(z.fehlgeschlagen.map(f => f.name))].sort()

    // BEFUND D (CI-Probelauf 2026-11-02): Für AT0 verlangt das Tool statt der Zertifikats-Seriennummer den Ordnungsbegriff mit
    // Schlüssel-ID (FORMAT_CLOSED_SYSTEM_SERIAL) — jeder Beleg scheitert daran und kommt nie zu Verkettung, Zähler, Signatur;
    // im DEP folgt DEP_STATE „kein gültiger Startbeleg".
    it('AT0: das Tool beanstandet das Format der Seriennummer des geschlossenen Systems (Befund D)', () => {
      const z = bmf('kassa-at0', at0.dep7, at0.container)
      expect(z.ok).toBe(false)
      expect(arten(z)).toEqual(expect.arrayContaining(['FORMAT_CLOSED_SYSTEM_SERIAL', 'DEP_STATE']))
    }, 180_000)

    // Als offenes System (ZDA AT100, Zertifikat im Container) greifen alle Prüfungen des Tools: Einzelbeleg (Code, Signatur,
    // Umsatzzähler), Abfolge (Start, Sammelbeleg nach Ausfall) und Verkettung. Das Tool nimmt als Eingabe der Verkettung die
    // JWS-Compact-Form des Vorbelegs (CHAINING_INPUT) — wie die Spezifikation und seit der Korrektur auch die Kassa (Befund A).
    // Vor der Korrektur beanstandete es hier `DEP_CHAINING_VALUE` bei 59 von 59 Folgebelegen (und `DEP_RECEIPT_LIST` als Sammelurteil);
    // mit der Korrektur bestand der CI-Probelauf vom 2026-11-02 ohne Beanstandung. Scheitert der Test, steht die Beanstandung im Ausgabeordner.
    it('BEFUND A (behoben)  offenes System (ZDA AT100): das Tool beanstandet nichts — auch nicht die Verkettung', () => {
      const z = bmf('kassa-offen', offen.dep7, offen.container, 'certificate')
      expect(arten(z)).toEqual([])
      expect(z.fehlgeschlagen.map(f => `${f.name}: ${f.meldung}`)).toEqual([])
      expect(z.ok).toBe(true)
    }, 180_000)

    // Export einer Bestandskasse nach dem Update: Belege 2…30 sind noch nach der alten Lesart verkettet (QR-Code gehasht) und lassen sich nicht
    // ändern. CI-Probelauf 2026-11-02: genau diese 29 Belege meldet das Tool als DEP_CHAINING_VALUE (dazu das Sammelurteil DEP_RECEIPT_LIST);
    // der Übergang (Beleg 31, hasht die JWS-Form seines alt verketteten Vorgängers) und alles danach besteht.
    it('Altkette (Belege 2…30 alt, 31…60 nach der Spezifikation): das Tool beanstandet genau die 29 Altbelege', async () => {
      const alt = await baueEigenenExport(60, 'PRUEF-ALT', 'AT100', 30)
      const z = bmf('kassa-altkette', alt.dep7, alt.container, 'certificate')
      expect(arten(z)).toEqual(['DEP_CHAINING_VALUE', 'DEP_RECEIPT_LIST'])
      expect(z.fehlgeschlagen.filter(f => f.name === 'DEP_CHAINING_VALUE')).toHaveLength(29)
    }, 180_000)

    // Eigenheit des Tools (CI-Probelauf 2026-11-02): ein DEP muss mit dem Startbeleg beginnen (DEP_STATE). Auch eine einwandfrei verkettete Kasse
    // besteht als Auszug ohne ihre ersten Belege nicht — die Verkettung selbst wird dabei nicht beanstandet.
    it('DEP-Auszug ohne Startbeleg: das Tool beanstandet den Beginn des DEP, nicht die Verkettung', async () => {
      const neu = await baueEigenenExport(60, 'PRUEF-AUSZUG', 'AT100')
      const ohneErste = { ...neu.dep7, 'Belege-Gruppe': neu.dep7['Belege-Gruppe'].map(g => ({ ...g, 'Belege-kompakt': g['Belege-kompakt'].slice(10) })) }
      const z = bmf('kassa-auszug', ohneErste, neu.container, 'certificate')
      expect(arten(z)).toEqual(['DEP_RECEIPT_LIST', 'DEP_STATE', 'STATE_CASHBOX', 'VERIFICATION_FROM_APP'])
    }, 180_000)
  })
})
