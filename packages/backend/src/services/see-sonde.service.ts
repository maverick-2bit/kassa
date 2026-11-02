/**
 * Hintergrundsonde für die automatische Wiederherstellung der Signatureinheit.
 *
 * Fällt die externe Signaturerstellungseinheit (A-Trust HSM) aus — Netz weg, Timeout, HTTP 5xx —,
 * geht die Kassa selbst in den Ausfallmodus: Belege tragen den Marker statt einer Signatur. Bis
 * v0.8.74 gab es von dort nur den Weg zurück per Knopf im roten Banner. Eine Kassa, an der
 * niemand den Banner liest (Wochenende, Schankwagen), lief danach stunden- oder tagelang
 * unsigniert weiter, obwohl der Ausfall nach Minuten behoben war.
 *
 * Die Sonde prüft in kurzem Abstand, ob die Einheit wieder antwortet, und stellt die Signatur
 * dann selbst wieder her — genau wie der Knopf: signierter Nullbeleg als Sammelbeleg, Ausfall-Flag
 * zurück, beides in einer Transaktion.
 *
 * Grenzen (bewusst):
 *  - Nur Kassen mit A-Trust-Anbindung. Eine Software-SEE „fällt" nur durch Fehler oder durch
 *    eine Meldung von Hand aus; eine bewusste Ausfallmeldung hebt die Sonde nicht auf.
 *  - Nur Ausfälle unter 48 Stunden. Ab 48 Stunden ist der Ausfall FinanzOnline zu melden (RKSV);
 *    die Zugangsdaten dafür werden nie gespeichert, die Meldung kommt aus dem Banner — dort muss
 *    ein Mensch zumindest einmal hinsehen.
 *  - Antwortet die Einheit mit einer Ablehnung (HTTP 4xx), versucht die Sonde es erst nach einer
 *    Viertelstunde wieder: Warten behebt kein falsches Passwort, und jeder Versuch schriebe ins Log.
 */

import { and, eq, isNotNull } from 'drizzle-orm'
import { ATrustHsmEinheit, ATrustHsmError, klassifiziereSeeFehler } from '@kassa/rksv'
import type { Db } from '../db/client.js'
import { kassen } from '../db/schema.js'
import { decryptPrivateKey } from '../crypto/master-key.js'
import { logAudit } from './audit.service.js'
import {
  BelegError,
  FON_MELDE_SCHWELLE_MIN,
  SEE_ABGELEHNT,
  meldeSeeWiederherstellung,
  type BelegServiceDeps,
} from './beleg.service.js'

type Logger = {
  info:  (msg: string) => void
  warn?: (obj: unknown, msg: string) => void
  error: (obj: unknown, msg: string) => void
}

/** Nach einer Ablehnung (HTTP 4xx) so lange nicht erneut versuchen. */
export const SONDE_PAUSE_NACH_ABLEHNUNG_MS = 15 * 60_000

export interface SondenErgebnis {
  kasseId:  string
  kassenId: string
  /** wiederhergestellt | nicht-erreichbar | abgelehnt | pausiert | zu-lange-ausgefallen | fehlgeschlagen */
  ausgang:  'wiederhergestellt' | 'nicht-erreichbar' | 'abgelehnt' | 'pausiert' | 'zu-lange-ausgefallen' | 'fehlgeschlagen'
}

/** Sonde je Kasse: wann darf sie nach einer Ablehnung wieder versuchen? (nur im Speicher) */
const pausiertBis = new Map<string, number>()

/** Nur für Tests. */
export function vergesseSondenZustand(): void {
  pausiertBis.clear()
}

/**
 * Ein Durchlauf: alle Kassen mit A-Trust-Anbindung im Ausfall prüfen und, wo die Einheit wieder
 * antwortet, die Signatur wiederherstellen. Mit festem `jetzt` aufrufbar → deterministisch testbar.
 */
