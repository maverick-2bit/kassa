import { z } from 'zod'

// ---------------------------------------------------------------------------
// User-Rollen
// ---------------------------------------------------------------------------

export const RolleSchema = z.enum(['admin', 'kellner'])
export type Rolle = z.infer<typeof RolleSchema>

export const ROLLE_LABELS: Record<Rolle, string> = {
  admin:   'Administrator',
  kellner: 'Kellner',
}

// ---------------------------------------------------------------------------
// Berechtigungen (fein-granular, pro User konfigurierbar)
// ---------------------------------------------------------------------------

export const BerechtigungSchema = z.enum([
  'tische',              // Tisch-Management bedienen
  'kasse',               // Schnellkasse bedienen
  'belege.lesen',        // Beleg-Verlauf einsehen
  'belege.stornieren',   // Belege stornieren
  'artikel.verwalten',   // Artikel anlegen/bearbeiten/deaktivieren
  'einstellungen',       // Drucker- und KDS-Konfiguration ändern
  'user.verwalten',      // Benutzer anlegen/bearbeiten (Admin)
  'kunden.verwalten',    // Kundenstamm (CRM) einsehen und bearbeiten
  'kasse.kredit',        // Kreditverkauf (Auf Kredit buchen) verwenden
  'freigabe',            // Storno über der Freigabeschwelle per PIN freigeben
  'tickets',             // Ticketing: Events, Tickets ausstellen/stornieren
])
export type Berechtigung = z.infer<typeof BerechtigungSchema>

export const ALLE_BERECHTIGUNGEN: Berechtigung[] = BerechtigungSchema.options

export const BERECHTIGUNG_LABELS: Record<Berechtigung, string> = {
  'tische':            'Tische',
  'kasse':             'Schnellkasse',
  'belege.lesen':      'Belege einsehen',
  'belege.stornieren': 'Belege stornieren',
  'artikel.verwalten': 'Artikel verwalten',
  'einstellungen':     'Einstellungen',
  'user.verwalten':    'Benutzer verwalten',
  'kunden.verwalten':  'Kunden (CRM)',
  'kasse.kredit':      'Kreditverkauf (Auf Kredit buchen)',
  'freigabe':          'Storno freigeben (Chef-PIN)',
  'tickets':           'Tickets & Events verwalten',
}

// ---------------------------------------------------------------------------
// PIN
// ---------------------------------------------------------------------------

/**
 * Erlaubte PIN-Längen — eine Einstellung je Mandant, gilt für alle Benutzer.
 * Nach einem Wechsel zählen PINs der anderen Länge nicht mehr.
 */
export const PinLaengeSchema = z.union([z.literal(4), z.literal(6)])
export type PinLaenge = z.infer<typeof PinLaengeSchema>

/** PIN mit 4 oder 6 Ziffern — welche Länge gilt, prüft das Backend gegen den Mandanten. */
export const PinSchema = z.string().regex(/^(\d{4}|\d{6})$/, 'PIN muss 4 oder 6 Ziffern haben')

/**
 * Fehlercode der PIN-Bremse (HTTP 429): zu viele falsche PIN-Eingaben, bis zum
 * Ablauf der Sperre wird gar keine PIN geprüft. Der Body nennt `wartenSekunden`.
 */
export const PIN_GESPERRT_CODE = 'pin_gesperrt'

/** Fehlercode (HTTP 400): PIN hat nicht die Länge des Betriebs; der Body nennt `pinLaenge`. */
export const PIN_LAENGE_CODE = 'pin_laenge'

/**
 * Geräte-Vertrauen: signiertes Merkmal, das ein Gerät nach einer erfolgreichen
 * Anmeldung bekommt (`geraetToken` in der Login-Antwort) und bei PIN-Eingaben
 * mitschickt. Solche Geräte zählen Fehlversuche in einem eigenen Topf — ein
 * Fremder ohne Merkmal kann sie nicht aussperren. KEIN Anmelde-Token.
 */
export const GeraetTokenSchema = z.string().max(512)

/** Öffentlich (vor dem Login): wie viele Ziffern das PIN-Feld braucht. */
export const PinInfoSchema = z.object({ pinLaenge: PinLaengeSchema })
export type PinInfo = z.infer<typeof PinInfoSchema>

// ---------------------------------------------------------------------------
// User (Public-DTO — kein passwordHash, kein pinHash!)
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id:             z.string().uuid(),
  mandantId:      z.string().uuid(),
  email:          z.string().email(),
  name:           z.string(),
  rolle:          RolleSchema,
  berechtigungen: z.array(BerechtigungSchema),
  kassenIds:      z.array(z.string().uuid()),
  hatPin:         z.boolean(),
  /** Ziffernzahl des gesetzten PINs — weicht sie vom Betrieb ab, gilt der PIN nicht mehr. */
  pinLaenge:      PinLaengeSchema,
  aktiv:          z.boolean(),
  createdAt:      z.string(),
})
export type User = z.infer<typeof UserSchema>

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export const LoginInputSchema = z.object({
  email:    z.string().email('Ungültige E-Mail-Adresse'),
  passwort: z.string().min(1, 'Passwort erforderlich'),
  /** Bisheriges Geräte-Merkmal — dann bleibt das Gerät dasselbe (derselbe Fehlversuchs-Topf). */
  geraetToken: GeraetTokenSchema.optional(),
})
export type LoginInput = z.infer<typeof LoginInputSchema>

