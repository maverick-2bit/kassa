/**
 * Stub-FinanzOnline-Client für lokale Entwicklung und E2E-Tests.
 *
 * Ersetzt die echten FinanzOnline-SOAP-Aufrufe durch sofort erfolgreiche
 * Antworten, damit eine Kasse lokal eingerichtet werden kann, OHNE echte
 * FinanzOnline-Testzugangsdaten zu besitzen.
 *
 * ⚠️ NIEMALS in Produktion verwenden — eine gestubte Registrierung ist KEINE
 * gültige RKSV-Anmeldung bei der Finanzbehörde. Die Aktivierung ist in
 * index.ts hart auf NODE_ENV !== 'production' begrenzt.
 */

import type { FinanzOnlineClient } from '@kassa/rksv'

export function erstelleStubFinanzOnlineClient(): FinanzOnlineClient {
  const ok = (pruefwert?: string) => Promise.resolve({ erfolgreich: true, ...(pruefwert && { pruefwert }) })
  return {
    kasseInBetriebNehmen:          () => ok(),
    startbelegPruefen:             () => ok('STUB-PRUEFWERT'),
    kasseAusserBetriebNehmen:      () => ok(),
    seeAusfallMelden:              () => ok(),
    seeWiederinbetriebnahmeMelden: () => ok(),
  } as unknown as FinanzOnlineClient
}
