import { z } from 'zod'
import { GeburtsdatumSchema, type TicketEventStatus } from './ticket.js'

// ---------------------------------------------------------------------------
// Ticketshop (Ticketing Release 3) — Online-Kauf mit Stripe
// ---------------------------------------------------------------------------

/**
 * So lange hält eine Bestellung ihre Tickets während der Zahlung fest. Stripe
 * verlangt für das Ablaufdatum einer Checkout-Session mindestens 30 Minuten —
 * die 2 Minuten Zuschlag fangen eine leicht nachgehende Uhr ab. Den Gästen
 * wird „30 Minuten" genannt.
 */
export const TICKETSHOP_RESERVIERUNG_MINUTEN = 32

/** Vorschlag für den Kaufhinweis (Backoffice übernimmt ihn auf Knopfdruck) */
export const TICKETSHOP_KAUFHINWEIS_VORSCHLAG =
  'Kein Rücktrittsrecht: Tickets für Freizeitveranstaltungen mit fixem Termin sind nach ' +
  '§ 18 Abs. 1 Z 10 FAGG vom Rücktrittsrecht ausgenommen.'

/** Ein Ticket im Kaufformular — je Gast, denn das Band hängt am Geburtsdatum des Gastes */
export const ShopTicketEingabeSchema = z.object({
  ticketArtId:  z.string().uuid(),
  /** Pflicht, wenn das Event personalisierte Tickets verlangt (prüft der Server) */
  name:         z.string().trim().max(200).optional(),
  geburtsdatum: GeburtsdatumSchema,
})
export type ShopTicketEingabe = z.infer<typeof ShopTicketEingabeSchema>

/** Rechnung auf Firma — optional; ohne sie genügt der Kassenbeleg */
export const ShopRechnungSchema = z.object({
  firma:   z.string().trim().min(1, 'Firma erforderlich').max(200),
  strasse: z.string().trim().min(1, 'Straße erforderlich').max(200),
  plz:     z.string().trim().min(1, 'PLZ erforderlich').max(20),
  ort:     z.string().trim().min(1, 'Ort erforderlich').max(100),
  land:    z.string().trim().length(2).default('AT'),
  uid:     z.string().trim().max(30).optional(),
})
export type ShopRechnung = z.infer<typeof ShopRechnungSchema>

export const ShopBestellungInputSchema = z.object({
  eventId: z.string().uuid(),
  kaeufer: z.object({
    name:  z.string().trim().min(1, 'Name erforderlich').max(200),
    email: z.string().trim().email('Ungültige E-Mail-Adresse').max(254),
  }),
  tickets:  z.array(ShopTicketEingabeSchema).min(1, 'Mindestens ein Ticket wählen').max(50),
  rechnung: ShopRechnungSchema.nullable().optional(),
  agbAkzeptiert: z.literal(true, { errorMap: () => ({ message: 'Bitte den Bedingungen zustimmen' }) }),
})
export type ShopBestellungInput = z.infer<typeof ShopBestellungInputSchema>

/** Verkaufsstand einer Ticketart im Shop */
export type ShopArtStatus = 'verfuegbar' | 'ausverkauft' | 'noch_nicht' | 'beendet'

export interface ShopTicketArt {
  id:               string
  bezeichnung:      string
  beschreibung:     string | null
  preisCent:        number
  maxProBestellung: number
  /** Noch frei; null = unbegrenzt */
  verfuegbar:       number | null
  status:           ShopArtStatus
  verkaufAb:        string | null
  verkaufBis:       string | null
}

export interface ShopRechtliches {
  agbUrl:         string | null
  datenschutzUrl: string | null
  impressumUrl:   string | null
  kaufhinweis:    string | null
}

/** Eventseite im Shop — ohne Zahlen, die niemanden draußen etwas angehen */
export interface ShopEvent {
  id:           string
  titel:        string
  beschreibung: string | null
  beginn:       string
  ende:         string | null
  ort:          string
  adresse:      string | null
  hinweis:      string | null
  veranstalter: string
  status:       TicketEventStatus
  mindestalter: number | null
  namePflicht:  boolean
  arten:        ShopTicketArt[]
  /** Firmenname des Verkäufers (Mandant) */
  verkaeufer:   string
  rechtliches:  ShopRechtliches
  /** false = Verkauf (noch) nicht möglich — Grund in verkaufHinweis */
  verkaufOffen:   boolean
  verkaufHinweis: string | null
}

