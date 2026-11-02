/**
 * Zeitstempel eines neuen Belegs: nie vor dem Vorbeleg.
 *
 * Die RKSV verlangt aufsteigende Belegzeiten (Prüftool: Chronologie). Die Systemuhr eines
 * Kassen-PCs kann springen — leere CMOS-Batterie, falsch gestellte Uhr, Synchronisation
 * nach dem Aufwachen. Ein Beleg mit einer Zeit VOR dem Vorbeleg würde signiert und wäre
 * nie wieder gerade zu biegen.
 *
 *  - Rücksprung bis `UHR_TOLERANZ_MS` (Synchronisation, Sprünge im Sekundenbereich):
 *    der Beleg bekommt die Zeit des Vorbelegs — die Kette bleibt zeitlich geordnet,
 *    die Kasse läuft weiter.
 *  - Größerer Rücksprung: Beleg ablehnen. Eine Kasse, die danach wochenlang Belege mit der
 *    Zeit des letzten Belegs schreibt, würde einen Uhrenfehler verstecken.
 */

export const UHR_TOLERANZ_MS = 60_000

export type BelegZeit =
  | { ok: true;  zeit: Date; angeglichenUmMs: number }
  | { ok: false; rueckstandMs: number; letzterBelegDatum: Date }

export function bestimmeBelegZeit(jetzt: Date, letzterBelegDatum: Date | null | undefined): BelegZeit {
  if (!letzterBelegDatum || jetzt.getTime() >= letzterBelegDatum.getTime()) {
    return { ok: true, zeit: jetzt, angeglichenUmMs: 0 }
  }
  const rueckstandMs = letzterBelegDatum.getTime() - jetzt.getTime()
  if (rueckstandMs <= UHR_TOLERANZ_MS) {
    return { ok: true, zeit: new Date(letzterBelegDatum.getTime()), angeglichenUmMs: rueckstandMs }
  }
  return { ok: false, rueckstandMs, letzterBelegDatum }
}
