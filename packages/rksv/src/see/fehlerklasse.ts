/**
 * Fehlerklassen beim Signieren.
 *
 * Bis v0.8.74 wurde JEDER Fehler in `signiereBeleg` zum automatischen SEE-Ausfall —
 * auch ein falsches A-Trust-Passwort (HTTP 401), eine falsche Adresse (404) oder ein
 * Programmfehler. Die Kasse lief dann still ohne Signatur weiter, der Rückweg war nur
 * von Hand möglich. Hier wird getrennt:
 *
 *  - 'ausfall'        Die Einheit ist nicht erreichbar oder liefert nichts Brauchbares:
 *                     Netz, Timeout, HTTP 5xx / 408 / 425 / 429, unvollständige Antwort,
 *                     Signatur besteht die Gegenprobe nicht. Das ist der Ausfall im Sinn der
 *                     RKSV — Belege laufen weiter, mit dem Ausfallmarker statt einer Signatur,
 *                     und gehen nach Behebung per Wiederinbetriebnahme wieder in Ordnung.
 *
 *  - 'konfiguration'  Die Einheit weist uns ab (HTTP 4xx außer den obigen: Zugangsdaten,
 *                     Benutzer, Adresse) oder unser eigenes Schlüsselmaterial/Programm ist
 *                     kaputt. Das behebt kein Warten: harter Fehler, KEIN Beleg — sonst
 *                     liefe die Kasse wochenlang unsigniert, ohne dass es jemand merkt.
 */

import { SignaturUngueltigError } from '../beleg.js'
import { ATrustHsmError } from './signatur-einheit.js'

export type SeeFehlerKlasse = 'ausfall' | 'konfiguration'

/** HTTP-Status der Gegenstelle, bei denen ein späterer Versuch Erfolg haben kann. */
function istVorlaeufig(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429
}

export function klassifiziereSeeFehler(err: unknown): SeeFehlerKlasse {
  // Frisch erzeugte Signatur passt nicht zum Zertifikat: die Einheit liefert Unbrauchbares
  if (err instanceof SignaturUngueltigError) return 'ausfall'

  if (err instanceof ATrustHsmError) {
    // Ohne Status: Verbindung gescheitert, Timeout oder Antwort ohne das erwartete Feld
    if (err.status === undefined) return 'ausfall'
    return istVorlaeufig(err.status) ? 'ausfall' : 'konfiguration'
  }

  // Alles andere stammt nicht von der Gegenstelle: kaputter Schlüssel, kaputtes Zertifikat,
  // Programmfehler. Verstecken wir hinter einem „Ausfall", merkt es niemand.
  return 'konfiguration'
}
