/**
 * Stations-IP für TCP-Hardware-Displays (Einstellungen → Hardware → KDS → "Stations-IPs").
 *
 * Gültig ist nur ein Host/eine IP-Adresse OHNE Port und ohne http:// — der Port steht getrennt in
 * der KDS-Konfiguration. Typischer Fehler: die Web-Adresse des Browser-KDS ("192.168.1.5:8080")
 * einzutragen. Das ist keine IP-Adresse (Meldung: getaddrinfo ENOTFOUND) und für Browser-
 * Displays muss das Feld ohnehin leer bleiben.
 */

export function istGueltigeStationsIp(wert: string): boolean {
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(wert.trim())
}

/** Liefert die IP nur, wenn sie gültig ist — sonst null (= Browser-KDS-Betrieb, kein TCP-Versuch). */
export function bereinigeStationsIp(wert: string | undefined | null): string | null {
  const w = wert?.trim()
  return w && istGueltigeStationsIp(w) ? w : null
}
