// Auswertung der Ausgabe des BMF-Prüftools (regkassen-verification 1.1.x).
//
// Das Tool schreibt Prüfergebnisse als JSON (Dateien N_cashbox.json, N_cashbox_full.json, N_dep.json, DEP-global.json,
// DEP-full.json …). Ein Ergebnis ist ein Objekt mit `verificationState` (PASS | FAIL | INFORMATION | NOT_EXECUTED), `verificationId`,
// ggf. `verificationResultDetailedMessage`, und verschachtelt `verificationResultList` — dieselben Namen wie in
// verification.xsd des FinanzOnline-Webservice. Die Namen sind aus den Klassen des Tools gelesen (statisch, ohne Ausführung);
// das genaue Layout steht erst nach dem ersten Lauf fest — darum wird jedes JSON rekursiv durchsucht, und ein Lauf ohne
// ein einziges erkanntes Ergebnis gilt NICHT als bestanden.

const KONSOLE_PROBLEME = [
  /validation process failed/i,
  /RKSV-DEP-EXPORT-validation # \d+:\s*FAIL/i,
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

/** Durchsucht einen JSON-Wert; liefert true, wenn darunter (oder hier) ein FAIL steht. */
export function sammle(wert, datei, ergebnis) {
  if (Array.isArray(wert)) {
    let fail = false
    for (const x of wert) fail = sammle(x, datei, ergebnis) || fail
    return fail
  }
  if (wert === null || typeof wert !== 'object') return false

  let kindFail = false
  for (const kind of Object.values(wert)) {
    if (kind && typeof kind === 'object') kindFail = sammle(kind, datei, ergebnis) || kindFail
  }
  const zustand = typeof wert.verificationState === 'string' ? wert.verificationState.toUpperCase() : null
  if (zustand) {
    ergebnis.zaehler[zustand] = (ergebnis.zaehler[zustand] ?? 0) + 1
    if (zustand === 'FAIL' && !kindFail) {
      // Nur die untersten fehlgeschlagenen Prüfungen aufführen — die darüberliegenden FAIL fassen sie nur zusammen.
      ergebnis.fehlgeschlagen.push({
        datei,
        name: text(wert.verificationId ?? wert.verificationName ?? '?'),
        meldung: text(wert.verificationResultDetailedMessage ?? wert.verificationTextualDescription ?? wert.verificationName ?? '').slice(0, 400),
      })
    }
    return zustand === 'FAIL' || kindFail
  }
  return kindFail
}

/**
 * @param {{ name: string, inhalt: string }[]} dateien  Inhalte aller *.json im Ausgabeordner
 * @param {string} konsole  Standardausgabe + Fehlerausgabe des Tools
 * @param {number|null} exitCode
 */
export function analysiere(dateien, konsole, exitCode) {
  const ergebnis = { zaehler: {}, fehlgeschlagen: [] }
  let gelesen = 0
  for (const d of dateien) {
    let json
    try { json = JSON.parse(d.inhalt) } catch { continue }
    gelesen++
    sammle(json, d.name, ergebnis)
  }
  const konsolenProbleme = []
  for (const zeile of konsole.split(/\r?\n/)) {
    if (KONSOLE_PROBLEME.some(m => m.test(zeile))) konsolenProbleme.push(zeile.trim().slice(0, 300))
  }
  const bestanden = ergebnis.zaehler.PASS ?? 0
  const hinweise = []
  if (gelesen === 0) hinweise.push('Das Tool hat keine auswertbare JSON-Ausgabe geschrieben')
  else if (bestanden === 0 && ergebnis.fehlgeschlagen.length === 0) hinweise.push('Kein einziges Prüfergebnis (verificationState) erkannt — Ausgabeformat prüfen')
  if (exitCode !== 0) hinweise.push(`Exit-Code ${exitCode}`)
  const ok = exitCode === 0 && ergebnis.fehlgeschlagen.length === 0 && konsolenProbleme.length === 0 && bestanden > 0
  return {
    ok,
    zaehler: ergebnis.zaehler,
    fehlgeschlagen: ergebnis.fehlgeschlagen,
    konsolenProbleme,
    hinweis: hinweise.join('; '),
  }
}
