/**
 * ZEIT-MATRIX: Datum/Uhrzeit im maschinenlesbaren Code (Feld „Beleg-Datum-Uhrzeit") für viele Prozess-Zeitzonen
 * und die heiklen Zeitpunkte des Jahres.
 *
 * Spezifikation (RKSV Anlage 1 Z 4): ISO 8601 ohne Zeitzonenangabe, „österreichische Lokalzeit (CET/MEZ)". Gemeint ist die
 * Wanduhr in Österreich (inkl. Sommerzeit) — unabhängig davon, in welcher Zeitzone der Server läuft. Der Produktivcode
 * (formatDatum in src/beleg.ts) nimmt die Zeitzone des Prozesses; in einem Container ohne TZ ist das UTC, der Beleg
 * trägt dann 1–2 Stunden zu wenig.
 *
 * BEFUND B: Dieser Test ist ROT, solange der Fix aus der Karte „RKSV-Kern" fehlt — deshalb läuft er nur auf Anforderung
 * (RKSV_ZEITMATRIX=1; nachts im Workflow `rksv-nacht`). Sobald der Fix released ist, in der Datei
 * `describe.skipIf(!AKTIV)` durch `describe` ersetzen, dann läuft er in der regulären CI.
 *
 *   lokal:  RKSV_ZEITMATRIX=1 pnpm exec vitest run tests/zeit-matrix.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signiereBeleg } from '../src/beleg.js'
import { generateSEE } from '../src/see.js'
import type { SEEConfig } from '../src/types.js'
import { zerlegeQr } from './helpers/pruef-export.js'

const AKTIV = process.env.RKSV_ZEITMATRIX === '1'

/** Zeitzonen des Servers: Österreich, UTC (Docker-Standard), Westen, halbe/Dreiviertel-Stunden, Datumsgrenze in beide Richtungen. */
const ZONEN = ['Europe/Vienna', 'UTC', 'Europe/London', 'America/New_York', 'Asia/Tokyo', 'Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']

/** Zeitpunkte (UTC) rund um Zeitumstellung, Tages-, Monats-, Jahres- und Schaltjahrwechsel nach Wiener Zeit */
const INSTANTE: [string, string][] = [
  ['Sommerzeit-Beginn, eine Sekunde vorher',          '2026-03-29T00:59:59Z'],
  ['Sommerzeit-Beginn, die Lücke (02:00→03:00)',      '2026-03-29T01:00:00Z'],
  ['Sommerzeit-Ende, letzte Sekunde der Sommerzeit',  '2026-10-25T00:59:59Z'],
  ['Sommerzeit-Ende, die wiederholte Stunde beginnt', '2026-10-25T01:00:00Z'],
  ['Sommerzeit-Ende, 02:30 Sommerzeit',               '2026-10-25T00:30:00Z'],
  ['Sommerzeit-Ende, 02:30 Winterzeit',               '2026-10-25T01:30:00Z'],
  ['Silvester, letzte Sekunde 2026 (Wiener Zeit)',    '2026-12-31T22:59:59Z'],
  ['Neujahr 2027 um 00:00:00 (Wiener Zeit)',          '2026-12-31T23:00:00Z'],
  ['Monatsende Juni, 23:59:59 Sommerzeit',            '2026-06-30T21:59:59Z'],
  ['Monatswechsel Juli, 00:00:00 Sommerzeit',         '2026-06-30T22:00:00Z'],
  ['Monatsende Februar, 23:59:59',                    '2026-02-28T22:59:59Z'],
  ['Schalttag 2028, 00:00:00 (Wiener Zeit)',          '2028-02-28T23:00:00Z'],
  ['mittags im Sommer',                               '2026-07-15T12:34:56Z'],
  ['mittags im Winter',                               '2026-01-15T12:34:56Z'],
  ['kurz nach Mitternacht UTC im Sommer',             '2026-08-01T00:05:07Z'],
  ['kurz vor Mitternacht UTC im Winter',              '2026-11-30T23:55:08Z'],
]

/** Wanduhr in Wien als `JJJJ-MM-TTThh:mm:ss` — der Sollwert, unabhängig von der Prozess-Zeitzone gerechnet. */
function wienerWanduhr(instant: Date): string {
  const t = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).reduce<Record<string, string>>((a, p) => { a[p.type] = p.value; return a }, {})
  return `${t.year}-${t.month}-${t.day}T${t.hour}:${t.minute}:${t.second}`
}

describe.skipIf(!AKTIV)('Zeit-Matrix: Beleg-Datum-Uhrzeit = Wiener Wanduhr in jeder Prozess-Zeitzone (BEFUND B)', () => {
  const ursprung = process.env.TZ
  let see: SEEConfig

  beforeAll(async () => {
    see = await generateSEE({ kassenId: 'ZEIT-1', uid: 'ATU12345678', firmenname: 'Zeit GmbH' })
    // Kontrolle: Der Wechsel der Prozess-Zeitzone zur Laufzeit muss in diesem Testlauf funktionieren (Fork-Pool, kein Worker-Thread)
    process.env.TZ = 'Asia/Kolkata'
    expect(new Date(Date.UTC(2026, 5, 1, 12, 0, 0)).getMinutes(), 'process.env.TZ wirkt nicht — Test in einem Worker-Thread?').toBe(30)
  })
  afterAll(() => { if (ursprung === undefined) delete process.env.TZ; else process.env.TZ = ursprung })

  async function codeDatum(zone: string, instant: Date): Promise<string> {
    process.env.TZ = zone
    const b = await signiereBeleg({ kassenId: 'ZEIT-1', belegNummer: 1, datumUhrzeit: instant, belegTyp: 'Nullbeleg', positionen: [] }, { see, umsatzzaehler: new (await import('../src/beleg.js')).Umsatzzaehler(0n) })
    return zerlegeQr(b.maschinenlesbareCode).datum
  }

  describe.each(ZONEN)('Server in %s', zone => {
    it.each(INSTANTE)('%s (%s)', async (_name, iso) => {
      const instant = new Date(iso)
      expect(await codeDatum(zone, instant)).toBe(wienerWanduhr(instant))
    })
  })

  describe('Eigenheit des Formats: Herbst-Umstellung', () => {
    // Die Spezifikation verlangt Lokalzeit OHNE Zonenangabe. In der Stunde, die sich wiederholt, geht die Wanduhr zurück:
    // ein Beleg um 02:50 Sommerzeit und einer um 02:10 Winterzeit (20 Minuten SPÄTER) tragen 02:50:00 und 02:10:00.
    // Ein Prüfer, der die Zeitstempel als Text oder als Ortszeit liest, sieht „rückwärts". Das ist keine Macke der Kassa,
    // sondern des Formats — aber ein Prüfer (BMF-Prüftool: „chronologische Abfolge") kann es melden.
    it('zwei Belege in der wiederholten Stunde: spätere Belege tragen eine frühere Wanduhrzeit', async () => {
      const erster = await codeDatum('Europe/Vienna', new Date('2026-10-25T00:50:00Z'))
      const zweiter = await codeDatum('Europe/Vienna', new Date('2026-10-25T01:10:00Z'))
      expect(erster).toBe('2026-10-25T02:50:00')
      expect(zweiter).toBe('2026-10-25T02:10:00')
      expect(zweiter < erster).toBe(true)
    })
  })
})
