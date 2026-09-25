/**
 * PIN-Länge je Mandant: 4 oder 6 Ziffern, einheitlich für alle Benutzer.
 *
 * Nach einem Wechsel zählen PINs der anderen Länge nicht mehr — die PIN-
 * Prüfungen berücksichtigen nur Benutzer mit users.pinLaenge = Mandanten-Länge.
 * Sonst bliebe ein Rest kurzer PINs ratbar, und genau den will der Wechsel
 * loswerden. Eine Eingabe mit falscher Länge kann keinen PIN treffen; sie wird
 * deshalb ohne bcrypt abgelehnt und zählt auch nicht als Fehlversuch.
 */

import type { FastifyReply } from 'fastify'
import { PIN_LAENGE_CODE, type PinLaenge } from '@kassa/shared'

/** DB-Wert → erlaubte Länge (alles außer 6 ist der Altbestand 4). */
export function alsPinLaenge(n: number | null | undefined): PinLaenge {
  return n === 6 ? 6 : 4
}

/** HTTP 400: die PIN hat nicht die Länge des Betriebs. */
export class PinLaengeError extends Error {
  readonly httpStatus = 400
  readonly code = PIN_LAENGE_CODE
  constructor(public readonly pinLaenge: PinLaenge) {
    super(`PIN muss ${pinLaenge} Ziffern haben`)
    this.name = 'PinLaengeError'
  }
}

/** Wirft PinLaengeError, wenn die PIN nicht genau `pinLaenge` Ziffern hat. */
export function pruefePinLaenge(pin: string, pinLaenge: number): void {
  const laenge = alsPinLaenge(pinLaenge)
  if (pin.length !== laenge || !/^\d+$/.test(pin)) throw new PinLaengeError(laenge)
}

/** Antwort mit der gültigen Länge — die PIN-Felder stellen sich daran selbst richtig ein. */
export function sendePinLaengeFehler(reply: FastifyReply, err: PinLaengeError): FastifyReply {
  return reply.status(err.httpStatus).send({ fehler: err.message, code: err.code, pinLaenge: err.pinLaenge })
}
