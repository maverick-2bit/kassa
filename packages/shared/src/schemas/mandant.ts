import { z } from 'zod'
import { PinLaengeSchema } from './auth.js'

// ---------------------------------------------------------------------------
// Mandanten-Module
// ---------------------------------------------------------------------------

export const MandantModulSchema = z.enum(['gastro', 'angebote', 'mergeport', 'reservierungen', 'zeiterfassung', 'sbTerminal', 'gaenge', 'tickets', 'sprache'])
export type MandantModul = z.infer<typeof MandantModulSchema>

export const MANDANT_MODUL_LABELS: Record<MandantModul, string> = {
  gastro:         'Gastro & Tischverwaltung',
  angebote:       'Angebote & Lieferscheine',
  mergeport:      'Lieferservice-Integration',
  reservierungen: 'Tischreservierungen',
  zeiterfassung:  'Personalzeiterfassung',
  sbTerminal:     'SB-Terminal & Abholmonitor',
  gaenge:         'Gänge-Steuerung',
  tickets:        'Ticketing & Einlass',
  sprache:        'Sprachbestellung (Headset)',
}

export const MANDANT_MODUL_BESCHREIBUNGEN: Record<MandantModul, string> = {
  gastro:
    'Tische, Tisch-Tabs, grafischer Tischplan und Bonierdrucker. ' +
    'Kernmodul für Restaurantbetrieb.',
  angebote:
    'Angebote erstellen, Lieferscheine drucken und Zielrechnungen / ' +
    'Sammelrechnungen stellen.',
  mergeport:
    'Eingehende Bestellungen von Lieferando, Mergeport und eigenen Quellen ' +
    'über Webhooks empfangen und verwalten.',
  reservierungen:
    'Tischreservierungen verwalten — intern anlegen und optional einen ' +
    'öffentlichen Online-Buchungslink für Gäste aktivieren.',
  zeiterfassung:
    'Mitarbeiter stempeln per PIN ein und aus. Schichtübersicht, ' +
    'Stundenauswertung und Monatsexport für die Lohnverrechnung.',
  sbTerminal:
    'Gäste bestellen selbst am Touch-Terminal und zahlen mit Karte. ' +
    'Bestellnummern laufen am KDS auf und erscheinen am Abholmonitor.',
  gaenge:
    'Gänge am Tisch steuern: Positionen einem Gang zuordnen und die Küche ' +
    'Gang für Gang per Tastendruck abrufen. Ohne Modul wird alles sofort boniert.',
  tickets:
    'Events anlegen, Tickets online verkaufen und per E-Mail verschicken, ' +
    'Einlass per QR-Scan mit Altersband (Jugendschutz) und Mehrfachtickets für die Crew.',
  sprache:
    'Kellner bestellen per Sprache über ein Headset: Push-to-talk, erkannte Artikel werden ' +
    'vor dem Senden vorgelesen und bestätigt. Ohne Modul wird nichts geladen.',
}

export const MandantModuleSchema = z.object({
  modulGastroAktiv:          z.boolean(),
  modulAngeboteAktiv:        z.boolean(),
  modulMergeportAktiv:       z.boolean(),
  modulReservierungenAktiv:  z.boolean(),
  modulZeiterfassungAktiv:   z.boolean(),
  modulSbTerminalAktiv:      z.boolean(),
  modulGaengeAktiv:          z.boolean(),
  modulTicketsAktiv:         z.boolean(),
  modulSpracheAktiv:         z.boolean(),
  /** Anzahl wählbarer Gänge (1..9), nur relevant bei modulGaengeAktiv */
  gaengeAnzahl:              z.number().int().min(1).max(9),
  /**
   * Umrüstzeit in Minuten fürs Neueindecken: blockiert den Tisch nach dem Ende
   * einer Reservierung zusätzlich. 0 = aus. In 10er-Schritten wählbar.
   */
  umruestMinuten:            z.number().int().min(0).max(120).multipleOf(10),
})
export type MandantModule = z.infer<typeof MandantModuleSchema>

export const MandantModuleUpdateSchema = MandantModuleSchema.partial()
export type MandantModuleUpdate = z.infer<typeof MandantModuleUpdateSchema>

// ---------------------------------------------------------------------------
// Freigaben — Vier-Augen-Prinzip für heikle Vorgänge
// ---------------------------------------------------------------------------

