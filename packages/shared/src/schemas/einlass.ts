import { z } from 'zod'
import type {
  TicketBand,
  TicketBandAnzeige,
  TicketEinlassStand,
  TicketEventStatus,
  TicketTyp,
} from './ticket.js'

// ---------------------------------------------------------------------------
// Einlass — Scan-Ergebnisse, Geräte, Protokoll
// ---------------------------------------------------------------------------

/**
 * Ergebnis eines Scans. Nur `zugelassen` und `mehrfach` lassen den Gast rein.
 * `mehrfach` = Mehrfachticket (Crew …): Einlass ja, Besucherzahl nur beim ersten Mal.
 */
export const EinlassErgebnisArtSchema = z.enum([
  'zugelassen',
  'mehrfach',
  'bereits_eingeloest',
  'storniert',
  'abgesagt',
  'falsches_event',
  'nicht_bezahlt',
  'nicht_freigegeben',
  'unbekannt',
])
export type EinlassErgebnisArt = z.infer<typeof EinlassErgebnisArtSchema>

export const EINLASS_ZUGELASSEN: ReadonlySet<EinlassErgebnisArt> = new Set(['zugelassen', 'mehrfach'])

/** Kurzer Titel fürs große Ergebnisfeld am Einlass. */
export const EINLASS_ERGEBNIS_TITEL: Record<EinlassErgebnisArt, string> = {
  zugelassen:         'Einlass',
  mehrfach:           'Mehrfachticket',
  bereits_eingeloest: 'Bereits eingelöst',
  storniert:          'Storniert',
  abgesagt:           'Event abgesagt',
  falsches_event:     'Anderes Event',
  nicht_bezahlt:      'Nicht bezahlt',
  nicht_freigegeben:  'Event nicht freigegeben',
  unbekannt:          'Kein gültiges Ticket',
}

export const EinlassScanInputSchema = z.object({
  eventId: z.string().uuid(),
  /** Roher QR-Inhalt oder eingetippter Code — der Server erkennt den Code selbst */
  inhalt:  z.string().trim().min(1).max(500),
})
export type EinlassScanInput = z.infer<typeof EinlassScanInputSchema>

/** Ticket, wie es das Einlasspersonal sieht — MIT Geburtsdatum zum Abgleich mit dem Ausweis. */
export interface EinlassTicket {
  code:                string
  typ:                 TicketTyp
  rolle:               string | null
  bezeichnung:         string
  name:                string | null
  geburtsdatum:        string | null
  /** Alter am Eventtag */
  alter:               number | null
  band:                TicketBandAnzeige | null
  einlassAnzahl:       number
  ersterEinlassAt:     string | null
  ersterEinlassGeraet: string | null
}

export interface EinlassErgebnis {
  ergebnis:   EinlassErgebnisArt
  zugelassen: boolean
  /** null bei „unbekannt" */
  ticket:     EinlassTicket | null
  /** Bei „falsches_event": wofür das Ticket eigentlich gilt */
  anderesEvent?: { titel: string; beginn: string }
  /** Einlass-Stand NACH diesem Scan — die Besucherzahl bleibt so immer aktuell */
  stand:      TicketEinlassStand
}

/** Event in der Auswahl der Einlass-App */
export interface EinlassEvent {
  id:       string
  titel:    string
  beginn:   string
  ort:      string
  status:   TicketEventStatus
  tickets:  number
  besucher: number
}

// ---------------------------------------------------------------------------
// Geräte (Backoffice)
// ---------------------------------------------------------------------------

export const EinlassGeraetAnlegenSchema = z.object({
  name: z.string().trim().min(1, 'Name erforderlich').max(60),
})
export type EinlassGeraetAnlegen = z.infer<typeof EinlassGeraetAnlegenSchema>

export interface EinlassGeraet {
  id:             string
  name:           string
  erstelltAt:     string
  zuletztAktivAt: string | null
  widerrufenAt:   string | null
}

export interface EinlassGeraetAngelegt {
  geraet: EinlassGeraet
  /** Langlebiger Geräte-Token — nur EINMAL ausgeliefert, steckt im QR */
  token:  string
  /** Einrichtungs-Link für den QR; null solange die Einlass-Adresse fehlt */
  url:    string | null
}

/** Das Einlass-Gerät über sich selbst (Kopfzeile der App) */
export interface EinlassIch {
  geraet:     { id: string; name: string }
  firmenname: string
}

export interface EinlassLogEintrag {
  id:          string
  zeitpunkt:   string
  geraetName:  string | null
  ergebnis:    EinlassErgebnisArt
  code:        string
  offline:     boolean
  /** Offline-Scan: was das Gerät ohne Verbindung entschieden hat */
  lokal:       EinlassErgebnisArt | null
  /** Offline eingelassen, der Server hätte abgewiesen (z. B. Kopie an zwei Eingängen) */
  konflikt:    boolean
  /** Ticket-Titel + Name, wenn das Ticket bekannt ist */
  ticket:      { bezeichnung: string; typ: TicketTyp; name: string | null } | null
}

// ---------------------------------------------------------------------------
// Offline-Einlass (Release 4)
// ---------------------------------------------------------------------------

/**
 * Ein Ticket in der Offline-Liste des Scanners. Statt des Codes steht nur
 * dessen SHA-256 auf dem Gerät (`ticketCodeHash`) — wer ein Einlass-Handy
 * findet, kann daraus keine gültigen QR-Codes bauen.
 */
export interface EinlassOfflineTicket {
  /** SHA-256 des Ticket-Codes (hex) */
  h:                   string
  typ:                 TicketTyp
  rolle:               string | null
  bezeichnung:         string
  name:                string | null
  geburtsdatum:        string | null
  status:              'gueltig' | 'storniert'
  ersterEinlassAt:     string | null
  ersterEinlassGeraet: string | null
  einlassAnzahl:       number
}

export interface EinlassOfflineListe {
  eventId:      string
  /** Serverzeit der Liste — beim nächsten Abgleich als ?seit= zurückgeben */
  erstelltAt:   string
  /** true = komplette Liste; false = nur seit `seit` geänderte Tickets */
  vollstaendig: boolean
  event:        { titel: string; beginn: string; status: TicketEventStatus }
  baender:      TicketBand[]
  stand:        TicketEinlassStand
  tickets:      EinlassOfflineTicket[]
}

/** Scans, die ein Gerät ohne Verbindung entschieden hat — kommen gesammelt nach. */
export const EinlassSyncInputSchema = z.object({
  eventId: z.string().uuid(),
  scans: z.array(z.object({
    /** Vom Gerät vergeben — macht das Nachreichen wiederholbar (kein doppeltes Einlösen) */
    scanId:    z.string().uuid(),
    inhalt:    z.string().trim().min(1).max(500),
    zeitpunkt: z.string().datetime({ offset: true }),
    /** Entscheidung des Geräts ohne Verbindung */
    lokal:     EinlassErgebnisArtSchema,
  })).min(1).max(500),
})
export type EinlassSyncInput = z.infer<typeof EinlassSyncInputSchema>

export interface EinlassSyncErgebnis {
  scanId:   string
  /** Beurteilung durch den Server (bei lokal abgewiesenen Scans = die lokale Entscheidung) */
  ergebnis: EinlassErgebnisArt
  lokal:    EinlassErgebnisArt
  /** Gerät hat eingelassen, der Server hätte abgewiesen */
  konflikt: boolean
  ticket:   EinlassTicket | null
}

export interface EinlassSyncAntwort {
  ergebnisse: EinlassSyncErgebnis[]
  stand:      TicketEinlassStand
}
