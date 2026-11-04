import type { RechnungMandantInfo } from '@kassa/shared'
import { mandantApi } from './api'

/**
 * Mandanten-Angaben für die A4-Rechnung: Name + UID aus der Anmeldung, dazu Anschrift (Kopftext) und
 * Zahlungsangaben aus den Einstellungen. Fehlen die Einstellungen (Netz/Rechte), druckt die Rechnung
 * trotzdem — nur ohne Zahlungsblock.
 */
export async function ladeRechnungMandant(mandant: { firmenname: string; uid: string }): Promise<RechnungMandantInfo> {
  try {
    const s = await mandantApi.getStammdaten()
    return {
      firmenname:       mandant.firmenname,
      uid:              mandant.uid,
      kopftext:         s.belegKopftext,
      iban:             s.rechnungIban,
      bic:              s.rechnungBic,
      zahlungszielTage: s.rechnungZahlungszielTage,
    }
  } catch {
    return { firmenname: mandant.firmenname, uid: mandant.uid }
  }
}
