import bcrypt from 'bcryptjs'
import { and, eq, isNotNull, ne } from 'drizzle-orm'
import type { Berechtigung, User as PublicUser, UserCreateInput, UserUpdateInput } from '@kassa/shared'
import type { Db } from '../db/client.js'
import { userKassen, users } from '../db/schema.js'
import { hashPassword, userZuDto } from './auth.service.js'

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
 * PIN ist pro Mandant eindeutig — bei der PIN-Eingabe muss eindeutig ein User
 * identifizierbar sein. Wird bcrypt-verglichen, da Hashes nicht direkt vergleichbar.
 */
async function pruefePinEindeutig(
  db: Db,
  pin: string,
  mandantId: string,
  ausnehmenUserId?: string,
): Promise<void> {
  const where = ausnehmenUserId
    ? and(eq(users.mandantId, mandantId), eq(users.aktiv, true), isNotNull(users.pinHash), ne(users.id, ausnehmenUserId))
    : and(eq(users.mandantId, mandantId), eq(users.aktiv, true), isNotNull(users.pinHash))

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
  const existing = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email.toLowerCase()))
    .limit(1)
  if (existing[0]) throw new UserError(409, 'E-Mail bereits vergeben')

  if (input.pin) await pruefePinEindeutig(deps.db, input.pin, mandantId)

  const passwordHash = await hashPassword(input.passwort)
  const pinHash      = input.pin ? await bcrypt.hash(input.pin, BCRYPT_COST) : null

  const berechtigungen: Berechtigung[] = input.rolle === 'admin' ? [] : input.berechtigungen

  const [row] = await deps.db
    .insert(users)
    .values({
      mandantId,
      email:          input.email.toLowerCase(),
      passwordHash,
      pinHash,
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
    if (input.pin !== null) await pruefePinEindeutig(deps.db, input.pin, mandantId, id)
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
