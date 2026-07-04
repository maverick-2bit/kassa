/**
 * Auth-Service: Passwort-Hashing und Login-Verifikation.
 *
 * - bcrypt mit Cost-Faktor 10 (~60ms pro Hash, gut gegen Brute-Force,
 *   schnell genug für realistische Login-Frequenzen)
 * - Login: User per E-Mail finden, Passwort gegen Hash prüfen
 */

import bcrypt from 'bcryptjs'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type {
  Berechtigung,
  LoginInput,
  LoginResponse,
  PinLoginInput,
  Rolle,
  User as PublicUser,
} from '@kassa/shared'
import { ALLE_BERECHTIGUNGEN } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { kassen, mandanten, userKassen, users } from '../db/schema.js'

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

async function ladeKassenFuerUser(
  db: Db,
  userId: string,
  rolle: string,
  mandantId: string,
): Promise<{ id: string; kassenId: string; bezeichnung: string | null; umgebung: string }[]> {
  // Nur aktive Kassen — außer Betrieb genommene erscheinen nicht im Umschalter
  // (sie bleiben in der Verwaltung via GET /kassen sichtbar).
  if (rolle === 'admin') {
    return db
      .select({ id: kassen.id, kassenId: kassen.kassenId, bezeichnung: kassen.bezeichnung, umgebung: kassen.umgebung })
      .from(kassen)
      .where(and(eq(kassen.mandantId, mandantId), eq(kassen.status, 'aktiv')))
  }
  const zuordnungen = await db
    .select({ kasseId: userKassen.kasseId })
    .from(userKassen)
    .where(eq(userKassen.userId, userId))
  if (zuordnungen.length === 0) return []
  return db
    .select({ id: kassen.id, kassenId: kassen.kassenId, bezeichnung: kassen.bezeichnung, umgebung: kassen.umgebung })
    .from(kassen)
    .where(and(inArray(kassen.id, zuordnungen.map(z => z.kasseId)), eq(kassen.status, 'aktiv')))
}

export async function userZuDto(
  row: typeof users.$inferSelect,
  db: Db,
): Promise<PublicUser> {
  const berechtigungen = row.rolle === 'admin'
    ? ALLE_BERECHTIGUNGEN
    : (row.berechtigungen as Berechtigung[]) ?? []

  const kassenZuordnungen = row.rolle === 'admin'
    ? [] // Admin-kassenIds wird leer gelassen, Frontend benutzt kassen aus Login-Response
    : (await db
        .select({ kasseId: userKassen.kasseId })
        .from(userKassen)
        .where(eq(userKassen.userId, row.id))
      ).map(z => z.kasseId)

  return {
    id:             row.id,
    mandantId:      row.mandantId,
    email:          row.email,
    name:           row.name,
    rolle:          row.rolle as Rolle,
    berechtigungen,
    kassenIds:      kassenZuordnungen,
    hatPin:         row.pinHash !== null,
    aktiv:          row.aktiv,
    createdAt:      row.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export interface LoginDeps {
  db:        Db
  signToken: (payload: { sub: string; mandantId: string; rolle: Rolle; name: string; berechtigungen: Berechtigung[] }) => string
}

async function buildLoginResponse(
  user: typeof users.$inferSelect,
  deps: LoginDeps,
): Promise<LoginResponse> {
  const [mandant] = await deps.db
    .select({
      id:                  mandanten.id,
      firmenname:          mandanten.firmenname,
      uid:                 mandanten.uid,
      modulGastroAktiv:    mandanten.modulGastroAktiv,
      modulAngeboteAktiv:  mandanten.modulAngeboteAktiv,
      modulMergeportAktiv: mandanten.modulMergeportAktiv,
    })
    .from(mandanten)
    .where(eq(mandanten.id, user.mandantId))
    .limit(1)
  if (!mandant) throw new AuthError(500, 'Mandant nicht gefunden')

  const kassenListe = await ladeKassenFuerUser(deps.db, user.id, user.rolle, user.mandantId)

  const berechtigungen: Berechtigung[] = user.rolle === 'admin'
    ? ALLE_BERECHTIGUNGEN
    : (user.berechtigungen as Berechtigung[]) ?? []

  const token = deps.signToken({
    sub:            user.id,
    mandantId:      user.mandantId,
    rolle:          user.rolle as Rolle,
    name:           user.name,
    berechtigungen,
  })

  return {
    token,
    user:    await userZuDto(user, deps.db),
    mandant,
    kassen:  kassenListe,
  }
}

export async function login(
  input: LoginInput,
  deps:  LoginDeps,
): Promise<LoginResponse> {
  const [user] = await deps.db
    .select()
    .from(users)
    .where(eq(users.email, input.email.toLowerCase()))
    .limit(1)

  if (!user) {
    await bcrypt.compare(input.passwort, '$2a$10$invalidhashtopreventtimingleaks0000000000000000000000')
    throw new AuthError(401, 'E-Mail oder Passwort falsch')
  }
  if (!user.aktiv) throw new AuthError(403, 'Benutzer ist deaktiviert')

  const ok = await verifyPassword(input.passwort, user.passwordHash)
  if (!ok) throw new AuthError(401, 'E-Mail oder Passwort falsch')

  return buildLoginResponse(user, deps)
}

export async function loginWithPin(
  input: PinLoginInput,
  deps:  LoginDeps,
): Promise<LoginResponse> {
  // Mandant aus übergebener Kasse ableiten — PIN ist pro Mandant eindeutig,
  // unabhängig davon ob der User dieser Kasse zugeordnet ist (Kasse-Wechsel folgt nach Login).
  const [kasse] = await deps.db
    .select({ mandantId: kassen.mandantId })
    .from(kassen)
    .where(eq(kassen.id, input.kasseId))
    .limit(1)
  if (!kasse) throw new AuthError(401, 'PIN ungültig')

  const kandidaten = await deps.db
    .select()
    .from(users)
    .where(and(
      eq(users.mandantId, kasse.mandantId),
      eq(users.aktiv, true),
      isNotNull(users.pinHash),
    ))

  // PIN gegen jeden Kandidaten prüfen
  let gefunden: typeof users.$inferSelect | null = null
  for (const u of kandidaten) {
    if (u.pinHash && await bcrypt.compare(input.pin, u.pinHash)) {
      gefunden = u
      break
    }
  }
  if (!gefunden) {
    await bcrypt.compare(input.pin, '$2a$10$invalidhashtopreventtimingleaks0000000000000000000000')
    throw new AuthError(401, 'PIN ungültig')
  }

  return buildLoginResponse(gefunden, deps)
}
