/**
 * Sprachbestellung — Zahlwörter (rein, ohne DB/IO).
 *
 * Kellner sagen "zwei Bier", "a Seidl" (österreichisch für "ein"), "einmal Schnitzel" oder
 * die Erkennung liefert gleich "2 Bier". Eingabe ist bereits normalisiert (siehe text.ts).
 */

const EINER: Record<string, number> = {
  ein: 1, eine: 1, einen: 1, einem: 1, einer: 1, eines: 1, eins: 1, a: 1, einmal: 1,
  zwei: 2, zwo: 2, zwoa: 2, zwa: 2, zweimal: 2,
  drei: 3, dreimal: 3,
  vier: 4, viermal: 4,
  fuenf: 5, fuenfmal: 5, fuef: 5,
  sechs: 6, sechsmal: 6,
  sieben: 7, siebenmal: 7,
  acht: 8, achtmal: 8,
  neun: 9, neunmal: 9,
  zehn: 10, zehnmal: 10,
  elf: 11, zwoelf: 12,
  dreizehn: 13, vierzehn: 14, fuenfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19,
  zwanzig: 20, dreissig: 30, vierzig: 40, fuenfzig: 50,
}

/** Zahl für ein einzelnes Wort ("zwei", "2", "2x", "zweimal") oder null, wenn es keine ist. */
export function zahlwort(token: string): number | null {
  if (/^\d{1,3}x?$/.test(token)) {
    const n = parseInt(token, 10)
    return n >= 1 ? n : null
  }
  const n = EINER[token]
  return n === undefined ? null : n
}

const WORT: Record<number, string> = {
  1: 'ein', 2: 'zwei', 3: 'drei', 4: 'vier', 5: 'fünf', 6: 'sechs', 7: 'sieben', 8: 'acht', 9: 'neun',
  10: 'zehn', 11: 'elf', 12: 'zwölf',
}

/** Zahl zum Vorlesen: 1..12 als Wort, sonst Ziffern. */
export function zahlAlsWort(n: number): string {
  return WORT[n] ?? String(n)
}
