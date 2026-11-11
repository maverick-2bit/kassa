// Download mit Wiederholung. GitHub liefert auf Release-Downloads gelegentlich 5xx (Nachtlauf 2026-11-09: HTTP 504 auf das ZIP
// mit den BMF-Beispieldaten) — das darf eine Nacht nicht rot färben. Wiederholt wird bei Netzwerkfehlern und bei HTTP 5xx, 408
// und 429; ein 404 und Ähnliches ist endgültig. Die Prüfsumme prüft der Aufrufer (ein verfälschtes ZIP wird nie ausgeführt).

const wiederholbar = status => status >= 500 || status === 408 || status === 429

/**
 * @param {string} url
 * @param {{ versuche?: number, wartenMs?: number[], fetchFn?: typeof fetch, schlafe?: (ms: number) => Promise<void>, log?: (zeile: string) => void }} [optionen]
 * @returns {Promise<Buffer>}
 */
export async function ladeBytes(url, optionen = {}) {
  const {
    versuche = 4,
    wartenMs = [5_000, 15_000, 45_000],
    fetchFn = fetch,
    schlafe = ms => new Promise(weiter => setTimeout(weiter, ms)),
    log = console.log,
  } = optionen

  for (let versuch = 1; ; versuch++) {
    let grund
    let endgueltig = false
    try {
      const antwort = await fetchFn(url, { redirect: 'follow' })
      if (antwort.ok) return Buffer.from(await antwort.arrayBuffer())
      grund = `HTTP ${antwort.status}`
      endgueltig = !wiederholbar(antwort.status)
    } catch (fehler) {
      grund = fehler?.cause?.code ?? fehler?.message ?? String(fehler)   // Netzwerkfehler (DNS, Reset, Timeout): wiederholen
    }
    if (endgueltig || versuch >= versuche) throw new Error(`Download fehlgeschlagen: ${grund} (${url})`)
    const warte = wartenMs[Math.min(versuch - 1, wartenMs.length - 1)] ?? 0
    log(`  ${grund} — neuer Versuch ${versuch + 1}/${versuche} in ${warte / 1000} s`)
    await schlafe(warte)
  }
}
