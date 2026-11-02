/**
 * Wiener Ortszeit im QR-Code — unabhängig von der Zeitzone des Prozesses.
 *
 * Bis v0.8.74 stand im maschinenlesbaren Code die Zeit der Prozess-Zeitzone
 * (`getHours()` & Co.). Ein Docker-Container ohne `TZ` läuft in UTC: Uhrzeit und
 * Tag im QR-Code waren 1 bis 2 Stunden daneben. Der Golden-Test der Bons pinnt
 * `TZ=Europe/Vienna` und hat das verdeckt — deshalb läuft hier JEDER Fall unter
 * mehreren Zeitzonen des Prozesses, und die Erwartung ist immer dieselbe
 * Wiener Wanduhr.
 *
 * Matrix: Prozess-TZ UTC / Europe/Vienna / America/New_York ×
 *   Zeitumstellung 2026-03-29 (Frühjahr) und 2026-10-25 (Herbst),
 *   Jahreswechsel, Mitternacht in Sommer- und Winterzeit, 29. Februar (2028).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateSEE, signiereRoh } from '../src/see.js'
import {
  erstelleStartbeleg,
  jwsSigningInput,
  pruefeBelegSignatur,
  signiereBeleg,
  verifiziereBelegSignatur,
  verifiziereBelegSignaturAltDer,
  verifiziereQrCode,
  type VerifizierbarerBeleg,
} from '../src/beleg.js'
import {
  formatBelegDatumUhrzeit,
  formatWienerDatum,
  formatWienerDatumUhrzeit,
  formatWienerUhrzeit,
  formatWienerUhrzeitSekunden,
} from '../src/zeit.js'
import { derZuP1363, p1363ZuDer } from '../src/see.js'
import type { RawBeleg, SEEConfig, SignedBeleg } from '../src/types.js'

const ZONEN = ['UTC', 'Europe/Vienna', 'America/New_York'] as const

/** Zeitpunkt (UTC) → erwartete Wiener Wanduhr (`JJJJ-MM-TTThh:mm:ss`) */
const FAELLE: ReadonlyArray<readonly [string, string, string]> = [
  // Frühjahr 2026-03-29: um 01:00 UTC springt Wien von 02:00 MEZ auf 03:00 MESZ
  ['vor der Umstellung auf Sommerzeit',     '2026-03-29T00:59:59Z', '2026-03-29T01:59:59'],
  ['Sekunde der Umstellung auf Sommerzeit', '2026-03-29T01:00:00Z', '2026-03-29T03:00:00'],
  ['nach der Umstellung auf Sommerzeit',    '2026-03-29T01:00:01Z', '2026-03-29T03:00:01'],
  ['Mitternacht davor (Winterzeit)',        '2026-03-28T23:00:00Z', '2026-03-29T00:00:00'],
  // Herbst 2026-10-25: um 01:00 UTC springt Wien von 03:00 MESZ auf 02:00 MEZ (02:xx gibt es zweimal)
  ['vor der Umstellung auf Winterzeit',     '2026-10-25T00:59:59Z', '2026-10-25T02:59:59'],
  ['Sekunde der Umstellung auf Winterzeit', '2026-10-25T01:00:00Z', '2026-10-25T02:00:00'],
  ['zweite Stunde 02:xx (Winterzeit)',      '2026-10-25T01:30:00Z', '2026-10-25T02:30:00'],
  ['nach der Umstellung auf Winterzeit',    '2026-10-25T02:00:00Z', '2026-10-25T03:00:00'],
  ['Mitternacht davor (Sommerzeit)',        '2026-10-24T22:00:00Z', '2026-10-25T00:00:00'],
  // Jahreswechsel (Winterzeit, UTC+1)
  ['letzte Sekunde des Jahres 2026',        '2026-12-31T22:59:59Z', '2026-12-31T23:59:59'],
  ['erste Sekunde des Jahres 2027',         '2026-12-31T23:00:00Z', '2027-01-01T00:00:00'],
  // UTC-Tag ist schon der nächste, Wien noch nicht — und umgekehrt
  ['UTC schon Neujahr, Wien auch',          '2027-01-01T00:30:00Z', '2027-01-01T01:30:00'],
  // Mitternacht in Sommerzeit (UTC+2): UTC-Datum hinkt 2 Stunden nach
  ['Mitternacht Sommerzeit',                '2026-07-01T22:00:00Z', '2026-07-02T00:00:00'],
  ['23:59:59 Sommerzeit',                   '2026-07-01T21:59:59Z', '2026-07-01T23:59:59'],
  // 29. Februar (Schaltjahr 2028)
  ['Wien: 29.2. beginnt',                   '2028-02-28T23:00:00Z', '2028-02-29T00:00:00'],
  ['Wien: 29.2. endet',                     '2028-02-29T22:59:59Z', '2028-02-29T23:59:59'],
  ['Wien: 1.3. nach dem Schalttag',         '2028-02-29T23:00:00Z', '2028-03-01T00:00:00'],
  ['kein Schalttag 2027: 28.2. → 1.3.',     '2027-02-28T23:00:00Z', '2027-03-01T00:00:00'],
]

