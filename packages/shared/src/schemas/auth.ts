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
}

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
})
export type LoginInput = z.infer<typeof LoginInputSchema>

export const PinLoginInputSchema = z.object({
  kasseId: z.string().uuid(),
  pin:     z.string().length(4).regex(/^\d{4}$/, 'PIN muss genau 4 Ziffern sein'),
})
export type PinLoginInput = z.infer<typeof PinLoginInputSchema>

export const LoginResponseSchema = z.object({
  token:   z.string(),
  user:    UserSchema,
  mandant: z.object({
    id:         z.string().uuid(),
    firmenname: z.string(),
    uid:        z.string(),
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
  email:          z.string().email('Ungültige E-Mail-Adresse'),
  passwort:       z.string().min(8, 'Passwort muss mindestens 8 Zeichen lang sein'),
  rolle:          RolleSchema,
  berechtigungen: z.array(BerechtigungSchema),
  kassenIds:      z.array(z.string().uuid()),
  pin:            z.string().length(4).regex(/^\d{4}$/).optional(),
})
export type UserCreateInput = z.infer<typeof UserCreateInputSchema>

export const UserUpdateInputSchema = z.object({
  name:           z.string().trim().min(1).max(100).optional(),
  email:          z.string().email().optional(),
  passwort:       z.string().min(8).optional(),
  berechtigungen: z.array(BerechtigungSchema).optional(),
  kassenIds:      z.array(z.string().uuid()).optional(),
  pin:            z.string().length(4).regex(/^\d{4}$/).nullable().optional(),
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
