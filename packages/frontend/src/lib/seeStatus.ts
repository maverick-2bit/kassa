/**
 * SEE-Status (Ausfall der Signaturerstellungseinheit) schnell sichtbar machen.
 *
 * Ein Verkauf ist oft der Moment, in dem die Kassa einen Ausfall erst bemerkt (Stick abgezogen, Brücke weg,
 * A-Trust nicht erreichbar): Der Beleg geht mit Ausfallmarker durch, und die Kassiererin muss das SOFORT sehen —
 * nicht erst beim nächsten Abfragetakt (Test-PC 2026-11-27: der Banner kam bis zu 30 s zu spät). Darum fragt die
 * Kassa den Status nach jeder erfolgreichen Aktion neu ab, und während eines Ausfalls öfter, damit der Banner nach
 * der Wiederherstellung (Sonde, etwa jede Minute) bald verschwindet.
 */

import { MutationCache, type QueryClient } from '@tanstack/react-query'

export const SEE_STATUS_SCHLUESSEL = 'see-status'

/** Abfragetakt: im Ausfall öfter (Wiederherstellung bald sehen), sonst ruhig */
export const SEE_TAKT_NORMAL_MS  = 30_000
export const SEE_TAKT_AUSFALL_MS = 5_000

export function seeAbfrageTakt(ausgefallen: boolean | undefined): number {
  return ausgefallen ? SEE_TAKT_AUSFALL_MS : SEE_TAKT_NORMAL_MS
}

/**
 * MutationCache für den QueryClient: nach jeder erfolgreichen Aktion (Verkauf, Storno, Nullbeleg, …) den
 * SEE-Status neu abfragen. Eine einzige billige Abfrage, und nur, wenn gerade ein Banner auf dem Bildschirm ist.
 */
export function seeStatusNachAktion(holeClient: () => QueryClient): MutationCache {
  return new MutationCache({
    onSuccess: () => {
      void holeClient().invalidateQueries({ queryKey: [SEE_STATUS_SCHLUESSEL] })
    },
  })
}
