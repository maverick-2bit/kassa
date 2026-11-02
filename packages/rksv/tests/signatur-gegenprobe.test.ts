/**
 * Gegenprobe nach dem Signieren + Fehlerklassen.
 *
 * Bis v0.8.74 prüfte niemand die frische Signatur: Lieferte die Signatureinheit Unsinn
 * (64 beliebige Bytes, ein anderer Schlüssel als im gespeicherten Zertifikat), wurde der Beleg
 * gespeichert, gedruckt und fiel erst bei der Finanzprüfung auf. `signiereBeleg` verifiziert
 * jetzt jede frische Signatur gegen das Zertifikat der Kasse und wirft `SignaturUngueltigError`.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { generateSEE } from '../src/see.js'
import {
  erstelleStartbeleg,
  signiereBeleg,
  SignaturUngueltigError,
  Umsatzzaehler,
  verifiziereQrCode,
  type BelegSignaturEinheit,
  type SignierungsKontext,
} from '../src/beleg.js'
import { ATrustHsmError } from '../src/see/signatur-einheit.js'
import { klassifiziereSeeFehler } from '../src/see/fehlerklasse.js'
import type { RawBeleg, SEEConfig } from '../src/types.js'

let see: SEEConfig
let fremd: SEEConfig

beforeAll(async () => {
  see   = await generateSEE({ kassenId: 'GP-KASSE-1', uid: 'ATU12345678', firmenname: 'Gegenprobe GmbH' })
  fremd = await generateSEE({ kassenId: 'GP-KASSE-1', uid: 'ATU12345678', firmenname: 'Fremder Schlüssel GmbH' })
})

const raw = (belegNummer = 2): RawBeleg => ({
  kassenId: 'GP-KASSE-1', belegNummer, datumUhrzeit: new Date('2026-07-01T10:00:00Z'), belegTyp: 'Barzahlungsbeleg',
  positionen: [{ bezeichnung: 'Kaffee', menge: 1, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' }],
})

async function kontextMit(einheit?: BelegSignaturEinheit): Promise<SignierungsKontext> {
  const { kontext } = await erstelleStartbeleg('GP-KASSE-1', see)
  return { ...kontext, ...(einheit && { einheit }) }
}

describe('Gegenprobe der frischen Signatur', () => {
  it('eine Einheit, die 64 beliebige Bytes liefert, wird abgelehnt — der Zähler steht wieder auf dem alten Stand', async () => {
    const kontext = await kontextMit({ signiereBelegzeile: async () => randomBytes(64) })
    const vorher = kontext.umsatzzaehler.aktuell
    await expect(signiereBeleg(raw(), kontext)).rejects.toBeInstanceOf(SignaturUngueltigError)
    expect(kontext.umsatzzaehler.aktuell).toBe(vorher)
  })

  it('eine Einheit mit einem anderen Schlüssel als im Zertifikat der Kasse wird abgelehnt', async () => {
    const kontext = await kontextMit({
      signiereBelegzeile: async (code) => {
        const { signiereRoh } = await import('../src/see.js')
        const { jwsSigningInput } = await import('../src/beleg.js')
        return signiereRoh(jwsSigningInput(code), fremd)
      },
    })
    await expect(signiereBeleg(raw(), kontext)).rejects.toBeInstanceOf(SignaturUngueltigError)
  })

  it('eine Signatur der falschen Länge (kein P1363) wird abgelehnt', async () => {
    const kontext = await kontextMit({ signiereBelegzeile: async () => randomBytes(70) })
    await expect(signiereBeleg(raw(), kontext)).rejects.toBeInstanceOf(SignaturUngueltigError)
  })

  it('der Zähler bleibt auch bei einem Fehler VOR dem Signieren unverändert (kaputter Schlüssel)', async () => {
    const { kontext } = await erstelleStartbeleg('GP-KASSE-1', see)
    const kaputt: SignierungsKontext = { ...kontext, see: { ...see, privateKeyDER: Buffer.from('kein Schlüssel') } }
    const vorher = kaputt.umsatzzaehler.aktuell
    await expect(signiereBeleg(raw(), kaputt)).rejects.toThrow()
    expect(kaputt.umsatzzaehler.aktuell).toBe(vorher)
  })

  it('der Normalfall ist unberührt: Beleg signiert, Zähler gebucht, Code verifiziert', async () => {
    const kontext = await kontextMit()
    const beleg = await signiereBeleg(raw(), kontext)
    expect(verifiziereQrCode(beleg.maschinenlesbareCode, see.zertifikatDER)).toBe(true)
    expect(kontext.umsatzzaehler.aktuell).toBe(350n)
  })

  it('Ausfallbelege tragen den Marker und werden nicht gegengeprüft', async () => {
    const kontext = await kontextMit({ signiereBelegzeile: async () => randomBytes(64) })
    const beleg = await signiereBeleg(raw(), kontext, { ausfallModus: true })
    expect(beleg.ausgefallen).toBe(true)
    expect(kontext.umsatzzaehler.aktuell).toBe(350n)     // der Umsatz zählt auch im Ausfall
  })

  it('ein Umsatzzähler-Objekt, das der Aufrufer mitführt, bleibt nach einem Fehler benutzbar', async () => {
    const zaehler = new Umsatzzaehler(1000n)
    const kontext: SignierungsKontext = {
      see, umsatzzaehler: zaehler, einheit: { signiereBelegzeile: async () => randomBytes(64) },
    }
    await expect(signiereBeleg(raw(), kontext)).rejects.toBeInstanceOf(SignaturUngueltigError)
    expect(zaehler.aktuell).toBe(1000n)
  })
})

describe('klassifiziereSeeFehler', () => {
  it('Netz, Timeout und unbrauchbare Antwort (kein HTTP-Status) sind ein Ausfall', () => {
    expect(klassifiziereSeeFehler(new ATrustHsmError('A-Trust /Sign/JWS nicht erreichbar: Timeout nach 2500 ms'))).toBe('ausfall')
    expect(klassifiziereSeeFehler(new ATrustHsmError('A-Trust /Sign/JWS: Feld "result" fehlt in der Antwort'))).toBe('ausfall')
  })

  it.each([500, 502, 503, 504, 408, 425, 429])('HTTP %i ist ein Ausfall (vorübergehend)', (status) => {
    expect(klassifiziereSeeFehler(new ATrustHsmError('x', status))).toBe('ausfall')
  })

  it.each([400, 401, 403, 404, 405, 409, 422])('HTTP %i ist ein harter Fehler (Zugangsdaten/Adresse/Konfiguration)', (status) => {
    expect(klassifiziereSeeFehler(new ATrustHsmError('x', status))).toBe('konfiguration')
  })

  it('eine Signatur, die die Gegenprobe nicht besteht, ist ein Ausfall (die Einheit liefert Unbrauchbares)', () => {
    expect(klassifiziereSeeFehler(new SignaturUngueltigError('x'))).toBe('ausfall')
  })

  it('alles andere — kaputter Schlüssel, Programmfehler — ist ein harter Fehler und wird nicht als Ausfall versteckt', () => {
    expect(klassifiziereSeeFehler(new Error('error:1E08010C:DECODER routines::unsupported'))).toBe('konfiguration')
    expect(klassifiziereSeeFehler(new TypeError('Cannot read properties of undefined'))).toBe('konfiguration')
    expect(klassifiziereSeeFehler('Text statt Fehler')).toBe('konfiguration')
    expect(klassifiziereSeeFehler(undefined)).toBe('konfiguration')
  })
})
