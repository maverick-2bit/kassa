/**
 * Auth-Service: Passwort-Hashing und Login-Verifikation.
 *
 * - bcrypt mit Cost-Faktor 10 (~60ms pro Hash, gut gegen Brute-Force,
 *   schnell genug für realistische Login-Frequenzen)
 * - Login: User per E-Mail finden, Passwort gegen Hash prüfen
 */

import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import type { LoginInput, LoginResponse, Rolle, User as PublicUser } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kassen, mandanten, users } from '../db/schema.js'

const BCRYPT_COST = 10

export class AuthError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export async function hashPassword(passwort: string): Promise<string> {
  return bcrypt.hash(passwort, BCRYPT_COST)
}

export async function verifyPassword(passwort: string, hash: string): Promise<boolean> {
  return bcrypt.compare(passwort, hash)
}

export function userZuDto(row: typeof users.$inferSelect): PublicUser {
  return {
    id:        row.id,
    mandantId: row.mandantId,
    email:     row.email,
    name:      row.name,
    rolle:     row.rolle as Rolle,
    aktiv:     row.aktiv,
    createdAt: row.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export interface LoginDeps {
  db:        Db
  signToken: (payload: { sub: string; mandantId: string; rolle: Rolle; name: string }) => string
}

export async function login(
  input: LoginInput,
  deps:  LoginDeps,
): Promise<LoginResponse> {
  // 1. User per E-Mail finden
  const [user] = await deps.db
    .select()
    .from(users)
    .where(eq(users.email, input.email.toLowerCase()))
    .limit(1)

  if (!user) {
    // Konstantes Timing: trotzdem ein bcrypt-Compare durchführen
    await bcrypt.compare(input.passwort, '$2a$10$invalidhashtopreventtimingleaks0000000000000000000000')
    throw new AuthError(401, 'E-Mail oder Passwort falsch')
  }
  if (!user.aktiv) {
    throw new AuthError(403, 'Benutzer ist deaktiviert')
  }

  // 2. Passwort prüfen
  const ok = await verifyPassword(input.passwort, user.passwordHash)
  if (!ok) {
    throw new AuthError(401, 'E-Mail oder Passwort falsch')
  }

  // 3. Mandant + Kassen laden
  const [mandant] = await deps.db
    .select({ id: mandanten.id, firmenname: mandanten.firmenname, uid: mandanten.uid })
    .from(mandanten)
    .where(eq(mandanten.id, user.mandantId))
    .limit(1)
  if (!mandant) throw new AuthError(500, 'Mandant nicht gefunden')

  const kassenListe = await deps.db
    .select({ id: kassen.id, kassenId: kassen.kassenId, umgebung: kassen.umgebung })
    .from(kassen)
    .where(eq(kassen.mandantId, user.mandantId))

  // 4. Token signieren
  const token = deps.signToken({
    sub:       user.id,
    mandantId: user.mandantId,
    rolle:     user.rolle as Rolle,
    name:      user.name,
  })

  return {
    token,
    user:    userZuDto(user),
    mandant,
    kassen:  kassenListe,
  }
}
