/**
 * Neue UUID v4 für Geräte (Kasse, Kellner-App). `crypto.randomUUID` gibt es nur in
 * sicheren Kontexten (HTTPS/localhost) — Kellnerhandys greifen aber oft per http://<LAN-IP>
 * auf die Kasse zu. `crypto.getRandomValues` steht überall zur Verfügung.
 */
/** Der Teil der Web-Crypto-API, den wir brauchen (das Paket kompiliert ohne DOM-Typen). */
interface WebCrypto {
  randomUUID?:      () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

export function neueUuid(): string {
  const c = (globalThis as { crypto?: WebCrypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6]! & 0x0f) | 0x40   // Version 4
  b[8] = (b[8]! & 0x3f) | 0x80   // Variante RFC 4122
  const h = [...b].map(x => x.toString(16).padStart(2, '0'))
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`
}
