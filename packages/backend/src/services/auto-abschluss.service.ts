/**
 * Automatischer Tagesabschluss (pro Kasse konfigurierbare Uhrzeit, Wiener Zeit).
 *
 * Der Tagesabschluss ist im System ein datum-basierter Report (holeTagesabschluss)
 * — es gibt keinen persistierten Statuswechsel. „Automatisch abschließen" heißt
 * daher: zur konfigurierten Uhrzeit die Zusammenfassung des Abschlusstags per
 * E-Mail an kassen.abschlussEmail versenden und den Tag stempeln.
 *
 * Regeln (mit dem Betreiber abgestimmt):
 *  - Uhrzeit < 12:00 → abgeschlossen wird der VORTAG (Gastro schließt nach
 *    Mitternacht), sonst der aktuelle Tag.
 *  - Offene Tische blockieren NICHT — ihre Anzahl wird in der E-Mail vermerkt
 *    (die Beträge erscheinen im Abschluss des Abrechnungstags).
 *  - Kein automatischer Z-Bon-Druck (Reprint jederzeit über die Belege-Seite).
 *  - Tage ohne Belege (Ruhetag) werden ohne E-Mail übersprungen, aber gestempelt.
 *  - Idempotenz über kassen.letzterAutoAbschlussTag — pro Abschlusstag genau
 *    ein Lauf; war der Server zur Uhrzeit aus, holt der nächste Start den
 *    jüngsten ausstehenden Abschlusstag nach (ältere verfallen bewusst).
 */

