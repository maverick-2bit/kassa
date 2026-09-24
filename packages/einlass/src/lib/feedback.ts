/**
 * Ton + Vibration zum Scan-Ergebnis — am lauten Eingang schaut niemand bei
 * jedem Gast aufs Display. Browser erlauben Ton erst nach einer Berührung,
 * deshalb schaltet `freischalten()` den Audio-Kontext beim ersten Tipp frei.
 */

let kontext: AudioContext | null = null

export function freischalten(): void {
  if (!kontext) {
    try { kontext = new AudioContext() } catch { return }
  }
  void kontext.resume()
}

function ton(frequenz: number, dauerMs: number, versatzS = 0): void {
  if (!kontext) return
  const start = kontext.currentTime + versatzS
  const osz = kontext.createOscillator()
  const laut = kontext.createGain()
  osz.type = 'sine'
  osz.frequency.value = frequenz
  laut.gain.setValueAtTime(0.0001, start)
  laut.gain.exponentialRampToValueAtTime(0.35, start + 0.01)
  laut.gain.exponentialRampToValueAtTime(0.0001, start + dauerMs / 1000)
  osz.connect(laut).connect(kontext.destination)
  osz.start(start)
  osz.stop(start + dauerMs / 1000 + 0.02)
}

export function signal(art: 'ok' | 'mehrfach' | 'nein'): void {
  if (art === 'nein') {
    navigator.vibrate?.([160, 80, 160])
    ton(220, 260); ton(170, 320, 0.3)
  } else {
    navigator.vibrate?.(70)
    ton(880, 110)
    if (art === 'ok') ton(1320, 130, 0.12)
  }
}