export const MandantFreigabenSchema = z.object({
  /**
   * Ab diesem Belegbetrag (brutto, in Cent) muss ein Storno freigegeben werden.
   * 0 = aus: jeder mit Storno-Recht darf jeden Beleg stornieren.
   *
   * Der Storno bleibt eine Kellner-Funktion — die Freigabe verlangt nur, dass
   * jemand mit der Berechtigung „freigabe" (oder ein Admin) seinen PIN eingibt.
   */
  stornoFreigabeAbCent: z.number().int().min(0).max(10_000_00),
  /**
   * Ab diesem Nachlass muss ein Rabatt freigegeben werden — prozentual (bezogen
   * auf die Belegsumme vor Nachlass) ODER absolut in Cent; es greift, was zuerst
   * erreicht ist. 0 = jeweils aus. Ohne diese Schwelle wäre die Storno-Freigabe
   * per 100-%-Rabatt umgehbar.
   */
  rabattFreigabeAbProzent: z.number().int().min(0).max(100),
  rabattFreigabeAbCent:    z.number().int().min(0).max(10_000_00),
})
export type MandantFreigaben = z.infer<typeof MandantFreigabenSchema>

export const MandantFreigabenUpdateSchema = MandantFreigabenSchema.partial()
export type MandantFreigabenUpdate = z.infer<typeof MandantFreigabenUpdateSchema>

// ---------------------------------------------------------------------------
// PIN-Länge — 4 oder 6 Ziffern für alle Benutzer des Betriebs
// ---------------------------------------------------------------------------

export const MandantPinLaengeSchema = z.object({
  pinLaenge: PinLaengeSchema,
  /**
   * Aktive Benutzer mit PIN je Länge. Nach einem Wechsel gelten die PINs der
   * anderen Länge nicht mehr — die Oberfläche nennt vorher, wie viele das trifft.
   */
  pinsMit4: z.number().int().min(0),
  pinsMit6: z.number().int().min(0),
})
export type MandantPinLaenge = z.infer<typeof MandantPinLaengeSchema>

export const MandantPinLaengeUpdateSchema = z.object({ pinLaenge: PinLaengeSchema })
export type MandantPinLaengeUpdate = z.infer<typeof MandantPinLaengeUpdateSchema>

// ---------------------------------------------------------------------------
// Mandant-Stammdaten (Firmeninfo + Belegtext)
// ---------------------------------------------------------------------------

/** IBAN ohne Leerzeichen, Großbuchstaben */
export function normalisiereIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase()
}

/** Formatprüfung + Prüfziffer (Modulo 97) */
export function istGueltigeIban(iban: string): boolean {
  const i = normalisiereIban(iban)
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(i)) return false
  const umgestellt = i.slice(4) + i.slice(0, 4)
  let rest = 0
  for (const ch of umgestellt) {
    const wert = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const ziffer of wert) rest = (rest * 10 + Number(ziffer)) % 97
  }
  return rest === 1
}

/** IBAN in Vierergruppen für die Anzeige */
export function formatiereIban(iban: string): string {
  return normalisiereIban(iban).replace(/(.{4})/g, '$1 ').trim()
}

export const MandantStammdatenSchema = z.object({
  firmenname:               z.string(),
  uid:                      z.string(),
  belegFusstext:            z.string().nullable(),
  belegKopftext:            z.string().nullable(),
  belegZeigeSteuertabelle:  z.boolean(),
  belegZeigeQr:             z.boolean(),
  rechnungIban:             z.string().nullable(),
  rechnungBic:              z.string().nullable(),
  rechnungZahlungszielTage: z.number().int(),
})
export type MandantStammdaten = z.infer<typeof MandantStammdatenSchema>

/** Nur Layout-Felder editierbar; firmenname/uid bleiben RKSV-seitig fixiert */
export const MandantStammdatenUpdateSchema = z.object({
  belegFusstext:           z.string().trim().max(500).nullable().optional(),
  belegKopftext:           z.string().trim().max(300).nullable().optional(),
  belegZeigeSteuertabelle: z.boolean().optional(),
  belegZeigeQr:            z.boolean().optional(),
  rechnungIban:            z.string().trim().max(50).nullable().optional()
    .refine(v => !v || istGueltigeIban(v), { message: 'Ungültige IBAN' }),
  rechnungBic:             z.string().trim().toUpperCase().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'Ungültiger BIC')
    .nullable().optional(),
  rechnungZahlungszielTage: z.number().int().min(0).max(365).optional(),
})
export type MandantStammdatenUpdate = z.infer<typeof MandantStammdatenUpdateSchema>

// ---------------------------------------------------------------------------
// Kassenbezeichnung
// ---------------------------------------------------------------------------

export const KasseBezeichnungUpdateSchema = z.object({
  bezeichnung: z.string().trim().min(1, 'Bezeichnung erforderlich').max(100),
})
export type KasseBezeichnungUpdate = z.infer<typeof KasseBezeichnungUpdateSchema>
