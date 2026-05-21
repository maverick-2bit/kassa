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
// User (Public-DTO — kein passwordHash!)
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id:        z.string().uuid(),
  mandantId: z.string().uuid(),
  email:     z.string().email(),
  name:      z.string(),
  rolle:     RolleSchema,
  aktiv:     z.boolean(),
  createdAt: z.string(),
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

export const LoginResponseSchema = z.object({
  token:   z.string(),
  user:    UserSchema,
  mandant: z.object({
    id:         z.string().uuid(),
    firmenname: z.string(),
    uid:        z.string(),
  }),
  /** Kassen, auf die dieser User Zugriff hat */
  kassen:  z.array(z.object({
    id:       z.string().uuid(),
    kassenId: z.string(),
    umgebung: z.string(),
  })),
})
export type LoginResponse = z.infer<typeof LoginResponseSchema>

// ---------------------------------------------------------------------------
// Admin-User-Eingabe (im Setup)
// ---------------------------------------------------------------------------

export const AdminUserInputSchema = z.object({
  name:     z.string().trim().min(1, 'Name erforderlich').max(100),
  email:    z.string().email('Ungültige E-Mail-Adresse'),
  passwort: z.string().min(8, 'Passwort muss mindestens 8 Zeichen lang sein'),
})
export type AdminUserInput = z.infer<typeof AdminUserInputSchema>
