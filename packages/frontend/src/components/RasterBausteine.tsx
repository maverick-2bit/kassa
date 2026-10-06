/**
 * RasterBausteine — kleine Bausteine, die Kassen-Raster (ArtikelGrid) und Raster-Editor
 * (ArtikelAnordnungEditor) gemeinsam nutzen: Kachel einer Untergruppe, lesbare Schriftfarbe.
 */

/** Lesbare Schriftfarbe (weiß/dunkel) auf einem Hex-Hintergrund. */
export function schriftAuf(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const helligkeit = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255))
  return helligkeit > 160 ? '#1f2937' : '#ffffff'
}

/** Box-Symbol auf der Kachel einer Untergruppe. */
export function BoxSymbol() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 opacity-90" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
      <path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9L12 3Z" />
      <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
    </svg>
  )
}
