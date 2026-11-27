/**
 * Benutzer des Portals: anlegen, anmelden (Passwort + Authenticator-App), TOTP einrichten.
 *
 * Schutz gegen Raten: nach MAX_FEHLVERSUCHE falschen Passwörtern oder Codes ist das Konto SPERRZEIT_MINUTEN gesperrt.
 * Die Antwort ist dabei immer dieselbe allgemeine Meldung — ob es die E-Mail gibt, ob das Konto gesperrt ist oder ob
 * Passwort oder Code falsch war, erfährt ein Angreifer nicht. Wer das Passwort KENNT, erfährt nur, dass noch ein
 * Code fehlt ('code_erforderlich') bzw. die Einrichtung ansteht.
 */

import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { portalBenutzer } from '../db/schema.js'
import { PortalFehler } from '../fehler.js'
import { hashPasswort, pruefePasswort, pruefePasswortRegel, scheinPruefung } from '../auth/passwort.js'
import { entschluessele, verschluessele } from '../auth/verschluesselung.js'
import { erzeugeTotpGeheimnis, otpauthUrl, pruefeTotp } from '../auth/totp.js'

export const MAX_FEHLVERSUCHE = 5
export const SPERRZEIT_MINUTEN = 15

const ALLGEMEIN = 'Anmeldung nicht möglich. Bitte Eingaben prüfen und später erneut versuchen.'

export interface BenutzerKurz {
  id:    string
  email: string
}

export type AnmeldeErgebnis =
  | { art: 'angemeldet';      benutzer: BenutzerKurz }
  | { art: 'totp_einrichten'; benutzer: BenutzerKurz }

const normalisiere = (email: string) => email.trim().toLowerCase()

export async function legeBenutzerAn(db: Db, emailRoh: string, passwort: string): Promise<BenutzerKurz> {
  const email = normalisiere(emailRoh)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw new PortalFehler(400, 'Ungültige E-Mail-Adresse.')
  const regel = pruefePasswortRegel(passwort, email)
  if (regel) throw new PortalFehler(400, regel)

  const [vorhanden] = await db.select({ id: portalBenutzer.id }).from(portalBenutzer).where(eq(portalBenutzer.email, email)).limit(1)
  if (vorhanden) throw new PortalFehler(409, 'Es gibt schon einen Benutzer mit dieser E-Mail-Adresse.')

  const [neu] = await db.insert(portalBenutzer)
    .values({ email, passwortHash: await hashPasswort(passwort) })
    .returning({ id: portalBenutzer.id, email: portalBenutzer.email })
  return neu!
}

/** Zählt einen Fehlversuch und sperrt das Konto beim Erreichen der Grenze. */
async function zaehleFehlversuch(db: Db, id: string, aktuell: number, jetzt: Date): Promise<void> {
  const neu = aktuell + 1
  const sperren = neu >= MAX_FEHLVERSUCHE
  await db.update(portalBenutzer).set({
    fehlversuche: sperren ? 0 : neu,
    ...(sperren ? { gesperrtBis: new Date(jetzt.getTime() + SPERRZEIT_MINUTEN * 60_000) } : {}),
  }).where(eq(portalBenutzer.id, id))
}

export async function anmelden(
  db: Db,
  totpSchluessel: Buffer,
  eingabe: { email: string; passwort: string; code?: string | undefined },
  jetzt: Date = new Date(),
): Promise<AnmeldeErgebnis> {
  const email = normalisiere(eingabe.email)
  const [benutzer] = await db.select().from(portalBenutzer).where(eq(portalBenutzer.email, email)).limit(1)

  // Unbekannt, deaktiviert oder gesperrt: genauso lange rechnen wie bei einer echten Prüfung, dieselbe Antwort
  const gesperrt = benutzer?.gesperrtBis != null && benutzer.gesperrtBis > jetzt
  if (!benutzer || !benutzer.aktiv || gesperrt) {
    await scheinPruefung(eingabe.passwort)
    throw new PortalFehler(401, ALLGEMEIN)
  }

  if (!(await pruefePasswort(eingabe.passwort, benutzer.passwortHash))) {
    await zaehleFehlversuch(db, benutzer.id, benutzer.fehlversuche, jetzt)
    throw new PortalFehler(401, ALLGEMEIN)
  }

  const kurz = { id: benutzer.id, email: benutzer.email }
  if (!benutzer.totpAktiv || !benutzer.totpGeheimnis) return { art: 'totp_einrichten', benutzer: kurz }

  if (!eingabe.code) throw new PortalFehler(401, 'Bitte den Code aus der Authenticator-App eingeben.', 'code_erforderlich')

  const pruefung = pruefeTotp(entschluessele(benutzer.totpGeheimnis, totpSchluessel), eingabe.code, {
    jetztMs: jetzt.getTime(), letzterSchritt: benutzer.totpLetzterSchritt,
  })
  if (!pruefung.gueltig) {
    await zaehleFehlversuch(db, benutzer.id, benutzer.fehlversuche, jetzt)
    throw new PortalFehler(401, ALLGEMEIN)
  }

  // Bedingtes Update: derselbe Schritt kann bei zwei gleichzeitigen Anmeldungen nur einmal durchgehen
  const aktualisiert = await db.update(portalBenutzer)
    .set({ totpLetzterSchritt: pruefung.schritt, fehlversuche: 0, gesperrtBis: null, letzterLogin: jetzt })
    .where(sql`${portalBenutzer.id} = ${benutzer.id} AND (${portalBenutzer.totpLetzterSchritt} IS NULL OR ${portalBenutzer.totpLetzterSchritt} < ${pruefung.schritt})`)
    .returning({ id: portalBenutzer.id })
  if (aktualisiert.length === 0) throw new PortalFehler(401, ALLGEMEIN)

  return { art: 'angemeldet', benutzer: kurz }
}

