/**
 * Sprachbestellung — Spracherkennung des Browsers (Web Speech API) hinter einer kleinen Schnittstelle.
 *
 * Prototyp-Weg: läuft in Chrome/Edge (und Android-Chrome), braucht Internet und eine gesicherte Verbindung
 * (HTTPS oder localhost). Der Browser schickt das Gesprochene zur Erkennung an seinen Hersteller (bei Chrome
 * Google) — der Dialog weist darauf hin. Die Schnittstelle ist bewusst so geschnitten, dass später eine
 * Server-Erkennung (Cloud oder lokales Whisper) dieselbe Form bedienen kann.
 */

// Minimale Typen: die Web Speech API fehlt in den TypeScript-DOM-Typen.
interface SprachErgebnisAlternative { transcript: string }
interface SprachErgebnis { isFinal: boolean; 0: SprachErgebnisAlternative; length: number }
interface SprachErgebnisListe { length: number; [index: number]: SprachErgebnis }
interface SprachErgebnisEreignis { resultIndex: number; results: SprachErgebnisListe }
interface SprachFehlerEreignis { error: string }
interface SprachErkenner {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: SprachErgebnisEreignis) => void) | null
  onerror: ((e: SprachFehlerEreignis) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type SprachErkennerKlasse = new () => SprachErkenner

function erkennerKlasse(): SprachErkennerKlasse | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: SprachErkennerKlasse; webkitSpeechRecognition?: SprachErkennerKlasse }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export type ErkennungStatus = { ok: true } | { ok: false; grund: string }

/** Kann dieses Gerät/dieser Browser Sprache erkennen? Mit lesbarem Grund, wenn nicht. */
export function erkennungStatus(): ErkennungStatus {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return { ok: false, grund: 'Das Mikrofon braucht eine gesicherte Verbindung (HTTPS). Bitte die App über ihre https-Adresse öffnen (Kasse: Einstellungen → Geräte).' }
  }
  if (!erkennerKlasse()) {
    return { ok: false, grund: 'Dieser Browser kann keine Sprache erkennen. Bitte Chrome oder Edge verwenden.' }
  }
  return { ok: true }
}

/** Fehlercode der Web Speech API → Meldung für den Kellner (null = ignorieren). */
export function fehlerMeldung(code: string): string | null {
  switch (code) {
    case 'aborted':             return null
    case 'no-speech':           return 'Nichts gehört. Taste halten und erst dann sprechen.'
    case 'audio-capture':       return 'Kein Mikrofon gefunden.'
    case 'not-allowed':
    case 'service-not-allowed': return 'Mikrofon nicht erlaubt. Zugriff im Browser freigeben und erneut versuchen.'
    case 'network':             return 'Die Spracherkennung braucht eine Internetverbindung.'
    default:                    return `Spracherkennung fehlgeschlagen (${code}).`
  }
}

export interface ErkennungSitzung {
  /** Taste losgelassen: Erkennung beenden, der fertige Text kommt über onFertig. */
  stoppen(): void
  /** Verwerfen, ohne Ergebnis. */
  abbrechen(): void
}

export interface ErkennungOptionen {
  /** Sprachvariante; Österreichisch ist dem Browser bekannt, fällt sonst auf Deutsch zurück. */
  sprache?: string
  /** Laufender Text, solange gesprochen wird. */
  onZwischen?: (text: string) => void
  /** Endgültiger Text nach dem Loslassen. */
  onFertig: (text: string) => void
  onFehler: (meldung: string) => void
}

export function starteErkennung(opt: ErkennungOptionen): ErkennungSitzung {
  const Klasse = erkennerKlasse()
  if (!Klasse) {
    opt.onFehler('Dieser Browser kann keine Sprache erkennen.')
    return { stoppen() {}, abbrechen() {} }
  }

  const rec = new Klasse()
  rec.lang = opt.sprache ?? 'de-AT'
  rec.continuous = true       // läuft, solange die Taste gehalten wird (nicht schon nach der ersten Pause)
  rec.interimResults = true
  rec.maxAlternatives = 1

  let text = ''
  let verworfen = false
  let fehlerGemeldet = false

  rec.onresult = (e) => {
    let gesamt = ''
    for (let i = 0; i < e.results.length; i++) gesamt += e.results[i]![0].transcript
    text = gesamt
    opt.onZwischen?.(gesamt.trim())
  }
  rec.onerror = (e) => {
    const meldung = fehlerMeldung(e.error)
    if (meldung && !verworfen) { fehlerGemeldet = true; opt.onFehler(meldung) }
  }
  rec.onend = () => {
    if (verworfen || fehlerGemeldet) return
    const fertig = text.trim()
    if (fertig === '') opt.onFehler('Nichts gehört. Taste halten und erst dann sprechen.')
    else opt.onFertig(fertig)
  }

  try {
    rec.start()
  } catch {
    opt.onFehler('Die Spracherkennung konnte nicht gestartet werden.')
    return { stoppen() {}, abbrechen() {} }
  }

  return {
    stoppen() { try { rec.stop() } catch { /* schon beendet */ } },
    abbrechen() { verworfen = true; try { rec.abort() } catch { /* schon beendet */ } },
  }
}
