/**
 * Uhrzeit und Datum auf Bons — Wiener Ortszeit, unabhängig von der Zeitzone des Prozesses.
 *
 * Ein Backend-Container ohne `TZ` läuft in UTC. `getHours()` & Co. lieferten dort die Zeit in
 * UTC: Der Bon trug eine um 1 bis 2 Stunden falsche Uhrzeit (um Mitternacht auch den falschen
 * Tag), der Bonierbon in der Küche ebenso. tests/escpos-golden pinnte TZ=Europe/Vienna und hat
 * das verdeckt — hier läuft jeder Fall unter mehreren Zeitzonen des Prozesses.
 *
 * Matrix: Prozess-TZ UTC / Europe/Vienna / America/New_York × Zeitumstellung 2026-03-29 und
 * 2026-10-25, Jahreswechsel, Mitternacht in Sommer- und Winterzeit, 29. Februar (2028).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BelegResponse } from '@kassa/shared'
import { baueBon } from '../src/services/escpos/layout.js'
import { baueBonierbon } from '../src/services/kds/bonierbon.js'

const ZONEN = ['UTC', 'Europe/Vienna', 'America/New_York'] as const

/** Zeitpunkt (UTC) → Wiener Wanduhr: Datum `TT.MM.JJJJ`, Uhrzeit `hh:mm:ss` */
const FAELLE: ReadonlyArray<readonly [string, string, string, string]> = [
  ['vor der Umstellung auf Sommerzeit',     '2026-03-29T00:59:59Z', '29.03.2026', '01:59:59'],
  ['Sekunde der Umstellung auf Sommerzeit', '2026-03-29T01:00:00Z', '29.03.2026', '03:00:00'],
  ['vor der Umstellung auf Winterzeit',     '2026-10-25T00:59:59Z', '25.10.2026', '02:59:59'],
  ['Sekunde der Umstellung auf Winterzeit', '2026-10-25T01:00:00Z', '25.10.2026', '02:00:00'],
  ['letzte Sekunde des Jahres 2026',        '2026-12-31T22:59:59Z', '31.12.2026', '23:59:59'],
  ['erste Sekunde des Jahres 2027',         '2026-12-31T23:00:00Z', '01.01.2027', '00:00:00'],
  ['Mitternacht Sommerzeit',                '2026-07-01T22:00:00Z', '02.07.2026', '00:00:00'],
  ['23:59:59 Sommerzeit',                   '2026-07-01T21:59:59Z', '01.07.2026', '23:59:59'],
  ['Wien: 29.2. beginnt',                   '2028-02-28T23:00:00Z', '29.02.2028', '00:00:00'],
  ['Wien: 29.2. endet',                     '2028-02-29T22:59:59Z', '29.02.2028', '23:59:59'],
  ['Wien: 1.3. nach dem Schalttag',         '2028-02-29T23:00:00Z', '01.03.2028', '00:00:00'],
]

/** Setzt die Zeitzone des Prozesses und beweist, dass sie wirkt (sonst wäre der Test leer). */
function setzeProzessZone(zone: string): void {
  process.env['TZ'] = zone
  const erwarteteStunde = { 'UTC': 12, 'Europe/Vienna': 14, 'America/New_York': 8 }[zone]
  const h = new Date('2026-07-01T12:00:00Z').getHours()
  if (h !== erwarteteStunde) throw new Error(`Prozess-TZ ${zone} wirkt nicht (getHours()=${h}) — der Test wäre wertlos`)
}

const ZONE_VORHER = process.env['TZ']
afterAll(() => {
  if (ZONE_VORHER === undefined) delete process.env['TZ']
  else process.env['TZ'] = ZONE_VORHER
})

function beleg(zeitpunktUtc: string): BelegResponse {
  return {
    id: '11111111-1111-1111-1111-111111111111', belegNummer: 42, belegDatum: zeitpunktUtc,
    belegTyp: 'Barzahlungsbeleg',
    betraege: { normal: 0, ermaessigt1: 700, ermaessigt2: 0, null: 0, besonders: 0 },
    summeBarCent: 700, summeKarteCent: 0, summeSonstigeCent: 0, gesamtbetragCent: 700,
    positionen: [{ bezeichnung: 'Espresso', menge: 2, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' }],
    zertifikatSn: 'AB-1234', sigVorbeleg: 'vor', signaturwert: 'sig', umsatzzaehlerVerschluesselt: 'enc',
    maschinenlesbareCode: '_R1-AT_KASSE-001_42_2026-05-20T16:30:00_0,00_7,00_0,00_0,00_0,00_enc_AB-1234_vor_sig',
    createdAt: zeitpunktUtc,
  }
}

describe.each(ZONEN)('Prozess-Zeitzone %s', (zone) => {
  beforeAll(() => setzeProzessZone(zone))

  describe('Bonierbon (Küche/Schank)', () => {
    it.each(FAELLE)('%s: %s → %s %s', (_name, utc, datum, uhrzeit) => {
      const text = baueBonierbon({
        bonNummer: 'AE420260210', belegnummer: 42, uhrzeit: new Date(utc), tisch: '5', kellner: 'Mayr',
        positionen: [{ menge: 1, bezeichnung: 'Bier' }],
      })
      const zeile2 = text.split('\n')[1]!
      expect(zeile2).toContain(uhrzeit)
      expect(zeile2).toContain(datum)
    })
  })

  describe('Beleg-Bon (80 mm)', () => {
    it.each(FAELLE)('%s: %s → %s %s', (_name, utc, datum, uhrzeit) => {
      const bon = baueBon(beleg(utc), { firmenname: 'Zeit GmbH', uid: 'ATU12345678', kassenId: 'KASSE-001' }, { breite: 42 })
        .toString('latin1')
      // Auf dem Bon stehen Datum und Uhrzeit ohne Sekunden
      expect(bon).toContain(`${datum} ${uhrzeit.slice(0, 5)}`)
    })

    it('der Tag wechselt um Mitternacht Wiener Zeit, nicht um Mitternacht UTC', () => {
      const text = (utc: string) =>
        baueBon(beleg(utc), { firmenname: 'Zeit GmbH', uid: 'ATU12345678', kassenId: 'KASSE-001' }, { breite: 42 })
          .toString('latin1')
      expect(text('2026-07-01T21:59:00Z')).toContain('01.07.2026 23:59')
      expect(text('2026-07-01T22:00:00Z')).toContain('02.07.2026 00:00')
      // und die Uhrzeit liegt nicht in UTC: 22:00 UTC steht nicht auf dem Bon
      expect(text('2026-07-01T22:00:00Z')).not.toContain('22:00')
    })
  })
})