/** Erzeugt ein neues TOTP-Geheimnis (noch nicht aktiv) und gibt es einmalig zur Einrichtung zurück. */
export async function starteTotpEinrichtung(db: Db, totpSchluessel: Buffer, benutzerId: string): Promise<{ secret: string; otpauthUrl: string }> {
  const [benutzer] = await db.select().from(portalBenutzer).where(eq(portalBenutzer.id, benutzerId)).limit(1)
  if (!benutzer || !benutzer.aktiv) throw new PortalFehler(401, ALLGEMEIN)
  if (benutzer.totpAktiv) throw new PortalFehler(409, 'Die Authenticator-App ist schon eingerichtet.')

  const secret = erzeugeTotpGeheimnis()
  await db.update(portalBenutzer).set({ totpGeheimnis: verschluessele(secret, totpSchluessel) }).where(eq(portalBenutzer.id, benutzerId))
  return { secret, otpauthUrl: otpauthUrl(secret, benutzer.email) }
}

/** Schließt die Einrichtung mit einem Code aus der App ab; erst dann ist TOTP aktiv. */
export async function bestaetigeTotp(db: Db, totpSchluessel: Buffer, benutzerId: string, code: string, jetzt: Date = new Date()): Promise<BenutzerKurz> {
  const [benutzer] = await db.select().from(portalBenutzer).where(eq(portalBenutzer.id, benutzerId)).limit(1)
  if (!benutzer || !benutzer.aktiv) throw new PortalFehler(401, ALLGEMEIN)
  if (benutzer.gesperrtBis != null && benutzer.gesperrtBis > jetzt) throw new PortalFehler(401, ALLGEMEIN)
  if (benutzer.totpAktiv) throw new PortalFehler(409, 'Die Authenticator-App ist schon eingerichtet.')
  if (!benutzer.totpGeheimnis) throw new PortalFehler(400, 'Die Einrichtung wurde noch nicht gestartet.')

  const pruefung = pruefeTotp(entschluessele(benutzer.totpGeheimnis, totpSchluessel), code, { jetztMs: jetzt.getTime() })
  if (!pruefung.gueltig) {
    await zaehleFehlversuch(db, benutzer.id, benutzer.fehlversuche, jetzt)
    throw new PortalFehler(400, 'Der Code stimmt nicht. Bitte den aktuellen Code aus der App eingeben.')
  }

  await db.update(portalBenutzer)
    .set({ totpAktiv: true, totpLetzterSchritt: pruefung.schritt, fehlversuche: 0, gesperrtBis: null, letzterLogin: jetzt })
    .where(eq(portalBenutzer.id, benutzerId))
  return { id: benutzer.id, email: benutzer.email }
}

export async function holeBenutzer(db: Db, id: string): Promise<BenutzerKurz | null> {
  const [b] = await db.select({ id: portalBenutzer.id, email: portalBenutzer.email, aktiv: portalBenutzer.aktiv })
    .from(portalBenutzer).where(eq(portalBenutzer.id, id)).limit(1)
  return b && b.aktiv ? { id: b.id, email: b.email } : null
}

// ---- Für die Kommandozeile (Wiederherstellung) ----------------------------------------------

/** Neues Passwort setzen und das Konto entsperren. */
export async function setzePasswort(db: Db, emailRoh: string, passwort: string): Promise<void> {
  const email = normalisiere(emailRoh)
  const regel = pruefePasswortRegel(passwort, email)
  if (regel) throw new PortalFehler(400, regel)
  const geaendert = await db.update(portalBenutzer)
    .set({ passwortHash: await hashPasswort(passwort), fehlversuche: 0, gesperrtBis: null })
    .where(eq(portalBenutzer.email, email)).returning({ id: portalBenutzer.id })
  if (geaendert.length === 0) throw new PortalFehler(404, 'Benutzer nicht gefunden.')
}

/** Authenticator-App zurücksetzen (neues Handy): beim nächsten Anmelden wird sie neu eingerichtet. */
export async function setzeTotpZurueck(db: Db, emailRoh: string): Promise<void> {
  const email = normalisiere(emailRoh)
  const geaendert = await db.update(portalBenutzer)
    .set({ totpGeheimnis: null, totpAktiv: false, totpLetzterSchritt: null, fehlversuche: 0, gesperrtBis: null })
    .where(eq(portalBenutzer.email, email)).returning({ id: portalBenutzer.id })
  if (geaendert.length === 0) throw new PortalFehler(404, 'Benutzer nicht gefunden.')
}
