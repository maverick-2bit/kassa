/**
 * Steuersatz 4,9 % (ausgewählte Nahrungsmittel, seit 1.7.2026) — Unit-Tests der Stellen ohne Datenbank:
 * Satz-Tabellen, Bon, Tagesabschluss-Rechnung, Layout-Zuordnung.
 *
 * Der Satz heißt `ermaessigt3` und steht in QR-Code und DEP im Feld „Betrag-Satz-Besonders (19 %, 4,9 %)";
 * hier geht es um das, was die Kassa DARÜBER HINAUS getrennt führt: Bon, Berichte, Exporte.
 */

import { describe, expect, it } from 'vitest'
import { MWST_PROZENT as RKSV_PROZENT } from '@kassa/rksv'
import { MWST_LABELS, MWST_PROZENT_SATZ, MwStSatzSchema, MWST_SAETZE, formatMwstProzent, berechneSteueraufteilung, type BelegResponse } from '@kassa/shared'
import { baueBon } from '../src/services/escpos/layout.js'
import { mwstZuSatz, satzZuMwst } from '../src/services/layout-import.service.js'

const SAETZE = MwStSatzSchema.options

describe('Satz-Tabellen sind überall dieselben', () => {
  it('shared und rksv führen dieselben Prozentwerte (eine Quelle der Wahrheit pro Paket, ein Test hält sie gleich)', () => {
    expect(MWST_PROZENT_SATZ).toEqual(RKSV_PROZENT)
  })

  it('jeder Satz hat Label und Prozentwert; das Label nennt den Prozentwert', () => {
    expect(Object.keys(MWST_LABELS).sort()).toEqual([...SAETZE].sort())
    expect(Object.keys(MWST_PROZENT_SATZ).sort()).toEqual([...SAETZE].sort())
    for (const satz of SAETZE) {
      expect(MWST_LABELS[satz], satz).toContain(`${formatMwstProzent(MWST_PROZENT_SATZ[satz])} %`)
    }
  })

  it('der Satz 4,9 % ist ermaessigt3 mit dem Label „4,9 % (Ermäßigt 3)"', () => {
    expect(MWST_PROZENT_SATZ.ermaessigt3).toBe(4.9)
    expect(MWST_LABELS.ermaessigt3).toBe('4,9 % (Ermäßigt 3)')
    expect(MwStSatzSchema.safeParse('ermaessigt3').success).toBe(true)
    expect(MwStSatzSchema.safeParse('ermaessigt4').success).toBe(false)
  })

  it('Rechnungs-HTML und Angebote rechnen den Sondersteuersatz mit 19 %, nicht mehr mit den 5 % von 2020–2022', () => {
    expect(MWST_SAETZE['besonders']).toBe(19)
    expect(MWST_SAETZE['ermaessigt3']).toBe(4.9)
  })

  it('Prozentzahl mit Dezimalkomma: 20 → „20", 4,9 → „4,9"', () => {
    expect(formatMwstProzent(20)).toBe('20')
    expect(formatMwstProzent(4.9)).toBe('4,9')
    expect(formatMwstProzent(0)).toBe('0')
  })
})

describe('Steueraufteilung (Rechnung/Bon) mit 4,9 %', () => {
  const beleg = (betraege: Partial<BelegResponse['betraege']>): BelegResponse => ({
    id: '11111111-1111-1111-1111-111111111111', belegNummer: 7, belegDatum: '2026-07-01T10:00:00Z', belegTyp: 'Barzahlungsbeleg',
    betraege: { normal: 0, ermaessigt1: 0, ermaessigt2: 0, ermaessigt3: 0, null: 0, besonders: 0, ...betraege },
    summeBarCent: 0, summeKarteCent: 0, summeSonstigeCent: 0, gesamtbetragCent: 0, positionen: [],
    zertifikatSn: 'AB', sigVorbeleg: 'v', signaturwert: 's', umsatzzaehlerVerschluesselt: 'e',
    maschinenlesbareCode: '_R1-AT0_K_7_2026-07-01T12:00:00_0,00_0,00_0,00_0,00_0,00_e_AB_v_s', createdAt: '2026-07-01T10:00:00Z',
  })

  it('4,9 % und 19 % erscheinen getrennt, jeweils mit eigenem Netto und eigener USt', () => {
    const z = berechneSteueraufteilung(beleg({ ermaessigt3: 240, besonders: 777 }))
    expect(z.map(x => [x.label, x.satz, x.bruttoCent, x.nettoCent, x.ustCent])).toEqual([
      ['4,9 % (Ermäßigt 3)', 4.9, 240, 229, 11],       // 240 / 1,049 = 228,79 → 229
      ['19 % (Sondersteuersatz)', 19, 777, 653, 124],   // 777 / 1,19  = 652,94 → 653
    ])
  })

  it('ein Beleg ohne das Feld (aus der Zeit vor dem Satz 4,9 %) ergibt keine NaN-Zeile', () => {
    const alt = beleg({ normal: 1200 })
    delete (alt.betraege as Partial<BelegResponse['betraege']>).ermaessigt3
    expect(berechneSteueraufteilung(alt).map(x => x.label)).toEqual(['20 % (Normal)'])
  })
})

