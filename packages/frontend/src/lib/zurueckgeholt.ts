/**
 * „Zurückholen" (Auswertung → Belege): Ein Barzahlungsbeleg wird auf SEINER Kasse storniert,
 * seine Positionen landen im Warenkorb dieses Geräts — korrigieren und neu kassieren.
 *
 * Der Storno ist sofort gebucht. Deshalb darf der Warenkorb danach nicht verloren gehen: Er liegt im
 * localStorage, je Kasse dieses Geräts, samt allen Änderungen — er übersteht Neuladen, Seitenwechsel und
 * Neustart. Weg ist er erst nach dem Kassieren oder wenn der Kassier ihn ausdrücklich verwirft.
 *
 * Ablauf: VOR dem Storno vormerken (status 'offen'), nach dem Storno fertig ('bereit'). Geht die Antwort des
 * Stornos verloren, klärt die Belege-Seite über die Belegliste, ob er gebucht ist.
 *
 * Die Positionen kommen als FREIE Positionen zurück (Bezeichnung, Preis, MwSt wie gebucht):
 *  - Der Storno bucht keinen Lagerstand zurück. Als Artikel-Position würde der neue Verkauf das
 *    Lager ein zweites Mal abziehen und Küchenbons erneut auslösen.
 *  - Der Beleg speichert keine Artikel-ID; Preise, Rabatte und Optionen bleiben genau so, wie
 *    sie bezahlt wurden.
 */
import type { BelegResponse, KundeSnapshot, MwStSatz } from '@kassa/shared'

const PRAEFIX = 'kassa:zurueckgeholt:'
/** So lange klärt die Belege-Seite einen Storno ohne Antwort; danach gilt die Vormerkung als erledigt. */
export const OFFEN_GILT_MS = 10 * 60_000

export interface ZurueckgeholtePosition {
  bezeichnung: string
  menge:       number
  preisCent:   number
  mwstSatz:    MwStSatz
}

export interface ZurueckgeholterBeleg {
  /** offen = Storno abgeschickt, Antwort steht aus; bereit = storniert, wartet aufs Kassieren */
  status:           'offen' | 'bereit'
  zeit:             number
  belegId:          string
  belegNummer:      number
  /** Kasse des Originalbelegs (auf ihr läuft der Storno) */
  belegKasseId:     string
  kasseBezeichnung: string
  stornoNummer?:    number
  positionen:       ZurueckgeholtePosition[]
  kunde?:           KundeSnapshot
  /** Bearbeiteter Stand der Kasse (Form bestimmt KassePage) */
  stand?:           unknown
  /** Idempotenz-Schlüssel des laufenden Verkaufs: derselbe Korb bucht auch nach einem Neuladen nicht doppelt */
  schluessel?:      string
}

const mengeText = (m: number) => m.toLocaleString('de-AT', { maximumFractionDigits: 3 })
/** Wie @kassa/rksv rundeCent: halbe Cent von Null weg — sonst wiche die Summe bei Retouren ab */
const rundeCent = (w: number) => (w < 0 ? -Math.round(-w) : Math.round(w)) || 0
/** Freie Positionen: höchstens 200 Zeichen */
const kuerze = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s)

/**
 * Beleg-Positionen → Warenkorb-Positionen. Freie Positionen kennen nur ganze Mengen:
 * eine Gewichts-/Bruchmenge (0,5 kg) wird zu „0,5 × Bezeichnung" mit Menge 1 und dem
 * gebuchten Zeilenbetrag. Seriennummern stehen in der Bezeichnung (der neue Beleg führt sie weiter auf).
 */
export function positionenAusBeleg(beleg: Pick<BelegResponse, 'positionen'>): ZurueckgeholtePosition[] {
  return beleg.positionen.map(p => {
    const mwstSatz = p.mwstSatz as MwStSatz
    const bezeichnung = p.seriennummern?.length ? `${p.bezeichnung} (SN ${p.seriennummern.join(', ')})` : p.bezeichnung
    if (Number.isInteger(p.menge)) {
      return { bezeichnung: kuerze(bezeichnung), menge: p.menge, preisCent: p.einzelpreisBreutto, mwstSatz }
    }
    return {
      bezeichnung: kuerze(`${mengeText(p.menge)} × ${bezeichnung}`),
      menge:       1,
      preisCent:   rundeCent(p.menge * p.einzelpreisBreutto),
      mwstSatz,
    }
  })
}

/**
 * Warum sich ein Beleg NICHT zurückholen lässt (null = geht). „Sonstige" Zahlung = Gutschein oder Kredit: Der Storno
 * gibt den eingelösten Gutschein und den offenen Posten nicht frei — beim neuen Kassieren zahlte der Gast doppelt.
 */
export function zurueckholenGesperrt(beleg: Pick<BelegResponse, 'summeSonstigeCent'>): string | null {
  return beleg.summeSonstigeCent !== 0
    ? 'Dieser Beleg wurde (teilweise) mit Gutschein oder auf Kredit bezahlt. Der Storno gibt den Gutschein und den offenen Posten nicht frei — beim neuen Kassieren würde der Gast doppelt zahlen. Bitte stornieren und Gutschein bzw. offenen Posten von Hand klären.'
    : null
}

/** false = konnte nicht gespeichert werden (Speicher gesperrt/voll) — dann darf nicht storniert werden */
export function merkeZurueckgeholt(kasseId: string, z: ZurueckgeholterBeleg): boolean {
  try {
    localStorage.setItem(PRAEFIX + kasseId, JSON.stringify(z))
    return true
  } catch {
    return false
  }
}

function lese(kasseId: string): ZurueckgeholterBeleg | null {
  try {
    const roh = localStorage.getItem(PRAEFIX + kasseId)
    if (!roh) return null
    const z = JSON.parse(roh) as ZurueckgeholterBeleg
    return Array.isArray(z.positionen) ? z : null
  } catch {
    return null
  }
}

/** Stornierter Beleg, der an dieser Kasse noch zu kassieren ist */
export function leseZurueckgeholt(kasseId: string): ZurueckgeholterBeleg | null {
  const z = lese(kasseId)
  return z?.status === 'bereit' ? z : null
}

/** Storno ohne Antwort, der noch zu klären ist */
export function leseOffenenStorno(kasseId: string, jetzt = Date.now()): ZurueckgeholterBeleg | null {
  const z = lese(kasseId)
  return z?.status === 'offen' && jetzt - z.zeit < OFFEN_GILT_MS ? z : null
}

export function vergissZurueckgeholt(kasseId: string): void {
  try { localStorage.removeItem(PRAEFIX + kasseId) } catch { /* egal */ }
}

/** Meldet, wenn ein anderer Tab den Warenkorb dieser Kasse kassiert oder verworfen hat */
export function beobachteVergessen(kasseId: string, fn: () => void): () => void {
  const h = (e: StorageEvent) => { if (e.key === PRAEFIX + kasseId && e.newValue === null) fn() }
  window.addEventListener('storage', h)
  return () => window.removeEventListener('storage', h)
}
