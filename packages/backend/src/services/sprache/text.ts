/**
 * Sprachbestellung — Textwerkzeuge (rein, ohne DB/IO).
 *
 * Spracherkennung liefert Text mit Verhörern ("Seitel" statt "Seidl", "Spritzer weiß" statt
 * "Weißer Spritzer"). Damit der Abgleich mit dem Artikelstamm trotzdem klappt, wird alles
 * auf eine gemeinsame Schreibweise gebracht und unscharf verglichen: Editierabstand plus
 * Kölner Phonetik (für das Deutsche gebaut, kennt z. B. "ei"/"ai" und "d"/"t" als ähnlich).
 */

/** Kleinschreibung, Umlaute/ß aufgelöst, Akzente weg, nur [a-z0-9,] und Leerzeichen. */
export function normalisiere(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    // Dezimalkomma ("0,5l") ist KEIN Trenner → "05l" (Artikelnamen werden gleich behandelt)
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/[^a-z0-9,\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Zerlegt in Wörter; das Komma bleibt als eigenes Token erhalten (Trenner zwischen Positionen). */
export function tokenisiere(text: string): string[] {
  return normalisiere(text).replace(/,/g, ' , ').split(' ').filter(t => t !== '')
}

/** Editierabstand (Levenshtein). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let vorher = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const aktuell = [i]
    for (let j = 1; j <= b.length; j++) {
      const kosten = a[i - 1] === b[j - 1] ? 0 : 1
      aktuell[j] = Math.min(vorher[j]! + 1, aktuell[j - 1]! + 1, vorher[j - 1]! + kosten)
    }
    vorher = aktuell
  }
  return vorher[b.length]!
}

/**
 * Kölner Phonetik für EIN normalisiertes Wort (a–z). Gleich klingende Wörter ergeben denselben
 * Code: "seidl" und "seitel" → "825". Vokale zählen nur am Wortanfang.
 */
export function koelnerPhonetik(wort: string): string {
  const w = wort.toLowerCase().replace(/[^a-z]/g, '')
  if (w === '') return ''
  const codes: string[] = []
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!
    const vor = i > 0 ? w[i - 1]! : ''
    const nach = i < w.length - 1 ? w[i + 1]! : ''
    let code: string
    switch (c) {
      case 'a': case 'e': case 'i': case 'j': case 'o': case 'u': case 'y': code = '0'; break
      case 'h': code = ''; break
      case 'b': code = '1'; break
      case 'p': code = nach === 'h' ? '3' : '1'; break
      case 'd': case 't': code = 'csz'.includes(nach) && nach !== '' ? '8' : '2'; break
      case 'f': case 'v': case 'w': code = '3'; break
      case 'g': case 'k': case 'q': code = '4'; break
      case 'c':
        if (i === 0) code = 'ahkloqrux'.includes(nach) && nach !== '' ? '4' : '8'
        else if ('sz'.includes(vor)) code = '8'
        else code = 'ahkoqux'.includes(nach) && nach !== '' ? '4' : '8'
        break
      case 'x': code = 'ckq'.includes(vor) && vor !== '' ? '8' : '48'; break
      case 'l': code = '5'; break
      case 'm': case 'n': code = '6'; break
      case 'r': code = '7'; break
      case 's': case 'z': code = '8'; break
      default: code = ''
    }
    codes.push(code)
  }
  // Doppelte benachbarte Codes zusammenziehen, dann alle Nullen außer am Anfang entfernen
  const roh = codes.join('')
  let ohneDoppelte = ''
  for (const z of roh) if (z !== ohneDoppelte[ohneDoppelte.length - 1]) ohneDoppelte += z
  return ohneDoppelte[0] + ohneDoppelte.slice(1).replace(/0/g, '')
}

/** Ähnlichkeit zweier Wörter 0..1 (1 = gleich). Kurze Wörter (≤ 2 Zeichen) nur bei Gleichheit. */
export function wortAehnlichkeit(a: string, b: string, codeA = koelnerPhonetik(a), codeB = koelnerPhonetik(b)): number {
  if (a === b) return 1
  if (a.length <= 2 || b.length <= 2) return 0
  const kurz = a.length <= b.length ? a : b
  const lang = a.length <= b.length ? b : a
  // Beugung: "weiss" ↔ "weisser", "schnitzel" ↔ "schnitzeln", "gross" ↔ "grosses"
  if (kurz.length >= 3 && lang.startsWith(kurz) && lang.length - kurz.length <= (kurz.length >= 5 ? 3 : 1)) return 0.92
  // Zusammensetzung: "schnitzel" steckt in "putenschnitzel" — passt, aber nie so sicher wie ein ganzes Wort
  if (kurz.length >= 4 && lang.length > kurz.length && lang.endsWith(kurz)) return 0.8
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length)
  // Klingt gleich → Bonus, aber nur wenn auch die Schreibung nicht völlig daneben liegt. Bewusst unter
  // 0.85 gedeckelt: ein Treffer nur „nach Gehör" bleibt immer eine Rückfrage wert (Verhörer vs. anderes Wort).
  const klang = codeA !== '' && codeA === codeB ? 0.5 + 0.34 * lev : 0
  return Math.max(lev, klang)
}
