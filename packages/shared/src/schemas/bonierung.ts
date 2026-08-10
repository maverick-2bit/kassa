/**
 * Bonierung = Bestellaufnahme.
 * Wird VOR der Rechnungserstellung an das KDS gesendet (Küche/Schank/...).
 * Erzeugt KEINEN RKSV-Beleg, sondern Bonierbons im Asello-Klartextformat.
 */

import { z } from 'zod'
import { StationSchema, STATION_LABELS } from './station.js'

export const BonierungPositionSchema = z.object({
  artikelId: z.string().uuid(),
  menge:     z.number().int().positive(),
  details:   z.string().trim().max(120).optional(),
  /** Gang-Nummer (Coursing) — nur zur Sortierung/Gruppierung auf dem Bon */
  gang:      z.number().int().min(0).max(9).optional(),
})

export const BonierungInputSchema = z.object({
  kasseId: z.string().uuid(),
  /** Optionaler Verweis auf den Tisch-Tab — wenn gesetzt, wird das Ereignis im Verlauf protokolliert */
  tabId:   z.string().uuid().optional(),
  /** Tischbezeichnung. Optional: leer = Direktverkauf an der Schank (Bon-Label „Direkt"). */
  tisch:   z.string().trim().max(40).optional(),
  bereich: z.string().trim().max(60).optional(),
  kellner: z.string().trim().min(1).max(60),
  positionen: z.array(BonierungPositionSchema).min(1, 'Mindestens eine Position erforderlich'),
  /**
   * Nur drucken (KDS + Bonierdrucker), KEIN Lagerabzug. Für Tisch-Bonierungen
   * (Parken/Sofort-Kassieren) — dort zieht aktualisiereStockDeltas den Lagerstand
   * bereits ab; ohne dieses Flag käme es zum Doppel-Abzug.
   */
  ohneLagerabzug: z.boolean().optional(),
  /**
   * Korrekturbon statt Bestellbon: invertierter „*** STORNO *** / NICHT
   * ZUBEREITEN"-Kopf. Wird gebraucht, um einen nicht zugestellten Storno-Bon
   * gezielt nachzusenden.
   */
  storno:         z.boolean().optional(),
})
export type BonierungInput = z.infer<typeof BonierungInputSchema>

export const BonierungErgebnisSchema = z.object({
  bonNummer:    z.string(),
  stationen: z.array(z.object({
    station:     StationSchema,
    ip:          z.string(),
    positionen:  z.number().int(),
    erfolgreich: z.boolean(),
    fehler:      z.string().optional(),
  })),
  /** Ergebnisse für ESC/POS Bonierdrucker (inkl. Backup-Drucker) */
  drucker: z.array(z.object({
    druckerId:   z.string().uuid(),
    name:        z.string(),
    ip:          z.string(),
    positionen:  z.number().int(),
    erfolgreich: z.boolean(),
    fehler:      z.string().optional(),
    istBackup:   z.boolean(),
  })).default([]),
})
export type BonierungErgebnis = z.infer<typeof BonierungErgebnisSchema>

/** Ein Ziel (KDS-Station oder Bonierdrucker), das den Bon NICHT bekommen hat. */
export interface BonierZielFehler {
  /** Anzeigename: Stations-Label bzw. Druckername */
  ziel:      string
  ip:        string
  fehler:    string
  /** Zweitdrucker (bekommt eine Kopie aller Positionen) statt Hauptziel */
  istBackup: boolean
}

/**
 * Ziele, die den Bonierbon nicht erhalten haben.
 *
 * Einzige Quelle für die Frage „ist der Küchenbon angekommen?" — Backend
 * (HTTP-Status), Kassen-Oberfläche und Kellner-App bewerten damit dasselbe.
 * Vorher prüfte der Server nur die KDS-Stationen: ein toter Bonierdrucker,
 * also der Drucker in der Küche, lieferte glatte 200.
 *
 * Zweitdrucker bekommen eine Kopie ALLER Positionen (nicht erst, wenn der
 * Hauptdrucker ausfällt) — ein stummer Zweitdrucker ist deshalb ebenfalls ein
 * echter Fehlschlag, nur ein weniger dringender. `istBackup` macht das für die
 * Anzeige unterscheidbar.
 */
export function bonierFehlschlaege(ergebnis: BonierungErgebnis): BonierZielFehler[] {
  const fehlend: BonierZielFehler[] = []

  for (const s of ergebnis.stationen) {
    if (s.erfolgreich) continue
    fehlend.push({
      ziel:      STATION_LABELS[s.station] ?? s.station,
      ip:        s.ip,
      fehler:    s.fehler ?? 'unbekannter Fehler',
      istBackup: false,
    })
  }

  for (const d of ergebnis.drucker) {
    if (d.erfolgreich) continue
    fehlend.push({
      ziel:      d.name,
      ip:        d.ip,
      fehler:    d.fehler ?? 'unbekannter Fehler',
      istBackup: d.istBackup,
    })
  }

  return fehlend
}