export interface ShopEventKurz {
  id:          string
  titel:       string
  beginn:      string
  ende:        string | null
  ort:         string
  hinweis:     string | null
  /** Günstigste online erhältliche Ticketart; null = keine */
  abPreisCent: number | null
  ausverkauft: boolean
}

/** Übersicht aller kommenden Events eines Veranstalters */
export interface ShopVeranstalter {
  firmenname:  string
  events:      ShopEventKurz[]
  rechtliches: ShopRechtliches
}

export interface ShopBestellungAntwort {
  bestellungId: string
  /** Stripe-Bezahlseite; null = schon erledigt (kostenlos bzw. Demo ohne Stripe) */
  checkoutUrl:  string | null
}

/** Was der Käufer über seine Bestellung sieht ('finalisiere' erscheint als 'zahlung') */
export type ShopBestellStatus = 'zahlung' | 'bezahlt' | 'abgelaufen' | 'abgebrochen'

export interface ShopBestellung {
  id:      string
  status:  ShopBestellStatus
  eventId: string
  event:   { titel: string; beginn: string; ort: string; adresse: string | null }
  summeCent:  number
  positionen: Array<{ bezeichnung: string; menge: number; preisCent: number }>
  /** Erst nach der Zahlung — vorher gibt es die Tickets nach außen nicht */
  tickets:    Array<{ code: string; bezeichnung: string; name: string | null }>
  /** z. B. „m…@example.at" — bestätigt die Adresse, ohne sie offenzulegen */
  emailMaskiert: string
  /** Die Seite verspricht keine E-Mail, die nicht rausging (z. B. SMTP fehlt) */
  emailStatus:   'gesendet' | 'ausstehend' | 'fehlgeschlagen'
  belegNummer:   number | null
  /** Bis dahin sind die Tickets reserviert (nur bei 'zahlung') */
  reserviertBis: string | null
}

// ---------------------------------------------------------------------------
// Backoffice
// ---------------------------------------------------------------------------

const UrlOderNull = z.string().trim().url('Vollständige Adresse inkl. https://').max(300).nullable()

export const TicketShopEinstellungenSchema = z.object({
  /** Kasse, auf der die RKSV-Belege der Online-Verkäufe entstehen; null = Verkauf aus */
  verkaufKasseId: z.string().uuid().nullable(),
  agbUrl:         UrlOderNull,
  datenschutzUrl: UrlOderNull,
  impressumUrl:   UrlOderNull,
  kaufhinweis:    z.string().trim().max(2000).nullable(),
})
export type TicketShopEinstellungen = z.infer<typeof TicketShopEinstellungenSchema>

export interface TicketShopEinstellungenAntwort extends TicketShopEinstellungen {
  stripe: {
    /** Online-Zahlung möglich (eigenes Konto oder globaler Schlüssel) */
    konfiguriert: boolean
    eigenesKonto: boolean
  }
  /** Übersichtsseite aller Events; null solange die Ticket-Adresse fehlt */
  shopUrl: string | null
}

export type TicketBestellungStatus = 'zahlung' | 'finalisiere' | 'bezahlt' | 'abgelaufen' | 'abgebrochen'

export const TICKET_BESTELLUNG_STATUS_LABELS: Record<TicketBestellungStatus, string> = {
  zahlung:     'Zahlung offen',
  finalisiere: 'Wird abgeschlossen',
  bezahlt:     'Bezahlt',
  abgelaufen:  'Abgelaufen',
  abgebrochen: 'Abgebrochen',
}

export interface TicketBestellungAdmin {
  id:              string
  status:          TicketBestellungStatus
  name:            string
  email:           string
  rechnungFirma:   string | null
  summeCent:       number
  anzahlTickets:   number
  positionen:      Array<{ bezeichnung: string; menge: number; preisCent: number }>
  createdAt:       string
  bezahltAt:       string | null
  belegNummer:     number | null
  emailGesendetAt: string | null
  emailFehler:     string | null
}

export const TicketBestellungSendenSchema = z.object({
  /** Leer = an die Adresse des Käufers */
  email: z.string().trim().email('Ungültige E-Mail-Adresse').max(254).optional(),
})
export type TicketBestellungSenden = z.infer<typeof TicketBestellungSendenSchema>