export const PinLoginInputSchema = z.object({
  kasseId: z.string().uuid(),
  pin:     PinSchema,
  geraetToken: GeraetTokenSchema.optional(),
})
export type PinLoginInput = z.infer<typeof PinLoginInputSchema>

export const LoginResponseSchema = z.object({
  token:   z.string(),
  /** Geräte-Merkmal fürs nächste Mal (im Gerät speichern, beim Abmelden NICHT löschen). */
  geraetToken: z.string().optional(),
  user:    UserSchema,
  mandant: z.object({
    id:                  z.string().uuid(),
    firmenname:          z.string(),
    uid:                 z.string(),
    modulGastroAktiv:         z.boolean(),
    modulAngeboteAktiv:       z.boolean(),
    modulMergeportAktiv:      z.boolean(),
    modulReservierungenAktiv: z.boolean(),
    modulZeiterfassungAktiv:  z.boolean(),
    modulSbTerminalAktiv:     z.boolean(),
    modulGaengeAktiv:         z.boolean(),
    modulTicketsAktiv:        z.boolean(),
    /** Anzahl wählbarer Gänge (1..9) für den Gang-Wähler */
    gaengeAnzahl:             z.number().int(),
    /** Ziffernzahl der PINs dieses Betriebs */
    pinLaenge:                PinLaengeSchema,
  }),
  kassen: z.array(z.object({
    id:          z.string().uuid(),
    kassenId:    z.string(),
    bezeichnung: z.string().nullable(),
    umgebung:    z.string(),
  })),
})
export type LoginResponse = z.infer<typeof LoginResponseSchema>

// ---------------------------------------------------------------------------
// User-Verwaltung (CRUD)
// ---------------------------------------------------------------------------

export const UserCreateInputSchema = z.object({
  name:           z.string().trim().min(1).max(100),
  /**
   * E-Mail + Passwort sind für Kellner OPTIONAL: Eventpersonal loggt sich nur
   * per PIN am Handy ein — ein E-Mail-Konto je Aushilfe wäre praxisfremd.
   * Ohne E-Mail/Passwort ist ein PIN Pflicht (sonst wäre das Konto unbenutzbar)
   * und die Rolle muss kellner sein (Admins brauchen den vollen Zugang).
   */
  email:          z.string().email('Ungültige E-Mail-Adresse').optional(),
  passwort:       z.string().min(8, 'Passwort muss mindestens 8 Zeichen lang sein').optional(),
  rolle:          RolleSchema,
  berechtigungen: z.array(BerechtigungSchema),
  kassenIds:      z.array(z.string().uuid()),
  pin:            PinSchema.optional(),
}).superRefine((u, ctx) => {
  const hatZugang = !!u.email && !!u.passwort
  if (!hatZugang && (u.email || u.passwort)) {
    ctx.addIssue({ code: 'custom', path: ['email'], message: 'E-Mail und Passwort nur gemeinsam angeben' })
  }
  if (!hatZugang && !u.pin) {
    ctx.addIssue({ code: 'custom', path: ['pin'], message: 'Ohne E-Mail/Passwort ist ein PIN erforderlich' })
  }
  if (!hatZugang && u.rolle !== 'kellner') {
    ctx.addIssue({ code: 'custom', path: ['rolle'], message: 'Administratoren brauchen E-Mail und Passwort' })
  }
})
export type UserCreateInput = z.infer<typeof UserCreateInputSchema>

export const UserUpdateInputSchema = z.object({
  name:           z.string().trim().min(1).max(100).optional(),
  email:          z.string().email().optional(),
  passwort:       z.string().min(8).optional(),
  berechtigungen: z.array(BerechtigungSchema).optional(),
  kassenIds:      z.array(z.string().uuid()).optional(),
  pin:            PinSchema.nullable().optional(),
  aktiv:          z.boolean().optional(),
})
export type UserUpdateInput = z.infer<typeof UserUpdateInputSchema>

// ---------------------------------------------------------------------------
// Admin-User-Eingabe (im Setup — unverändert)
// ---------------------------------------------------------------------------

export const AdminUserInputSchema = z.object({
  name:     z.string().trim().min(1, 'Name erforderlich').max(100),
  email:    z.string().email('Ungültige E-Mail-Adresse'),
  passwort: z.string().min(8, 'Passwort muss mindestens 8 Zeichen lang sein'),
})
export type AdminUserInput = z.infer<typeof AdminUserInputSchema>
