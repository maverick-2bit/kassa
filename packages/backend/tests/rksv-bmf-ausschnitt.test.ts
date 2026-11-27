/**
 * Das BMF-Prüftool (Java) bekommt vom Burn-in höchstens `BMF_MAX_BELEGE` Belege (vom Startbeleg an).
 * Hintergrund: Der lange Sonntags-Burn-in (45 Minuten, rund 19 000 Belege) brach im Nachtlauf 2026-11-08 beim Prüftool ab —
 * Laufzeit und Ausgabe wachsen mit der Belegzahl. Den ganzen Bestand prüft der Python-Zweitprüfer.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { kuerzeExportFuerBmf, type PruefDateien } from './helpers/externePruefer.js'

const temp: string[] = []
afterAll(() => { for (const o of temp) rmSync(o, { recursive: true, force: true }) })

function schreibe(gruppen: string[][]): PruefDateien {
  const ordner = mkdtempSync(join(tmpdir(), 'kassa-bmf-ausschnitt-'))
  temp.push(ordner)
  const dep7 = join(ordner, 'dep-export.json')
  writeFileSync(dep7, JSON.stringify({
    'Belege-Gruppe': gruppen.map((kompakt, i) => ({ Signaturzertifikat: `zert-${i}`, Zertifizierungsstellen: [], 'Belege-kompakt': kompakt })),
  }))
  return { ordner, dep7, container: join(ordner, 'cryptographicMaterialContainer.json') }
}

const belege = (von: number, bis: number): string[] => Array.from({ length: bis - von }, (_, i) => `jws-${von + i}`)

describe('Ausschnitt des Exports für das BMF-Prüftool', () => {
  it('bis zur Höchstzahl bleibt die Datei unverändert (kein Umweg, keine neue Datei)', () => {
    const d = schreibe([belege(0, 50)])
    const r = kuerzeExportFuerBmf(d, 50)
    expect(r).toEqual({ dep7: d.dep7, geprueft: 50, gesamt: 50 })
  })

  it('kürzt auf die ersten N Belege — vom Startbeleg an — und lässt die Quelldatei unberührt', () => {
    const d = schreibe([belege(0, 5000)])
    const vorher = readFileSync(d.dep7, 'utf8')
    const r = kuerzeExportFuerBmf(d, 2000)
    expect(r.geprueft).toBe(2000)
    expect(r.gesamt).toBe(5000)
    expect(r.dep7).not.toBe(d.dep7)
    const neu = JSON.parse(readFileSync(r.dep7, 'utf8')) as { 'Belege-Gruppe': { Signaturzertifikat: string; 'Belege-kompakt': string[] }[] }
    expect(neu['Belege-Gruppe']).toHaveLength(1)
    expect(neu['Belege-Gruppe'][0]!['Belege-kompakt']).toHaveLength(2000)
    expect(neu['Belege-Gruppe'][0]!['Belege-kompakt'][0]).toBe('jws-0')          // der Startbeleg bleibt vorn
    expect(neu['Belege-Gruppe'][0]!['Belege-kompakt'][1999]).toBe('jws-1999')
    expect(neu['Belege-Gruppe'][0]!.Signaturzertifikat).toBe('zert-0')             // übrige Felder der Gruppe bleiben
    expect(readFileSync(d.dep7, 'utf8')).toBe(vorher)
  })

  it('mehrere Gruppen: die Höchstzahl gilt insgesamt, in Reihenfolge; leere Gruppen entfallen', () => {
    const d = schreibe([belege(0, 30), belege(30, 70), belege(70, 100)])
    const r = kuerzeExportFuerBmf(d, 50)
    expect(r).toMatchObject({ geprueft: 50, gesamt: 100 })
    const neu = JSON.parse(readFileSync(r.dep7, 'utf8')) as { 'Belege-Gruppe': { 'Belege-kompakt': string[] }[] }
    expect(neu['Belege-Gruppe'].map(g => g['Belege-kompakt'].length)).toEqual([30, 20])
  })

  it('ein Export ohne Gruppen bleibt unverändert', () => {
    const d = schreibe([])
    expect(kuerzeExportFuerBmf(d, 10)).toEqual({ dep7: d.dep7, geprueft: 0, gesamt: 0 })
  })
})
