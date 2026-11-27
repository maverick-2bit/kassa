/**
 * Fachfehler des Portals: tragen den HTTP-Status und eine Meldung für den Benutzer.
 * Der Fehler-Handler des Servers macht daraus die Antwort; alles andere wird zu 500 ohne Details.
 */

export class PortalFehler extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
    /** Maschinenlesbarer Code, z. B. 'code_erforderlich' */
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'PortalFehler'
  }
}