describe('Bon (ESC/POS) mit 4,9 %', () => {
  const MANDANT = { firmenname: 'Bäckerei GmbH', uid: 'ATU12345678', kassenId: 'KASSE-001' }
  const bon = (betraege: Partial<BelegResponse['betraege']>) =>
    baueBon({
      id: '11111111-1111-1111-1111-111111111111', belegNummer: 7, belegDatum: '2026-07-01T10:00:00Z', belegTyp: 'Barzahlungsbeleg',
      betraege: { normal: 0, ermaessigt1: 0, ermaessigt2: 0, ermaessigt3: 0, null: 0, besonders: 0, ...betraege },
      summeBarCent: 0, summeKarteCent: 0, summeSonstigeCent: 0, gesamtbetragCent: 0,
      positionen: [{ bezeichnung: 'Semmel', menge: 4, einzelpreisBreutto: 60, mwstSatz: 'ermaessigt3' }],
      zertifikatSn: 'AB', sigVorbeleg: 'v', signaturwert: 's', umsatzzaehlerVerschluesselt: 'e',
      maschinenlesbareCode: '_R1-AT0_KASSE-001_7_2026-07-01T12:00:00_0,00_0,00_0,00_0,00_2,40_e_AB_v_s', createdAt: '2026-07-01T10:00:00Z',
    }, MANDANT, { breite: 42 }).toString('latin1')

  it('weist den Satz 4,9 % getrennt aus (§ 11 RKSV: Betrag getrennt nach Steuersätzen)', () => {
    const text = bon({ ermaessigt3: 240 })
    expect(text).toContain('4,9 % (Erm')
    expect(text).toContain('Netto 2,29 EUR USt 0,11 EUR')
  })

  it('4,9 % und 19 % stehen in zwei Zeilen, nicht in einer', () => {
    const text = bon({ ermaessigt3: 240, besonders: 777 })
    expect(text).toContain('Netto 2,29 EUR USt 0,11 EUR')   // 4,9 %
    expect(text).toContain('Netto 6,53 EUR USt 1,24 EUR')   // 19 %
  })

  it('ohne 4,9 % keine Zeile dafür', () => {
    expect(bon({ normal: 1200 })).not.toContain('4,9 %')
  })
})

describe('Layout-Zuordnung (Export ↔ Import) mit 4,9 %', () => {
  it('0,049 ist ermaessigt3 und zurück', () => {
    expect(mwstZuSatz(0.049)).toBe('ermaessigt3')
    expect(satzZuMwst('ermaessigt3')).toBe(0.049)
  })

  it('der befristete Satz 5 % von 2020–2022 wird NICHT stillschweigend zu 4,9 %', () => {
    expect(mwstZuSatz(0.05)).toBeUndefined()
  })

  it('alle Sätze laufen verlustfrei hin und zurück', () => {
    for (const satz of SAETZE) expect(mwstZuSatz(satzZuMwst(satz)!), satz).toBe(satz)
  })

  it('ganze Prozent und Promille lassen sich nicht verwechseln (13 % ≠ 1,3 %, 19 % ≠ 1,9 %)', () => {
    expect(mwstZuSatz(0.13)).toBe('ermaessigt2')
    expect(mwstZuSatz(0.013)).toBeUndefined()
    expect(mwstZuSatz(0.19)).toBe('besonders')
    expect(mwstZuSatz(0.019)).toBeUndefined()
  })
})
