import { z } from 'zod'

/**
 * Meldung einer Kassa-Box an das Serviceportal (Version 1).
 *
 * NUR technischer Zustand: Erreichbarkeit, Version, Sicherungen, Speicher, Geräte, Fehler. Keine Umsätze, Belege,
 * Kunden-, Artikel- oder Mitarbeiterdaten. Das Schema ist die Grenze: das Backend baut die Meldung genau so und
 * prüft sie vor dem Senden; das Portal prüft sie beim Empfang.
 */

export const PortalBackupSchema = z.object({
  letzteSicherung: z.string().nullable(),
  alterStunden:    z.number().nullable(),
  zustand:         z.enum(['ok', 'veraltet', 'fehlt']),
})

export const PortalDruckerSchema = z.object({
  quelle:     z.enum(['beleg', 'bonier']),
  name:       z.string().max(100),
  erreichbar: z.boolean(),
  geprueftAm: z.string(),
  fehler:     z.string().max(200).nullable(),
})

export const PortalKasseSchema = z.object({
  id:               z.string().guid(),
  kassenId:         z.string().max(40),
  bezeichnung:      z.string().max(200).nullable(),
  status:           z.string().max(20),
  umgebung:         z.string().max(20),
  seeTyp:           z.string().max(20),
  /** Signatureinheit ausgefallen seit … (null = in Betrieb) */
  seeAusgefallenSeit: z.string().nullable(),
  /** Ablauf des Signaturzertifikats */
  seeGueltigBis:    z.string(),
  /** Bons, die nicht zugestellt wurden und noch nicht bestätigt sind */
  offeneBonProbleme: z.number().int().nonnegative(),
})

export const PortalBetriebSchema = z.object({
  id:         z.string().guid(),
  firmenname: z.string().max(200),
  status:     z.string().max(20),
  kassen:     z.array(PortalKasseSchema),
  drucker:    z.array(PortalDruckerSchema),
})

export const PortalFehlerSchema = z.object({
  /** Gruppierung gleichartiger Fehler */
  hash:      z.string().max(40),
  name:      z.string().max(100),
  /** Bereinigt: keine IDs, Adressen, Zahlen- oder SQL-Werte */
  meldung:   z.string().max(300),
  route:     z.string().max(200).nullable(),
  mandantId: z.string().guid().nullable(),
  anzahl:    z.number().int().positive(),
  ersterAm:  z.string(),
  letzterAm: z.string(),
})
export type PortalFehler = z.infer<typeof PortalFehlerSchema>

export const PortalMeldungSchema = z.object({
  schema:     z.literal(1),
  gesendetAm: z.string(),
  version:    z.string().max(40),
  uptimeSek:  z.number().int().nonnegative(),
  db:         z.object({ ok: z.boolean(), latenzMs: z.number().nullable() }),
  backups:    z.object({ dbBackup: PortalBackupSchema, depBackup: PortalBackupSchema }),
  speicher:   z.object({
    zustand:     z.enum(['ok', 'knapp', 'kritisch', 'unbekannt']),
    gesamtGb:    z.number().nullable(),
    freiGb:      z.number().nullable(),
    freiProzent: z.number().nullable(),
  }),
  betriebe: z.array(PortalBetriebSchema),
  /** Seit der letzten erfolgreichen Meldung aufgelaufene Serverfehler (gruppiert) */
  fehler:   z.array(PortalFehlerSchema).max(200),
})
export type PortalMeldung = z.infer<typeof PortalMeldungSchema>

/** Stand der Verbindung zum Portal (GET /api/system/portal) */
export const PortalStatusSchema = z.object({
  aktiv:            z.boolean(),
  /** Nur der Host der Portal-Adresse (nie das Token) */
  host:             z.string().nullable(),
  intervallSekunden: z.number().int().nullable(),
  letzterErfolg:    z.string().nullable(),
  letzterVersuch:   z.string().nullable(),
  letzterFehler:    z.string().nullable(),
  /** Fehlgeschlagene Meldungen in Folge */
  fehlerInFolge:    z.number().int().nonnegative(),
})
export type PortalStatus = z.infer<typeof PortalStatusSchema>
