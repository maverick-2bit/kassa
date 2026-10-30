import { z } from 'zod'
import { StationSchema } from './station.js'
import { BelegModusEnum, GastModusEnum, StartseitenEnum } from './bonierdrucker.js'

// ---------------------------------------------------------------------------
// Einrichtungs-Übersicht (Einstellungen → Kassen): alle Kassen mit Druckern,
// Warengruppen und KDS auf einen Blick — und Ausnahmen je Kasse beim Bon-Routing
// ---------------------------------------------------------------------------

/**
 * Kassen-Ausnahme beim Bon-Routing (Tabelle kasse_routing): an dieser Kasse druckt eine Warengruppe
 * bzw. ein Artikel auf einem anderen Drucker / geht an eine andere KDS-Station als die allgemeine Vorgabe.
 * Genau eines von kategorieId / artikelId ist gesetzt. „keiner" = ausdrücklich kein Drucker / keine Station.
 */
export const RoutingAusnahmeSchema = z.object({
  kasseId:         z.string().guid(),
  kategorieId:     z.string().guid().nullable(),
  artikelId:       z.string().guid().nullable(),
  bonierdruckerId: z.string().guid().nullable(),
  keinDrucker:     z.boolean(),
  station:         StationSchema.nullable(),
  keineStation:    z.boolean(),
})
export type RoutingAusnahme = z.infer<typeof RoutingAusnahmeSchema>

/** Eine Kasse mit allem, was die Übersicht je Kasse zeigt und ändert. */
export const EinrichtungKasseSchema = z.object({
  id:               z.string().guid(),
  kassenId:         z.string(),
  bezeichnung:      z.string().nullable(),
  status:           z.string(),
  umgebung:         z.string(),
  seeGueltigBis:    z.string(),
  beiFoRegistriert: z.boolean(),
  /** ISO-Zeitpunkt der Außerbetriebnahme; null = in Betrieb */
  ausserBetriebAm:  z.string().nullable(),

  // Belegausgabe + Rechnungsdrucker (Bibliothek „drucker")
  belegModus: BelegModusEnum,
  druckerId:  z.string().guid().nullable(),

  // Gast-Bestellung per Tisch-QR
  gastModus:    GastModusEnum,
  gastBasisUrl: z.string().nullable(),

  // KDS
  kdsAktiv:     z.boolean(),
  kdsPort:      z.number().int(),
  /** Stations-Slug → IP (nur TCP-Hardware-Displays; für Browser-Displays leer) */
  // zod 4: z.record mit Enum-Schlüsseln verlangt ALLE Schlüssel — hier sind es nur die eingerichteten Stationen
  kdsStationen: z.partialRecord(StationSchema, z.string()),

  startseite:            StartseitenEnum,
  erlaubteZahlungsarten: z.array(z.enum(['bar', 'karte', 'sonstige'])),

  /**
   * Artikelwahl (Direktverkauf, Tisch, Kellner-App) öffnet mit den Favoriten (Standard) …
   * … oder mit dieser Warengruppe (nur wirksam, wenn startFavoriten false ist; null = erste Warengruppe mit Artikeln).
   * Hat die Kasse genau eine Warengruppe, öffnet sie sich ohnehin von selbst (shared/start-reiter).
   */
  startFavoriten:   z.boolean(),
  startKategorieId: z.string().guid().nullable(),

  /** Direktverkauf: Optionen/Varianten abfragen (Warengruppe/Artikel können abweichen; Tische fragen immer) */
  optionenAbfrage:  z.boolean(),

  /** Sichtbare Warengruppen (leer = alle) */
  sichtbareKategorieIds:     z.array(z.string().guid()),
  /** Aktive Bonierdrucker dieser Kasse (leer = alle) */
  sichtbareBonierdruckerIds: z.array(z.string().guid()),
})
export type EinrichtungKasse = z.infer<typeof EinrichtungKasseSchema>

export const EinrichtungSchema = z.object({
  kassen:    z.array(EinrichtungKasseSchema),
  ausnahmen: z.array(RoutingAusnahmeSchema),
})
export type Einrichtung = z.infer<typeof EinrichtungSchema>

/**
 * Änderung EINER Ausnahme (eine Zelle der Matrix). Nur angegebene Felder ändern sich:
 *  - drucker: null = Standard (Ausnahme für den Drucker entfernen) · 'keiner' = an dieser Kasse kein
 *             Bonierdrucker · UUID = dieser Bonierdrucker
 *  - station: null = Standard · 'keine' = an dieser Kasse keine KDS-Station · sonst die Station
 * Eine Ausnahme ohne jede Angabe wird gelöscht.
 */
export const RoutingAenderungSchema = z.object({
  kasseId:     z.string().guid(),
  kategorieId: z.string().guid().optional(),
  artikelId:   z.string().guid().optional(),
  drucker:     z.union([z.literal('keiner'), z.string().guid()]).nullable().optional(),
  station:     z.union([z.literal('keine'), StationSchema]).nullable().optional(),
})
  .refine(a => (a.kategorieId === undefined) !== (a.artikelId === undefined), {
    message: 'Genau eine Warengruppe ODER ein Artikel angeben',
  })
  .refine(a => a.drucker !== undefined || a.station !== undefined, {
    message: 'Drucker oder Station angeben',
  })
export type RoutingAenderung = z.infer<typeof RoutingAenderungSchema>

export const RoutingAenderungenSchema = z.object({
  aenderungen: z.array(RoutingAenderungSchema).min(1).max(2000),
})
export type RoutingAenderungen = z.infer<typeof RoutingAenderungenSchema>

/** Einrichtung einer Kasse von einer anderen übernehmen (z. B. nach dem Anlegen). */
export const EinrichtungKopierenSchema = z.object({
  vonKasseId: z.string().guid(),
})
export type EinrichtungKopieren = z.infer<typeof EinrichtungKopierenSchema>
