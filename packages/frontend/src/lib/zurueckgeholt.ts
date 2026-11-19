/**
 * „Zurückholen" (Auswertung → Belege): Ein Barzahlungsbeleg wird auf SEINER Kasse storniert,
 * seine Positionen landen im Warenkorb dieses Geräts — korrigieren und neu kassieren.
 *
 * Die Belege-Seite legt den stornierten Beleg hier ab (sessionStorage, nur dieser Tab) und
 * wechselt zur Kasse; die Kasse übernimmt ihn beim Öffnen und löscht ihn wieder.
 *
 * Die Positionen kommen als FREIE Positionen zurück (Bezeichnung, Preis, MwSt wie gebucht):
 *  - Der Storno bucht keinen Lagerstand zurück. Als Artikel-Position würde der neue Verkauf das
 *    Lager ein zweites Mal abziehen und Küchenbons erneut auslösen.
 *  - Der Beleg speichert keine Artikel-ID; Preise, Rabatte und Optionen bleiben genau so, wie
 *    sie bezahlt wurden.
 */
import type { BelegResponse, KundeSnapshot, MwStSatz } from '@kassa/shared'

const SCHLUESSEL = 'kassa-zurueckgeholt'

export interface ZurueckgeholtePosition {
  bezeichnung: string
  menge:       number
  preisCent:   number
  mwstSatz:    MwStSatz
}

export interface ZurueckgeholterBeleg {
  belegNummer:      number
  kasseBezeichnung: string
  stornoNummer:     number
  positionen:       ZurueckgeholtePosition[]
  kunde?:           KundeSnapshot
}

const mengeText = (m: number) => m.toLocaleString('de-AT', { maximumFractionDigits: 3 })

/**
 * Beleg-Positionen → Warenkorb-Positionen. Freie Positionen kennen nur ganze Mengen:
 * eine Gewichts-/Bruchmenge (0,5 kg) wird zu „0,5 × Bezeichnung" mit Menge 1 und dem
 * gebuchten Zeilenbetrag.
 */
export function positionenAusBeleg(beleg: BelegResponse): ZurueckgeholtePosition[] {
  return beleg.positionen.map(p => {
    const mwstSatz = p.mwstSatz as MwStSatz
    if (Number.isInteger(p.menge)) {
      return { bezeichnung: p.bezeichnung, menge: p.menge, preisCent: p.einzelpreisBreutto, mwstSatz }
    }
    return {
      bezeichnung: `${mengeText(p.menge)} × ${p.bezeichnung}`,
      menge:       1,
      preisCent:   Math.round(p.menge * p.einzelpreisBreutto),
      mwstSatz,
    }
  })
}

export function merkeZurueckgeholt(z: ZurueckgeholterBeleg): void {
  try { sessionStorage.setItem(SCHLUESSEL, JSON.stringify(z)) } catch { /* privater Modus: dann ohne Übergabe */ }
}

export function leseZurueckgeholt(): ZurueckgeholterBeleg | null {
  try {
    const roh = sessionStorage.getItem(SCHLUESSEL)
    if (!roh) return null
    const z = JSON.parse(roh) as ZurueckgeholterBeleg
    return Array.isArray(z.positionen) ? z : null
  } catch {
    return null
  }
}

export function vergissZurueckgeholt(): void {
  try { sessionStorage.removeItem(SCHLUESSEL) } catch { /* egal */ }
}
