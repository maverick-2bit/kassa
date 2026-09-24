const UHRZEIT = new Intl.DateTimeFormat('de-AT', { timeZone: 'Europe/Vienna', hour: '2-digit', minute: '2-digit' })
const DATUM_ZEIT = new Intl.DateTimeFormat('de-AT', {
  timeZone: 'Europe/Vienna', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
})

export const uhrzeit   = (iso: string) => UHRZEIT.format(new Date(iso))
export const datumZeit = (iso: string) => DATUM_ZEIT.format(new Date(iso))

/** YYYY-MM-DD → TT.MM.JJJJ (ohne Zeitzonen-Umweg — es ist ein reines Kalenderdatum) */
export function geburtsdatumText(iso: string): string {
  const [j, m, t] = iso.split('-')
  return `${t}.${m}.${j}`
}

/**
 * Schriftfarbe für eine Bandfarbe als Hintergrund: Gelb braucht dunkle Schrift,
 * Grün/Rot/Blau helle — sonst ist das Wichtigste am Einlass unlesbar.
 */
export function schriftAuf(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const kanal = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  const l = 0.2126 * kanal((n >> 16) & 255) + 0.7152 * kanal((n >> 8) & 255) + 0.0722 * kanal(n & 255)
  return l > 0.35 ? '#111827' : '#ffffff'
}
