import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { and, eq, isNotNull, ne } from 'drizzle-orm'
import type { Berechtigung, User as PublicUser, UserCreateInput, UserUpdateInput } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { mandanten, userKassen, users } from '../db/schema.js'
import { hashPassword, userZuDto } from './auth.service.js'
import { alsPinLaenge } from './pin-laenge.js'

const BCRYPT_COST = 10

export class UserError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message)
  }
}

export interface UserServiceDeps { db: Db }

async function setzeKassenZuordnung(db: Db, userId: string, kassenIds: string[]): Promise<void> {
  await db.delete(userKassen).where(eq(userKassen.userId, userId))
  if (kassenIds.length > 0) {
    await db.insert(userKassen).values(kassenIds.map(kasseId => ({ userId, kasseId })))
  }
}

/**
 * Neue PINs müssen die Länge des Betriebs haben (4 oder 6 Ziffern) — eine PIN
 * in der anderen Länge wäre sofort ungültig, weil die Prüfungen sie ignorieren.
 */
async function pruefePinLaengeDesBetriebs(db: Db, pin: string, mandantId: string): Promise<void> {
  const [m] = await db
    .select({ pinLaenge: mandanten.pinLaenge })
    .from(mandanten)
    .where(eq(mandanten.id, mandantId))
    .limit(1)
  const laenge = alsPinLaenge(m?.pinLaenge)
  if (pin.length !== laenge) {
    throw new UserError(400, `PIN muss ${laenge} Ziffern haben (Einstellung des Betriebs)`)
  }
}

/**
 * PIN ist pro Mandant eindeutig — bei der PIN-Eingabe muss eindeutig ein User
 * identifizierbar sein. Wird bcrypt-verglichen, da Hashes nicht direkt vergleichbar.
 * Nur PINs derselben Länge können gleich sein.
 */
async function pruefePinEindeutig(
  db: Db,
  pin: string,
  mandantId: string,
  ausnehmenUserId?: string,
): Promise<void> {
  const basis = and(
    eq(users.mandantId, mandantId), eq(users.aktiv, true), isNotNull(users.pinHash),
    eq(users.pinLaenge, pin.length),
  )
  const where = ausnehmenUserId ? and(basis, ne(users.id, ausnehmenUserId)) : basis

  const kandidaten = await db.select({ id: users.id, pinHash: users.pinHash }).from(users).where(where)

  for (const u of kandidaten) {
    if (u.pinHash && await bcrypt.compare(pin, u.pinHash)) {
      throw new UserError(409, 'Dieser PIN ist bereits vergeben — PINs müssen eindeutig sein')
    }
  }
}

export async function listUsers(mandantId: string, deps: UserServiceDeps): Promise<PublicUser[]> {
  const rows = await deps.db
    .select()
    .from(users)
    .where(eq(users.mandantId, mandantId))
    .orderBy(users.createdAt)
  return Promise.all(rows.map(r => userZuDto(r, deps.db)))
}

export async function createUser(
  input: UserCreateInput,
  mandantId: string,
  deps: UserServiceDeps,
): Promise<PublicUser> {
  // PIN-only-Kellner (Eventpersonal): ohne E-Mail/Passwort bekommt das Konto
  // eine nicht erratbare interne Platzhalter-Adresse und ein Zufallspasswort —
  // der E-Mail-Login ist damit faktisch unmöglich, der Zugang läuft NUR über
  // den PIN am Handy. Platzhalter statt nullable-Spalte: die E-Mail ist überall
  // NOT NULL + eindeutig verdrahtet, und ihr Wert ist für den Betrieb unsichtbar.
  const email = (input.email ?? `${randomBytes(9).toString('hex')}@pin.kellner.lokal`).toLowerCase()
  const passwort = input.passwort ?? randomBytes(24).toString('hex')

  const existing = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  if (existing[0]) throw new UserError(409, 'E-Mail bereits vergeben')

  if (input.pin) {
    await pruefePinLaengeDesBetriebs(deps.db, input.pin, mandantId)
    await pruefePinEindeutig(deps.db, input.pin, mandantId)
  }

  const passwordHash = await hashPassword(passwort)
  const pinHash      = input.pin ? await bcrypt.hash(input.pin, BCRYPT_COST) : null

  const berechtigungen: Berechtigung[] = input.rolle === 'admin' ? [] : input.berechtigungen

  const [row] = await deps.db
    .insert(users)
    .values({
      mandantId,
      email,
      passwordHash,
      pinHash,
      ...(input.pin ? { pinLaenge: input.pin.length } : {}),
      name:           input.name,
      rolle:          input.rolle,
      berechtigungen,
      aktiv:          true,
    })
    .returning()
  if (!row) throw new UserError(500, 'User konnte nicht angelegt werden')

  await setzeKassenZuordnung(deps.db, row.id, input.kassenIds)

  return userZuDto(row, deps.db)
}

export async function updateUser(
  id: string,
  input: UserUpdateInput,
  mandantId: string,
  deps: UserServiceDeps,
): Promise<PublicUser> {
  const [existing] = await deps.db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new UserError(404, 'Benutzer nicht gefunden')

  const updates: Partial<typeof users.$inferInsert> = { updatedAt: new Date() }

  if (input.name      !== undefined) updates.name           = input.name
  if (input.email     !== undefined) updates.email          = input.email.toLowerCase()
  if (input.passwort  !== undefined) updates.passwordHash   = await hashPassword(input.passwort)
  if (input.aktiv     !== undefined) updates.aktiv          = input.aktiv
  if (input.berechtigungen !== undefined) {
    updates.berechtigungen = existing.rolle === 'admin' ? [] : input.berechtigungen
  }

  // PIN: null = PIN entfernen, string = neuen PIN setzen
  if (input.pin !== undefined) {
    if (input.pin !== null) {
      await pruefePinLaengeDesBetriebs(deps.db, input.pin, mandantId)
      await pruefePinEindeutig(deps.db, input.pin, mandantId, id)
      updates.pinLaenge = input.pin.length
    }
    updates.pinHash = input.pin === null ? null : await bcrypt.hash(input.pin, BCRYPT_COST)
  }

  const [row] = await deps.db
    .update(users)
    .set(updates)
    .where(eq(users.id, id))
    .returning()
  if (!row) throw new UserError(500, 'Update fehlgeschlagen')

  if (input.kassenIds !== undefined) {
    await setzeKassenZuordnung(deps.db, id, input.kassenIds)
  }

  return userZuDto(row, deps.db)
}

export async function deactivateUser(
  id: string,
  mandantId: string,
  requestingUserId: string,
  deps: UserServiceDeps,
): Promise<PublicUser> {
  if (id === requestingUserId) throw new UserError(400, 'Eigenes Konto kann nicht deaktiviert werden')

  const [existing] = await deps.db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.mandantId, mandantId)))
    .limit(1)
  if (!existing) throw new UserError(404, 'Benutzer nicht gefunden')

  const [row] = await deps.db
    .update(users)
    .set({ aktiv: false, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning()
  if (!row) throw new UserError(500, 'Deaktivierung fehlgeschlagen')

  return userZuDto(row, deps.db)
}
