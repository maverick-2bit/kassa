import { clearAuth } from './auth'

const KEY_MANDANT_ID = 'kellner:mandantId'
const KEY_KASSE_ID   = 'kellner:kasseId'

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface KasseIdentity {
  mandantId: string
  kasseId:   string
}

export function getKasseIdentity(): KasseIdentity | null {
  const mandantId = localStorage.getItem(KEY_MANDANT_ID)
  const kasseId   = localStorage.getItem(KEY_KASSE_ID)
  if (!mandantId || !kasseId) return null
  return { mandantId, kasseId }
}

export function setKasseIdentity(identity: KasseIdentity): void {
  localStorage.setItem(KEY_MANDANT_ID, identity.mandantId)
  localStorage.setItem(KEY_KASSE_ID,   identity.kasseId)
}

export function clearKasseIdentity(): void {
  localStorage.removeItem(KEY_MANDANT_ID)
  localStorage.removeItem(KEY_KASSE_ID)
}

/**
 * Einrichtungs-Link (der QR der Kassa unter Einstellungen → Geräte: …/?mandantId=…) eines ANDEREN
 * Betriebs als dem, dem dieses Handy zugeordnet ist: die alte Zuordnung samt Anmeldung wird
 * verworfen, das Handy richtet sich neu ein. Ohne das blieb ein Handy nach dem Wechsel des Betriebs
 * (Demo-Mandant, neu aufgesetzte Installation) bei der alten Kasse hängen — jede PIN meldete
 * „PIN ungültig", und der neue QR änderte daran nichts.
 * Derselbe Betrieb, kein Link oder eine unbrauchbare mandantId: es passiert nichts.
 *
 * @returns true, wenn die bisherige Zuordnung verworfen wurde
 */
export function uebernimmEinrichtungsLink(search: string): boolean {
  const neu  = new URLSearchParams(search).get('mandantId')
  const alt  = getKasseIdentity()
  if (!neu || !GUID.test(neu) || !alt) return false
  if (alt.mandantId.toLowerCase() === neu.toLowerCase()) return false
  clearKasseIdentity()
  clearAuth()
  return true
}
