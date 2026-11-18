/**
 * Sperre der Signaturkarte nach einer abgelehnten PIN — je KARTE, nicht je Kasse.
 *
 * Mehrere Kassen dürfen dieselbe Karte nutzen. Lehnt die Karte eine PIN ab, darf keine dieser Kassen
 * sie von selbst wieder ansprechen: jeder weitere Versuch kostet einen der wenigen Fehlversuche, danach
 * ist die Karte für immer gesperrt. Drei Schichten:
 *
 *  1. Kartenbrücke: schickt eine einmal abgelehnte PIN-Prüfung nie wieder an die Karte (kartenbruecke.ps1)
 *  2. dieser Prozess: die Sperre gilt SOFORT, noch bevor die Transaktion des Belegs zurückgerollt ist —
 *     eine gleichzeitige Anfrage, die auf dieselbe Kasse wartet, sieht sie schon (kein Wettlauf)
 *  3. Datenbank (kassen.karte_pin_gesperrt): überdauert einen Neustart; gesetzt für ALLE Kassen mit
 *     diesem Kartenzertifikat
 *
 * Aufgehoben wird die Sperre nur, wenn ein Mensch in den Einstellungen eine PIN speichert — die Kassa
 * prüft sie dabei mit einer Probesignatur (ein bewusster Versuch).
 */

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { KartenError } from '@kassa/rksv'
import type { Db } from '../db/client.js'
import { kassen } from '../db/schema.js'

/** Kartenfehler, nach denen die Kassa die Karte nicht mehr von selbst anspricht */
export const PIN_ABLEHNUNGEN: ReadonlySet<string> = new Set(['pin_falsch', 'pin_gesperrt', 'pin_unklar', 'pin_bereits_abgelehnt'])

export function istPinAblehnung(err: unknown): err is KartenError {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'KartenError'
    && PIN_ABLEHNUNGEN.has((err as { art?: unknown }).art as string)
}

const gesperrteKarten = new Set<string>()

const schluessel = (zertifikatDerBase64: string): string => createHash('sha256').update(zertifikatDerBase64).digest('hex')

export function istKarteGesperrt(zertifikatDerBase64: string): boolean {
  return gesperrteKarten.has(schluessel(zertifikatDerBase64))
}

/** Sofort im Prozess sperren (synchron — vor dem Rollback der laufenden Transaktion aufrufen) */
export function sperreKarteSofort(zertifikatDerBase64: string): void {
  gesperrteKarten.add(schluessel(zertifikatDerBase64))
}

export function gibKarteFrei(zertifikatDerBase64: string): void {
  gesperrteKarten.delete(schluessel(zertifikatDerBase64))
}

/** Nur für Tests */
export function vergesseKartenSperren(): void {
  gesperrteKarten.clear()
}

/** Hinweistext für die Einstellungen aus der Ablehnung */
export function pinHinweis(err: KartenError): string {
  if (err.art === 'pin_gesperrt') return 'Karte gesperrt'
  if (err.art === 'pin_unklar') return 'unklare Antwort der Karte'
  if (err.art === 'pin_bereits_abgelehnt') return 'PIN schon einmal abgelehnt'
  if (err.restVersuche === undefined) return 'PIN abgelehnt'
  return `noch ${err.restVersuche} Versuch${err.restVersuche === 1 ? '' : 'e'}`
}

/**
 * Sperre in der Datenbank festschreiben — für ALLE Kassen mit diesem Kartenzertifikat. Mit Wiederholung:
 * Bis es gelingt, hält die Sperre im Prozess (sperreKarteSofort).
 */
export async function schreibeKartenSperre(db: Db, zertifikatDerBase64: string, hinweis: string): Promise<void> {
  for (let versuch = 1; ; versuch++) {
    try {
      await db.update(kassen)
        .set({ kartePinGesperrt: true, kartePinHinweis: hinweis, updatedAt: new Date() })
        .where(eq(kassen.seeZertifikatDer, zertifikatDerBase64))
      return
    } catch (err) {
      if (versuch >= 3) throw err
      await new Promise(r => setTimeout(r, 200 * versuch))
    }
  }
}