/** Setzt die Zeitzone des Prozesses und beweist, dass sie wirklich wirkt (sonst wäre der Test leer). */
function setzeProzessZone(zone: string): void {
  process.env['TZ'] = zone
  const probe = new Date('2026-07-01T12:00:00Z')               // Sommer: Wien +2, UTC 0, New York −4
  const erwarteteStunde = { 'UTC': 12, 'Europe/Vienna': 14, 'America/New_York': 8 }[zone]
  if (probe.getHours() !== erwarteteStunde) {
    throw new Error(`Prozess-TZ ${zone} wirkt nicht (getHours()=${probe.getHours()}, erwartet ${erwarteteStunde}) — der Test wäre wertlos`)
  }
}

const ZONE_VORHER = process.env['TZ']
afterAll(() => {
  if (ZONE_VORHER === undefined) delete process.env['TZ']
  else process.env['TZ'] = ZONE_VORHER
})

let see: SEEConfig
beforeAll(async () => {
  see = await generateSEE({ kassenId: 'ZEIT-KASSE-1', uid: 'ATU12345678', firmenname: 'Zeit GmbH' })
})

/** Signierter Barzahlungsbeleg zu einem festen Zeitpunkt. */
async function signiere(zeitpunkt: Date, belegNummer = 2): Promise<SignedBeleg> {
  const { kontext } = await erstelleStartbeleg('ZEIT-KASSE-1', see)
  const raw: RawBeleg = {
    kassenId: 'ZEIT-KASSE-1', belegNummer, datumUhrzeit: zeitpunkt, belegTyp: 'Barzahlungsbeleg',
    positionen: [{ bezeichnung: 'Kaffee', menge: 1, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' }],
  }
  return signiereBeleg(raw, kontext)
}

/** Der Zeitpunkt, wie ihn der QR-Code trägt (4. Feld nach dem Präfix). */
const zeitImCode = (code: string): string => code.split('_')[4]!

function alsVerifizierbar(b: SignedBeleg, mitCode = true): VerifizierbarerBeleg {
  return {
    zdaId: see.zdaId, kassenId: b.kassenId, belegNummer: b.belegNummer, datumUhrzeit: b.datumUhrzeit,
    betraege: b.betraege, umsatzzaehlerVerschluesselt: b.umsatzzaehlerVerschluesselt,
    zertifikatSN: b.zertifikatSN, sigVorbeleg: b.sigVorbeleg, signaturwert: b.signaturwert,
    ...(mitCode && { maschinenlesbareCode: b.maschinenlesbareCode }),
  }
}

describe.each(ZONEN)('Prozess-Zeitzone %s', (zone) => {
  beforeAll(() => setzeProzessZone(zone))

  describe('Formatierung (Wiener Wanduhr)', () => {
    it.each(FAELLE)('%s: %s → %s', (_name, utc, wien) => {
      expect(formatBelegDatumUhrzeit(new Date(utc))).toBe(wien)
    })

    it('Bon-Formate hängen nicht von der Prozess-Zeitzone ab', () => {
      const d = new Date('2026-07-01T21:59:07Z')                     // Wien 23:59:07 am 1.7.
      expect(formatWienerDatum(d)).toBe('01.07.2026')
      expect(formatWienerDatumUhrzeit(d)).toBe('01.07.2026 23:59')
      expect(formatWienerUhrzeit(d)).toBe('23:59')
      expect(formatWienerUhrzeitSekunden(d)).toBe('23:59:07')
      // eine Minute später ist in Wien schon der 2.7.
      expect(formatWienerDatumUhrzeit(new Date('2026-07-01T22:00:00Z'))).toBe('02.07.2026 00:00')
    })

    it('Mitternacht heißt 00:00 und nie 24:00', () => {
      for (const [, utc] of FAELLE) {
        expect(formatBelegDatumUhrzeit(new Date(utc))).not.toMatch(/T24:/)
      }
    })

    it('Sekunden werden abgeschnitten, nicht gerundet', () => {
      expect(formatBelegDatumUhrzeit(new Date('2026-07-01T10:00:59.999Z'))).toBe('2026-07-01T12:00:59')
    })

    it('ein ungültiges Datum wirft, statt NaN in einen Beleg zu schreiben', () => {
      expect(() => formatBelegDatumUhrzeit(new Date('kein Datum'))).toThrow(RangeError)
    })
  })

  describe('QR-Code eines frisch signierten Belegs', () => {
    it.each(FAELLE)('%s: der Code trägt die Wiener Zeit und verifiziert (%s)', async (_name, utc, wien) => {
      const beleg = await signiere(new Date(utc))
      expect(zeitImCode(beleg.maschinenlesbareCode)).toBe(wien)
      expect(verifiziereQrCode(beleg.maschinenlesbareCode, see.zertifikatDER)).toBe(true)
      expect(pruefeBelegSignatur(alsVerifizierbar(beleg), see.zertifikatDER)).toBe('gueltig')
    })

    it('der Startbeleg trägt ebenfalls die Wiener Ortszeit', async () => {
      const vorher = Date.now()
      const { beleg } = await erstelleStartbeleg('ZEIT-KASSE-1', see)
      const gestempelt = zeitImCode(beleg.maschinenlesbareCode)
      expect(gestempelt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
      expect(gestempelt).toBe(formatBelegDatumUhrzeit(beleg.datumUhrzeit))
      expect(Math.abs(beleg.datumUhrzeit.getTime() - vorher)).toBeLessThan(5_000)
    })
  })

  describe('Altbelege (Zeit im QR-Code nicht in Wiener Ortszeit)', () => {
    /**
     * Baut einen Beleg, wie ihn eine ältere Version in einem Container ohne TZ signiert
     * hätte: gleicher Beleg, aber der Zeitpunkt im Code in UTC bzw. in der Zone des Prozesses.
     */
    function altBeleg(neu: SignedBeleg, zeitText: string): SignedBeleg {
      const teile = neu.maschinenlesbareCode.split('_')
      teile[4] = zeitText
      const codeOhneSig = teile.slice(0, -1).join('_')
      const signaturwert = signiereRoh(jwsSigningInput(codeOhneSig), see).toString('base64')
      return { ...neu, signaturwert, maschinenlesbareCode: `${codeOhneSig}_${signaturwert}` }
    }

    const utcText    = (d: Date): string => d.toISOString().slice(0, 19)
    const prozessText = (d: Date): string => {
      const p = (n: number): string => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    it.each(FAELLE)('%s: ein in UTC signierter Altbeleg bleibt gültig, wird aber als Zeit-Altformat gemeldet (%s)', async (_name, utc) => {
      const d = new Date(utc)
      const alt = altBeleg(await signiere(d), utcText(d))
      expect(verifiziereBelegSignatur(alsVerifizierbar(alt), see.zertifikatDER)).toBe(true)
      expect(pruefeBelegSignatur(alsVerifizierbar(alt), see.zertifikatDER)).toBe('zeit_altformat')
      expect(pruefeBelegSignatur(alsVerifizierbar(alt, false), see.zertifikatDER)).toBe('zeit_altformat')
    })

    it.each(FAELLE)('%s: ein in der Zone des Prozesses signierter Altbeleg bleibt gültig (%s)', async (_name, utc) => {
      const d = new Date(utc)
      const alt = altBeleg(await signiere(d), prozessText(d))
      expect(verifiziereBelegSignatur(alsVerifizierbar(alt), see.zertifikatDER)).toBe(true)
      expect(['gueltig', 'zeit_altformat']).toContain(pruefeBelegSignatur(alsVerifizierbar(alt), see.zertifikatDER))
    })

    it('nur der SELBE Zeitpunkt in anderer Schreibweise zählt: eine Sekunde daneben ist ungültig', async () => {
      const d = new Date('2026-07-01T10:00:00Z')
      const alt = altBeleg(await signiere(d), utcText(d))
      const falsch = { ...alsVerifizierbar(alt), datumUhrzeit: new Date(d.getTime() + 1000) }
      expect(pruefeBelegSignatur(falsch, see.zertifikatDER)).toBe('ungueltig')
    })

    it('ein um einen Tag oder Monat verschobenes Datum fällt auf', async () => {
      const beleg = await signiere(new Date('2026-07-01T10:00:00Z'))
      for (const verschoben of ['2026-07-02T10:00:00Z', '2026-06-30T10:00:00Z', '2026-08-01T10:00:00Z', '2027-07-01T10:00:00Z']) {
        const fall = { ...alsVerifizierbar(beleg), datumUhrzeit: new Date(verschoben) }
        expect(pruefeBelegSignatur(fall, see.zertifikatDER), verschoben).toBe('ungueltig')
      }
    })

    it('ein DER-codierter Altbeleg wird weiter als Altformat DER erkannt, auch mit Zeit in UTC', async () => {
      const d = new Date('2026-07-01T10:00:00Z')
      const alt = altBeleg(await signiere(d), utcText(d))
      const derSig = p1363ZuDer(Buffer.from(alt.signaturwert, 'base64'))
      expect(derZuP1363(derSig).equals(Buffer.from(alt.signaturwert, 'base64'))).toBe(true)
      const codeOhneSig = alt.maschinenlesbareCode.slice(0, alt.maschinenlesbareCode.lastIndexOf('_'))
      const derB64 = derSig.toString('base64')
      const der = { ...alt, signaturwert: derB64, maschinenlesbareCode: `${codeOhneSig}_${derB64}` }
      expect(pruefeBelegSignatur(alsVerifizierbar(der), see.zertifikatDER)).toBe('der_altformat')
      expect(verifiziereBelegSignaturAltDer(alsVerifizierbar(der), see.zertifikatDER)).toBe(true)
      expect(verifiziereBelegSignatur(alsVerifizierbar(der), see.zertifikatDER)).toBe(false)
    })
  })

  describe('gespeicherter Code', () => {
    it('ein nachträglich veränderter gespeicherter Code wird erkannt, auch wenn die Felder stimmen', async () => {
      const beleg = await signiere(new Date('2026-07-01T10:00:00Z'))
      const v = alsVerifizierbar(beleg)
      expect(pruefeBelegSignatur(v, see.zertifikatDER)).toBe('gueltig')
      const verfaelscht = { ...v, maschinenlesbareCode: beleg.maschinenlesbareCode.replace('ZEIT-KASSE-1', 'ZEIT-KASSE-9') }
      expect(pruefeBelegSignatur(verfaelscht, see.zertifikatDER)).toBe('ungueltig')
    })

    it('ein Betrag, der in der Datenbank gesenkt wurde, fällt auf (Signatur und gespeicherter Code)', async () => {
      const beleg = await signiere(new Date('2026-07-01T10:00:00Z'))
      const v = alsVerifizierbar(beleg)
      const gesenkt = { ...v, betraege: { ...v.betraege, ermaessigt1: 100 } }
      expect(pruefeBelegSignatur(gesenkt, see.zertifikatDER)).toBe('ungueltig')
      expect(verifiziereBelegSignatur(gesenkt, see.zertifikatDER)).toBe(false)
    })
  })
})
