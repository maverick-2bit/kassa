const KEY_MANDANT_ID = 'kellner:mandantId'
const KEY_KASSE_ID   = 'kellner:kasseId'

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
