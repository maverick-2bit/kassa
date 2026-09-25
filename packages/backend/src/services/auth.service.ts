/**
 * Auth-Service: Passwort-Hashing und Login-Verifikation.
 *
 * - bcrypt mit Cost-Faktor 10 (~60ms pro Hash, gut gegen Brute-Force,
 *   schnell genug für realistische Login-Frequenzen)
 * - Login: User per E-Mail finden, Passwort gegen Hash prüfen
 */

import bcrypt from 'bcryptjs'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
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
import type { GeraetVertrauenSigner } from '../auth/geraet-vertrauen.js'
import { pruefeMitBremse, toepfeFuerGeraet } from './pin-bremse.js'
import { alsPinLaenge, pruefePinLaenge } from './pin-laenge.js'

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
    pinLaenge:      alsPinLaenge(row.pinLaenge),
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
  /** Geräte-Merkmal der PIN-Bremse (jede erfolgreiche Anmeldung stellt es aus/verlängert es) */
  geraetVertrauen: GeraetVertrauenSigner
}

/** Anfrage-Umfeld einer PIN-Anmeldung — fürs Audit der PIN-Bremse. */
export interface PinLoginKontext {
  ipAdresse: string | null
  userAgent: string | null
  log?:      FastifyBaseLogger
}

/**
 * @param geraetId Gerät aus dem vorgelegten Merkmal — bleibt beim Verlängern
 *                 erhalten (sonst gäbe jede Anmeldung einen frischen Topf)
 */
async function buildLoginResponse(
  user: typeof users.$inferSelect,
  deps: LoginDeps,
  geraetId?: string,
): Promise<LoginResponse> {
  const [mandant] = await deps.db
    .select({
      id:                  mandanten.id,
      firmenname:          mandanten.firmenname,
      uid:                 mandanten.uid,
      modulGastroAktiv:         mandanten.modulGastroAktiv,
      modulAngeboteAktiv:       mandanten.modulAngeboteAktiv,
      modulMergeportAktiv:      mandanten.modulMergeportAktiv,
      modulReservierungenAktiv: mandanten.modulReservierungenAktiv,
      modulZeiterfassungAktiv:  mandanten.modulZeiterfassungAktiv,
      modulSbTerminalAktiv:     mandanten.modulSbTerminalAktiv,
      modulGaengeAktiv:         mandanten.modulGaengeAktiv,
      modulTicketsAktiv:        mandanten.modulTicketsAktiv,
      gaengeAnzahl:             mandanten.gaengeAnzahl,
      pinLaenge:                mandanten.pinLaenge,
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
    geraetToken: deps.geraetVertrauen.ausstellen(user.mandantId, geraetId),
    user:    await userZuDto(user, deps.db),
    mandant: { ...mandant, pinLaenge: alsPinLaenge(mandant.pinLaenge) },
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

  const vertrauen = deps.geraetVertrauen.pruefen(input.geraetToken, user.mandantId)
  return buildLoginResponse(user, deps, vertrauen?.geraetId)
}

/**
 * Sucht den aktiven Benutzer zum PIN. Nur PINs in der Länge des Betriebs zählen
 * (nach einem Wechsel 4 → 6 sind die alten ungültig).
 *
 * Über alle Kandidaten hashen statt nachschlagen: bcrypt-Hashes sind nicht
 * rückwärts durchsuchbar.
 */
async function findeBenutzerZuPin(
  db:        Db,
  mandantId: string,
  pin:       string,
  pinLaenge: number,
): Promise<typeof users.$inferSelect | null> {
  const kandidaten = await db
    .select()
    .from(users)
    .where(and(
      eq(users.mandantId, mandantId),
      eq(users.aktiv, true),
      isNotNull(users.pinHash),
      eq(users.pinLaenge, pinLaenge),
    ))

  for (const u of kandidaten) {
    if (u.pinHash && await bcrypt.compare(pin, u.pinHash)) return u
  }
  await bcrypt.compare(pin, '$2a$10$invalidhashtopreventtimingleaks0000000000000000000000')
  return null
}

export async function loginWithPin(
  input:   PinLoginInput,
  deps:    LoginDeps,
  kontext: PinLoginKontext,
): Promise<LoginResponse> {
  // Mandant aus übergebener Kasse ableiten — PIN ist pro Mandant eindeutig,
  // unabhängig davon ob der User dieser Kasse zugeordnet ist (Kasse-Wechsel folgt nach Login).
  const [kasse] = await deps.db
    .select({ mandantId: kassen.mandantId, pinLaenge: mandanten.pinLaenge })
    .from(kassen)
    .innerJoin(mandanten, eq(kassen.mandantId, mandanten.id))
    .where(eq(kassen.id, input.kasseId))
    .limit(1)
  if (!kasse) throw new AuthError(401, 'PIN ungültig')

  // Falsche Länge kann keinen PIN treffen → ohne Prüfung und ohne Fehlversuch ablehnen
  pruefePinLaenge(input.pin, kasse.pinLaenge)

  // Gerät mit gültigem Merkmal zählt im eigenen Topf — fremde Geräte je Kasse
  const vertrauen = deps.geraetVertrauen.pruefen(input.geraetToken, kasse.mandantId)

  const gefunden = await pruefeMitBremse(deps.db, {
    quelle:        'pin_login',
    mandantId:     kasse.mandantId,
    toepfe:        toepfeFuerGeraet(kasse.mandantId, input.kasseId, vertrauen),
    meldungFalsch: 'PIN ungültig.',
    kasseId:       input.kasseId,
    ipAdresse:     kontext.ipAdresse,
    userAgent:     kontext.userAgent,
    ...(kontext.log ? { log: kontext.log } : {}),
  }, () => findeBenutzerZuPin(deps.db, kasse.mandantId, input.pin, kasse.pinLaenge))
  if (!gefunden) throw new AuthError(401, 'PIN ungültig')

  return buildLoginResponse(gefunden, deps, vertrauen?.geraetId)
}
