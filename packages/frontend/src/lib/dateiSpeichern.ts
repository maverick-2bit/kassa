/** Speichert Text als Datei über den Download des Browsers (kein Umweg über den Server). */
export function speichereAlsDatei(dateiname: string, inhalt: string, mime = 'application/json'): void {
  const blob = new Blob([inhalt], { type: `${mime};charset=utf-8` })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = dateiname
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Erst nach dem Start des Downloads freigeben (manche Browser brechen sonst ab)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Teil eines Dateinamens aus freiem Text: „smarte events OG" → „smarte-events-og" (ohne Umlaute und Sonderzeichen). */
export function dateinameTeil(text: string): string {
  const teil = text
    .replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return teil || 'kassa'
}
