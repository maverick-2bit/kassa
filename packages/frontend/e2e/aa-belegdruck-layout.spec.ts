import { test, expect } from '@playwright/test'
import {
  generiereAngebotHtml,
  generiereSammelrechnungHtml,
} from '../src/lib/rechnung'
import { generiereRechnungHtml } from '@kassa/shared'

/**
 * Layout-Prüfung der A4-Belege — rendert das erzeugte HTML direkt, ohne Server.
 *
 * Geprüft wird die Bündigkeit des Summenblocks: sein rechter Rand muss mit dem
 * Ende der Positionstabelle abschließen. Das ging schon einmal verloren, weil
 * das `flex: 1` auf der Steuertabelle statt auf ihrem Flex-Wrapper saß — der
 * Block rutschte dadurch rund 108 px (≈28 mm) nach links.
 *
 * aa-Präfix: läuft vor den Journeys, braucht keine eingerichtete Instanz.
 */

const mandant = {
  firmenname: 'Test GmbH',
  strasse:    'Weg 1',
  plz:        '1010',
  ort:        'Wien',
  uid:        'ATU12345678',
} as Parameters<typeof generiereAngebotHtml>[1]

const positionen = [
  { bezeichnung: 'Pizza Margherita', menge: 2, einzelpreisBreutto: 1150, mwstSatz: 'ermaessigt1' },
  { bezeichnung: 'Cola 0,33',        menge: 3, einzelpreisBreutto: 350,  mwstSatz: 'normal' },
]
const GESAMT = 2 * 1150 + 3 * 350

const kunde = {
  kundeName: 'Muster GmbH', kundeStrasse: 'Gasse 2',
  kundePlz: '1020', kundeOrt: 'Wien', kundeUid: null,
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const angebot = {
  id: 'a1', angebotNummer: 7, datum: new Date().toISOString(), gueltigBis: null,
  status: 'offen', positionen, gesamtbetragCent: GESAMT, notiz: null, ...kunde,
} as any

const lieferschein = {
  id: 'l1', lieferscheinNummer: 11, datum: new Date().toISOString(),
  positionen, angebotNummer: 7, ...kunde,
} as any

const sammelrechnung = {
  id: 's1', rechnungNummer: 3, datum: new Date().toISOString(),
  gesamtbetragCent: GESAMT, status: 'offen', notiz: null,
  lieferscheine: [lieferschein], ...kunde,
} as any

const beleg = {
  belegNummer: 42, belegDatum: new Date().toISOString(), belegTyp: 'Barzahlungsbeleg',
  positionen, summeBarCent: GESAMT, summeKarteCent: 0, summeSonstigeCent: 0,
  betraege: { normal: 1050, ermaessigt1: 2300, ermaessigt2: 0, null: 0, besonders: 0 },
} as any
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Belege MIT Preisen — nur die haben einen Summenblock.
 *  Der Lieferschein führt bewusst keine Preise und ist hier außen vor. */
const FAELLE: Array<[string, string]> = [
  ['Angebot',        generiereAngebotHtml(angebot, mandant)],
  ['Sammelrechnung', generiereSammelrechnungHtml(sammelrechnung, mandant)],
  ['Rechnung',       generiereRechnungHtml(beleg, mandant)],
]

for (const [name, html] of FAELLE) {
  test(`${name}: Summenblock schließt rechtsbündig mit der Positionstabelle ab`, async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 1754 })   // A4 @ 150 dpi
    await page.setContent(html)

    await expect(page.locator('.gesamt-box')).toHaveCount(1)

    const kanten = await page.evaluate(() => {
      const tabellen = [...document.querySelectorAll('.positionen-tabelle')]
      const b = document.querySelector('.gesamt-box')!.getBoundingClientRect()
      const t = tabellen[tabellen.length - 1]!.getBoundingClientRect()
      return { tabelle: t.right, box: b.right }
    })

    // 1 px Rundungstoleranz — mehr wäre sichtbarer Versatz auf dem Ausdruck
    expect(Math.abs(kanten.box - kanten.tabelle)).toBeLessThanOrEqual(1)
  })
}
