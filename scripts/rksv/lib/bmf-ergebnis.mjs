// Auswertung der Ausgabe des BMF-Prüftools (regkassen-verification 1.1.x).
//
// Das Tool schreibt je Beleg N (vierstellig, ab 0) mehrere JSON-Dateien und am Ende zwei Sammeldateien:
//   N_app.json        Urteil in der Form der BMF-Belegcheck-App (nur Wurzel)
//   N_cashbox.json    Einzelbelegprüfung wie in FinanzOnline — NUR die fehlerhaften Prüfungen
//   N_dep.json        Prüfungen des RKSV-DEP-Exports für diesen Beleg (Kette, Umsatzzähler, Abfolge, Chronologie)
//   DEP-global.json   Zusammenfassung der globalen DEP-Prüfungen (JSON-Format, Anzahl, alle Belege)
//   N_cashbox_full.json, DEP-full.json   ALLE Prüfungen inkl. verworfener Hypothesen — nicht für das Urteil geeignet:
//        Der Typ eines Belegs (Start, Null, Standard, Training, Storno) wird durch Ausprobieren ermittelt; die Hypothesen,
//        die nicht zutreffen (TYPE_OF_RECEIPT_*), stehen dort als FAIL unter einem Wurzelelement, das PASS ist.
// Ein Ergebnis ist ein Objekt mit `verificationState` (PASS | FAIL | INFORMATION | NOT_EXECUTED), `verificationId`,
// ggf. `verificationResultDetailedMessage`, verschachtelt in `verificationResultList` (Namen wie in verification.xsd).
//
// Urteil: nur die Wurzeln der Dateien N_app/N_cashbox/N_dep und DEP-global.json. Ein Lauf ohne ein einziges erkanntes PASS
// gilt nicht als bestanden.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// \d{4,}: ab Beleg 10000 hat der Dateiname fünf Stellen — mit genau vier wären diese Belege nie ausgewertet worden.
const URTEIL_DATEIEN = [/(^|[\\/])\d{4,}_(app|cashbox|dep)\.json$/, /(^|[\\/])DEP-global\.json$/]

export const istUrteilsdatei = name => URTEIL_DATEIEN.some(m => m.test(name))

/**
 * Liefert die Urteilsdateien unter `ordner` nacheinander statt alle auf einmal. Die `*_full.json` und `DEP-full.json` werden gar
 * nicht erst gelesen: sie sind groß und zählen nicht. Bei 20 000 Belegen (langer Burn-in) sprengte das Einlesen aller Dateien den
 * Speicher von Node (Nachtlauf 2026-11-08: Abbruch in `NewRawTwoByteString`, keine Zusammenfassung).
 */
export function* urteilsDateien(ordner, tiefe = 0) {
  if (!existsSync(ordner) || tiefe > 3) return
  for (const name of readdirSync(ordner)) {
    const pfad = join(ordner, name)
    const st = statSync(pfad)
    if (st.isDirectory()) yield* urteilsDateien(pfad, tiefe + 1)
    else if (istUrteilsdatei(pfad) && st.size < 50 * 1024 * 1024) yield { name: pfad, inhalt: readFileSync(pfad, 'utf8') }
  }
}

const KONSOLE_PROBLEME = [
  /validation process failed/i,
  /validation # \d+:\s*FAIL/i,                 // „Machine readable code validation # 0: FAIL", „RKSV-DEP-EXPORT-validation # 0: FAIL"
  /Fatal internal error/i,
  /Error while parsing the input files/i,
  /One of the provided files does not exist/i,
  /Exception in thread/i,
  /NoClassDefFoundError/i,
  /UnsupportedClassVersionError/i,
  /Could not find or load main class/i,
  /Unrecognized option/i,
]

function text(wert) {
  if (wert == null) return ''
  return typeof wert === 'string' ? wert : JSON.stringify(wert)
}

/** Sammelt die untersten fehlgeschlagenen Prüfungen unter `wert` (Vorfahren-FAIL fassen sie nur zusammen). Liefert true bei FAIL. */
export function sammleFehler(wert, datei, fehlgeschlagen) {
  if (Array.isArray(wert)) return wert.map(x => sammleFehler(x, datei, fehlgeschlagen)).some(Boolean)
  if (wert === null || typeof wert !== 'object') return false
  let kindFail = false
  for (const kind of Object.values(wert)) {
    if (kind && typeof kind === 'object') kindFail = sammleFehler(kind, datei, fehlgeschlagen) || kindFail
  }
  const zustand = typeof wert.verificationState === 'string' ? wert.verificationState.toUpperCase() : null
  if (zustand === 'FAIL' && !kindFail) {
    fehlgeschlagen.push({
      datei,
      name: text(wert.verificationId ?? wert.verificationName ?? '?'),
      meldung: text(wert.verificationResultDetailedMessage ?? wert.verificationTextualDescription ?? wert.verificationName ?? '').slice(0, 400),
    })
  }
  return zustand === 'FAIL' || kindFail
}

/**
 * @param {Iterable<{ name: string, inhalt: string }>} dateien  Inhalte der JSON-Dateien im Ausgabeordner (Liste oder Generator `urteilsDateien`; ausgewertet werden nur die Urteilsdateien)
 * @param {string} konsole  Standardausgabe + Fehlerausgabe des Tools
 * @param {number|null} exitCode
 */
export function analysiere(dateien, konsole, exitCode) {
  const zaehler = {}
  const fehlgeschlagen = []
  let gelesen = 0
  for (const d of dateien) {
    if (!istUrteilsdatei(d.name)) continue
    let json
    try { json = JSON.parse(d.inhalt) } catch { continue }
    gelesen++
    for (const wurzel of Array.isArray(json) ? json : [json]) {
      const zustand = typeof wurzel?.verificationState === 'string' ? wurzel.verificationState.toUpperCase() : '(ohne)'
      zaehler[zustand] = (zaehler[zustand] ?? 0) + 1
      if (zustand === 'FAIL') {
        const vorher = fehlgeschlagen.length
        sammleFehler(wurzel, d.name, fehlgeschlagen)
        if (fehlgeschlagen.length === vorher) {   // Wurzel ist FAIL, aber ohne Einzelheiten (z. B. N_app.json)
          fehlgeschlagen.push({ datei: d.name, name: text(wurzel.verificationId ?? '?'), meldung: text(wurzel.verificationResultDetailedMessage ?? '').slice(0, 400) })
        }
      }
    }
  }
  const konsolenProbleme = []
  for (const zeile of konsole.split(/\r?\n/)) {
    if (KONSOLE_PROBLEME.some(m => m.test(zeile))) konsolenProbleme.push(zeile.trim().slice(0, 300))
  }
  const bestanden = zaehler.PASS ?? 0
  const hinweise = []
  if (gelesen === 0) hinweise.push('Das Tool hat keine auswertbare Urteilsdatei geschrieben (N_app/N_cashbox/N_dep/DEP-global)')
  else if (bestanden === 0 && !zaehler.FAIL) hinweise.push('Kein einziges bestandenes Prüfergebnis erkannt — Ausgabeformat prüfen')
  if (exitCode !== 0) hinweise.push(`Exit-Code ${exitCode}`)
  const ok = exitCode === 0 && !zaehler.FAIL && konsolenProbleme.length === 0 && bestanden > 0
  return { ok, zaehler, fehlgeschlagen, konsolenProbleme, hinweis: hinweise.join('; ') }
}