import { and, count, eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import type { Config } from '../config.js'
import { kassen, mandanten, tischTabs } from '../db/schema.js'
import { holeTagesabschluss } from './tagesabschluss.service.js'
import { isEmailAktiv, sendeTagesabschlussEmail } from './email.service.js'

export interface AutoAbschlussErgebnis {
  kasseId:       string
  kassenId:      string
  tag:           string
  anzahlBelege:  number
  offeneTische:  number
  emailGesendet: boolean
  uebersprungen: 'keine-belege' | null
}

type Logger = {
  info:  (msg: string) => void
  error: (obj: unknown, msg: string) => void
}

/** Wiener Wanduhr von `jetzt`: Kalendertag (YYYY-MM-DD) + Uhrzeit (HH:MM). */
export function wienJetzt(jetzt: Date): { datum: string; hm: string } {
  const datum = jetzt.toLocaleDateString('en-CA', { timeZone: 'Europe/Vienna' })
  const hm    = jetzt.toLocaleTimeString('de-AT', {
    timeZone: 'Europe/Vienna', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  return { datum, hm }
}

/** Vortag eines YYYY-MM-DD (kalenderrein über Date.UTC — keine TZ-/DST-Effekte). */
function vortag(datum: string): string {
  const [j, m, t] = datum.split('-').map(Number)
  return new Date(Date.UTC(j!, m! - 1, t! - 1)).toISOString().slice(0, 10)
}

/** Uhrzeiten vor 12:00 schließen den Vortag ab, spätere den aktuellen Tag. */
export function bestimmeAbschlussTag(uhrzeit: string, wienDatum: string): string {
  return uhrzeit < '12:00' ? vortag(wienDatum) : wienDatum
}

/**
 * Prüft alle Kassen mit konfigurierter Auto-Abschluss-Uhrzeit und führt fällige
 * Abschlüsse durch. Mit festem `jetzt` aufrufbar → deterministisch testbar.
 */
export async function fuehreFaelligeAutoAbschluesseDurch(
  db:     Db,
  config: Config,
  jetzt:  Date,
  log?:   Logger,
): Promise<AutoAbschlussErgebnis[]> {
  const { datum, hm } = wienJetzt(jetzt)

  const kandidaten = await db
    .select({
      id:                      kassen.id,
      kassenId:                kassen.kassenId,
      mandantId:               kassen.mandantId,
      abschlussEmail:          kassen.abschlussEmail,
      autoAbschlussUhrzeit:    kassen.autoAbschlussUhrzeit,
      letzterAutoAbschlussTag: kassen.letzterAutoAbschlussTag,
      firmenname:              mandanten.firmenname,
    })
    .from(kassen)
    .innerJoin(mandanten, eq(kassen.mandantId, mandanten.id))
    .where(and(isNotNull(kassen.autoAbschlussUhrzeit), eq(kassen.status, 'aktiv')))

  const ergebnisse: AutoAbschlussErgebnis[] = []

  for (const k of kandidaten) {
    const uhrzeit = k.autoAbschlussUhrzeit!
    if (hm < uhrzeit) continue // Uhrzeit heute noch nicht erreicht

    const tag = bestimmeAbschlussTag(uhrzeit, datum)
    if (k.letzterAutoAbschlussTag === tag) continue // für diesen Tag schon gelaufen

    try {
      const ta = await holeTagesabschluss(k.id, tag, k.mandantId, { db })
      const anzahlBelege = ta.anzahlBarzahlungsbelege + ta.anzahlStornobelege

      // Ruhetag: nichts zu berichten — stempeln, keine E-Mail
      if (anzahlBelege === 0) {
        await db.update(kassen)
          .set({ letzterAutoAbschlussTag: tag, updatedAt: new Date() })
          .where(eq(kassen.id, k.id))
        ergebnisse.push({
          kasseId: k.id, kassenId: k.kassenId, tag, anzahlBelege: 0,
          offeneTische: 0, emailGesendet: false, uebersprungen: 'keine-belege',
        })
        continue
      }

      const [offen] = await db
        .select({ n: count() })
        .from(tischTabs)
        .where(and(eq(tischTabs.kasseId, k.id), eq(tischTabs.status, 'offen')))
      const offeneTische = offen?.n ?? 0

      let emailGesendet = false
      if (k.abschlussEmail && isEmailAktiv(config)) {
        try {
          await sendeTagesabschlussEmail(k.abschlussEmail, {
            firmenname:              k.firmenname,
            kassenId:                k.kassenId,
            datum:                   ta.datum,
            nettoUmsatzCent:         ta.nettoUmsatzCent,
            barCent:                 ta.barCent,
            karteCent:               ta.karteCent,
            sonstigCent:             ta.sonstigCent,
            anzahlBarzahlungsbelege: ta.anzahlBarzahlungsbelege,
            anzahlStornobelege:      ta.anzahlStornobelege,
            mwst: ta.mwst.map(m => ({
              satz:       m.label,
              nettoCent:  m.nettoCent,
              steuerCent: m.ustCent,
              bruttoCent: m.bruttoCent,
            })),
            offeneTische,
            automatisch: true,
          }, config)
          emailGesendet = true
        } catch (err) {
          // E-Mail-Fehler stoppt den Stempel nicht (sonst minütlicher Retry-Sturm);
          // der Abschluss bleibt über die Belege-Seite jederzeit abrufbar.
          log?.error({ err, kasseId: k.id }, 'Auto-Abschluss: E-Mail-Versand fehlgeschlagen')
        }
      }

      await db.update(kassen)
        .set({ letzterAutoAbschlussTag: tag, updatedAt: new Date() })
        .where(eq(kassen.id, k.id))

      log?.info(`Auto-Tagesabschluss ${k.kassenId} für ${tag}: ${anzahlBelege} Belege, ${offeneTische} offene Tische, E-Mail ${emailGesendet ? 'versendet' : 'nicht versendet'}`)
      ergebnisse.push({
        kasseId: k.id, kassenId: k.kassenId, tag, anzahlBelege,
        offeneTische, emailGesendet, uebersprungen: null,
      })
    } catch (err) {
      log?.error({ err, kasseId: k.id }, 'Auto-Tagesabschluss für Kasse fehlgeschlagen')
    }
  }

  return ergebnisse
}
