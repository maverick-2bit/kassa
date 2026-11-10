/**
 * Sprachbestellung — Vorlesen der Rückmeldung (Speech Synthesis des Browsers, läuft lokal und offline).
 *
 * Der Kellner hört im Headset, was verstanden wurde („Tisch 12: zwei Bier … Richtig?"), und antwortet
 * mit „ja" oder „nein" — ohne aufs Display zu schauen.
 */

const SPEICHER_SCHLUESSEL = 'kellner.sprache.vorlesen'

export function vorlesenVerfuegbar(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
}

/** Ist das Vorlesen eingeschaltet? Standard: ja. (Browser-Speicher kann fehlen/gesperrt sein → Standard.) */
export function vorlesenGewuenscht(): boolean {
  try { return window.localStorage.getItem(SPEICHER_SCHLUESSEL) !== 'aus' } catch { return true }
}

export function speichereVorlesenGewuenscht(an: boolean): void {
  try { window.localStorage.setItem(SPEICHER_SCHLUESSEL, an ? 'an' : 'aus') } catch { /* nur Komfort */ }
}

/** Beste deutsche Stimme: österreichisch vor deutsch vor irgendeiner deutschen. */
function waehleStimme(): SpeechSynthesisVoice | undefined {
  const stimmen = window.speechSynthesis.getVoices()
  return stimmen.find(v => v.lang.toLowerCase().replace('_', '-') === 'de-at')
    ?? stimmen.find(v => v.lang.toLowerCase().replace('_', '-') === 'de-de')
    ?? stimmen.find(v => v.lang.toLowerCase().startsWith('de'))
}

/** Liest den Text vor; die Zusage endet, wenn fertig, abgebrochen oder nicht möglich (wirft nie). */
export function spreche(text: string): Promise<void> {
  if (!vorlesenVerfuegbar() || text.trim() === '') return Promise.resolve()
  return new Promise<void>((fertig) => {
    try {
      window.speechSynthesis.cancel() // nie zwei Ansagen übereinander
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'de-AT'
      const stimme = waehleStimme()
      if (stimme) u.voice = stimme
      u.onend = () => fertig()
      u.onerror = () => fertig()
      window.speechSynthesis.speak(u)
    } catch {
      fertig()
    }
  })
}

/** Laufende Ansage sofort beenden (z. B. wenn der Kellner die Sprechtaste drückt). */
export function stoppeSprechen(): void {
  if (!vorlesenVerfuegbar()) return
  try { window.speechSynthesis.cancel() } catch { /* egal */ }
}
