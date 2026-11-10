/**
 * Sprachbestellung — Zwischenspeicher für den Katalog-Index je Mandant (rein, ohne DB/IO).
 *
 * Der Index wird beim ersten Satz eines Mandanten gebaut (Laden + Wort-Index, ~70 ms bei 2000 Artikeln)
 * und danach wiederverwendet. Frisch bleibt er über zwei Wege:
 *  - `verwerfen(mandantId)`, wenn die Synonyme geändert werden (sofort wirksam),
 *  - eine Lebensdauer (Standard 30 s) für alles andere (neue/umbenannte Artikel, Optionen).
 * Gleichzeitige Anfragen eines Mandanten teilen sich EIN Laden. Die Zahl der gehaltenen Mandanten ist
 * begrenzt (ältester fliegt raus), damit der Speicher nicht mit der Zahl der Betriebe wächst.
 */

import type { SprachKatalog } from './katalog.js'

export interface KatalogCacheOptionen {
  /** Lädt und baut den Katalog eines Mandanten. */
  lade:         (mandantId: string) => Promise<SprachKatalog>
  ttlMs?:       number
  maxMandanten?: number
  /** Uhr (für Tests) */
  jetzt?:       () => number
}

interface Eintrag {
  katalog:  Promise<SprachKatalog>
  geladenAm: number
}

export const KATALOG_TTL_MS = 30_000
export const KATALOG_MAX_MANDANTEN = 20

export class KatalogCache {
  private readonly eintraege = new Map<string, Eintrag>()
  private readonly lade: (mandantId: string) => Promise<SprachKatalog>
  private readonly ttlMs: number
  private readonly maxMandanten: number
  private readonly jetzt: () => number

  constructor(opt: KatalogCacheOptionen) {
    this.lade = opt.lade
    this.ttlMs = opt.ttlMs ?? KATALOG_TTL_MS
    this.maxMandanten = opt.maxMandanten ?? KATALOG_MAX_MANDANTEN
    this.jetzt = opt.jetzt ?? Date.now
  }

  /** Katalog des Mandanten — aus dem Speicher, solange er frisch ist, sonst neu geladen. */
  holen(mandantId: string): Promise<SprachKatalog> {
    const vorhanden = this.eintraege.get(mandantId)
    if (vorhanden && this.jetzt() - vorhanden.geladenAm < this.ttlMs) return vorhanden.katalog

    const katalog = this.lade(mandantId)
    // Fehlgeschlagenes Laden nicht merken: der nächste Satz versucht es neu
    katalog.catch(() => { if (this.eintraege.get(mandantId)?.katalog === katalog) this.eintraege.delete(mandantId) })

    this.eintraege.delete(mandantId) // Einfügereihenfolge = Alter (neu geladen = jüngster)
    this.eintraege.set(mandantId, { katalog, geladenAm: this.jetzt() })
    while (this.eintraege.size > this.maxMandanten) {
      const aeltester = this.eintraege.keys().next().value
      if (aeltester === undefined) break
      this.eintraege.delete(aeltester)
    }
    return katalog
  }

  /** Nach Änderungen am Katalog des Mandanten (z. B. Synonyme): nächster Satz lädt neu. */
  verwerfen(mandantId: string): void {
    this.eintraege.delete(mandantId)
  }

  get groesse(): number {
    return this.eintraege.size
  }
}