export async function pruefeSeeWiederherstellung(
  db:    Db,
  deps:  BelegServiceDeps,
  jetzt: Date = new Date(),
  log?:  Logger,
): Promise<SondenErgebnis[]> {
  const kandidaten = await db
    .select({
      id:               kassen.id,
      kassenId:         kassen.kassenId,
      mandantId:        kassen.mandantId,
      seit:             kassen.seeAusgefallenSeit,
      basisUrl:         kassen.atrustBasisUrl,
      benutzer:         kassen.atrustBenutzer,
      passwortEnc:      kassen.atrustPasswortEnc,
    })
    .from(kassen)
    .where(and(
      isNotNull(kassen.seeAusgefallenSeit),
      eq(kassen.seeTyp, 'atrust_hsm'),
      eq(kassen.status, 'aktiv'),
    ))

  const ergebnisse: SondenErgebnis[] = []

  for (const k of kandidaten) {
    const ergebnis = (ausgang: SondenErgebnis['ausgang']): void => {
      ergebnisse.push({ kasseId: k.id, kassenId: k.kassenId, ausgang })
    }
    const dauerMinuten = Math.max(0, Math.floor((jetzt.getTime() - k.seit!.getTime()) / 60_000))
    if (dauerMinuten >= FON_MELDE_SCHWELLE_MIN) { ergebnis('zu-lange-ausgefallen'); continue }
    if ((pausiertBis.get(k.id) ?? 0) > jetzt.getTime()) { ergebnis('pausiert'); continue }
    if (!k.basisUrl || !k.benutzer || !k.passwortEnc) { ergebnis('fehlgeschlagen'); continue }

    try {
      // 1) Antwortet die Einheit wieder? Ein leichter Aufruf OHNE Signatur und ohne Sperre auf die Kasse
      //    (die Wiederherstellung hielte die Kassensperre während des Aufrufs).
      const einheit = new ATrustHsmEinheit({
        basisUrl: k.basisUrl,
        benutzer: k.benutzer,
        passwort: decryptPrivateKey(k.passwortEnc, deps.masterPassphrase).toString('utf8'),
      })
      try {
        await einheit.zdaId()
      } catch {
        ergebnis('nicht-erreichbar')
        continue
      }

      // 2) Wiederherstellen: signierter Nullbeleg + Ausfall-Flag zurück, atomar — wie der Knopf im Banner
      const res = await meldeSeeWiederherstellung(k.id, deps)
      await logAudit(db, {
        mandantId: k.mandantId, aktion: 'see.automatisch_wiederhergestellt',
        details: {
          kasseId: k.id, ausfallMinuten: res.behobenerAusfall.dauerMinuten,
          sammelbelegNummer: res.sammelbeleg.belegNummer,
        },
      })
      log?.info(`SEE-Sonde ${k.kassenId}: Signatureinheit wieder erreichbar — Signatur nach ${dauerMinuten} Min Ausfall automatisch wiederhergestellt (Sammelbeleg ${res.sammelbeleg.belegNummer})`)
      pausiertBis.delete(k.id)
      ergebnis('wiederhergestellt')
    } catch (err) {
      // Die Wiederherstellung wirft ATrustHsmError, wenn die Einheit nicht (mehr) antwortet oder ablehnt;
      // ein BelegError mit SEE_ABGELEHNT, wenn Schlüssel/Zertifikat nicht zusammenpassen.
      const abgelehnt = (err instanceof BelegError && err.code === SEE_ABGELEHNT)
        || (err instanceof ATrustHsmError && klassifiziereSeeFehler(err) === 'konfiguration')
      if (abgelehnt) {
        pausiertBis.set(k.id, jetzt.getTime() + SONDE_PAUSE_NACH_ABLEHNUNG_MS)
        log?.error({ err, kasseId: k.id }, `SEE-Sonde ${k.kassenId}: Signatureinheit lehnt die Anfrage ab — nächster Versuch in 15 Min`)
        ergebnis('abgelehnt')
      } else if (err instanceof ATrustHsmError) {
        // Die Einheit antwortet auf /ZDA, aber das Signieren scheitert noch (Teilausfall): beim nächsten Durchlauf erneut
        ergebnis('nicht-erreichbar')
      } else if (err instanceof BelegError && err.httpStatus === 409) {
        // Kasse stillgelegt/übertragen/Zertifikat abgelaufen, oder der Ausfall wurde inzwischen von Hand beendet
        ergebnis('fehlgeschlagen')
      } else {
        log?.error({ err, kasseId: k.id }, `SEE-Sonde ${k.kassenId}: unerwarteter Fehler`)
        ergebnis('fehlgeschlagen')
      }
    }
  }

  return ergebnisse
}
