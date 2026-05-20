/**
 * Tests für die automatische Kasseneinrichtung
 *
 * FinanzOnlineClient wird gemockt, da sonst echte HTTP-Aufrufe gegen die
 * BMF-Server gemacht würden.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  kasseAutomatischEinrichten,
  validiereKasseEinrichtenInput,
  type KasseEinrichtenInput,
  type EinrichtungsSchritt,
} from '../src/setup.js'
import { FinanzOnlineClient } from '../src/finanz-online.js'

// ---------------------------------------------------------------------------
// Test-Hilfen
// ---------------------------------------------------------------------------

function validerInput(overrides: Partial<KasseEinrichtenInput> = {}): KasseEinrichtenInput {
  return {
    firmenname:  'Test Restaurant GmbH',
    uid:         'ATU12345678',
    kassenId:    'TEST-KASSE-001',
    finanzOnline: {
      teilnehmerId:    'TID-123456',
      benutzerkennung: 'BID-99999',
      pin:             'SECRET',
    },
    umgebung: 'test',
    ...overrides,
  }
}

function mockClient(opts: {
  registrierungErfolg?: boolean
  registrierungFehler?: string
  pruefungErfolg?: boolean
  pruefwert?: string
  pruefungFehler?: string
  registrierungWirft?: Error
  pruefungWirft?: Error
} = {}): FinanzOnlineClient {
  return {
    kasseInBetriebNehmen: vi.fn().mockImplementation(async () => {
      if (opts.registrierungWirft) throw opts.registrierungWirft
      return {
        erfolgreich: opts.registrierungErfolg ?? true,
        ...(opts.registrierungFehler && { fehler: opts.registrierungFehler }),
      }
    }),
    startbelegPruefen: vi.fn().mockImplementation(async () => {
      if (opts.pruefungWirft) throw opts.pruefungWirft
      return {
        erfolgreich: opts.pruefungErfolg ?? true,
        ...(opts.pruefwert && { pruefwert: opts.pruefwert }),
        ...(opts.pruefungFehler && { fehler: opts.pruefungFehler }),
      }
    }),
    kasseAusserBetriebNehmen: vi.fn(),
  } as unknown as FinanzOnlineClient
}

// ---------------------------------------------------------------------------
// Eingabevalidierung
// ---------------------------------------------------------------------------

describe('validiereKasseEinrichtenInput', () => {
  it('akzeptiert valide Eingabe', () => {
    expect(validiereKasseEinrichtenInput(validerInput())).toEqual([])
  })

  it('lehnt fehlenden Firmennamen ab', () => {
    const fehler = validiereKasseEinrichtenInput(validerInput({ firmenname: '' }))
    expect(fehler).toContain('Firmenname ist erforderlich')
  })

  it('lehnt ungültige UID ab', () => {
    const fehler = validiereKasseEinrichtenInput(validerInput({ uid: 'ATU123' }))
    expect(fehler.some(f => f.includes('UID ungültig'))).toBe(true)
  })

  it('lehnt UID mit falschem Präfix ab', () => {
    const fehler = validiereKasseEinrichtenInput(validerInput({ uid: 'DE12345678' }))
    expect(fehler.some(f => f.includes('UID ungültig'))).toBe(true)
  })

  it('lehnt fehlende Kassen-ID ab', () => {
    const fehler = validiereKasseEinrichtenInput(validerInput({ kassenId: '   ' }))
    expect(fehler).toContain('Kassen-ID ist erforderlich')
  })

  it('lehnt fehlende FinanzOnline-Daten ab', () => {
    const fehler = validiereKasseEinrichtenInput(validerInput({
      finanzOnline: { teilnehmerId: '', benutzerkennung: '', pin: '' },
    }))
    expect(fehler.some(f => f.includes('Teilnehmer-ID'))).toBe(true)
    expect(fehler.some(f => f.includes('Benutzerkennung'))).toBe(true)
    expect(fehler.some(f => f.includes('PIN'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Vollständiger Workflow (Happy Path)
// ---------------------------------------------------------------------------

describe('kasseAutomatischEinrichten – Happy Path', () => {
  it('führt alle 5 Schritte erfolgreich durch', async () => {
    const client = mockClient({ pruefwert: 'PW-ABC-123' })
    const schritte: EinrichtungsSchritt[] = []

    const ergebnis = await kasseAutomatischEinrichten(validerInput(), {
      finanzOnlineClient: client,
      onSchritt: (s) => schritte.push(s),
    })

    expect(ergebnis.erfolgreich).toBe(true)
    expect(ergebnis.see).toBeDefined()
    expect(ergebnis.startbeleg).toBeDefined()
    expect(ergebnis.pruefwert).toBe('PW-ABC-123')
    expect(ergebnis.letzterSignaturwert).toBeTruthy()
    expect(ergebnis.fehler).toBeUndefined()

    // Schritte: jeweils startet + erfolgreich = 10 Einträge
    const erfolgsschritte = schritte.filter(s => s.status === 'erfolgreich')
    expect(erfolgsschritte).toHaveLength(5)
  })

  it('ruft onSchritt-Callback für jeden Schritt auf', async () => {
    const client = mockClient()
    const callback = vi.fn()

    await kasseAutomatischEinrichten(validerInput(), {
      finanzOnlineClient: client,
      onSchritt: callback,
    })

    // 5 Schritte × 2 (startet + erfolgreich) = 10 Aufrufe
    expect(callback).toHaveBeenCalledTimes(10)
  })

  it('Startbeleg hat Belegnummer 1 und korrekten Typ', async () => {
    const client = mockClient()
    const ergebnis = await kasseAutomatischEinrichten(validerInput(), { finanzOnlineClient: client })

    expect(ergebnis.startbeleg?.belegTyp).toBe('Startbeleg')
    expect(ergebnis.startbeleg?.belegNummer).toBe(1)
    expect(ergebnis.startbeleg?.maschinenlesbareCode).toMatch(/^_R1-AT_/)
  })

  it('ruft FinanzOnline-Client mit korrekten Daten auf', async () => {
    const client = mockClient()
    const input  = validerInput()

    await kasseAutomatischEinrichten(input, { finanzOnlineClient: client })

    expect(client.kasseInBetriebNehmen).toHaveBeenCalledWith(
      expect.objectContaining({
        kassenId:    input.kassenId,
        uid:         input.uid,
        credentials: input.finanzOnline,
      }),
    )
    expect(client.startbelegPruefen).toHaveBeenCalledWith(
      expect.objectContaining({ belegTyp: 'Startbeleg' }),
      input.finanzOnline,
    )
  })
})

// ---------------------------------------------------------------------------
// Fehler-Szenarien
// ---------------------------------------------------------------------------

describe('kasseAutomatischEinrichten – Fehlerbehandlung', () => {
  it('bricht bei ungültiger Eingabe sofort ab', async () => {
    const client  = mockClient()
    const ergebnis = await kasseAutomatischEinrichten(
      validerInput({ uid: 'ungueltig' }),
      { finanzOnlineClient: client },
    )

    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('UID ungültig')
    expect(client.kasseInBetriebNehmen).not.toHaveBeenCalled()
  })

  it('bricht bei fehlgeschlagener FinanzOnline-Registrierung ab', async () => {
    const client = mockClient({
      registrierungErfolg: false,
      registrierungFehler: 'TID ungültig (Code 042)',
    })

    const ergebnis = await kasseAutomatischEinrichten(validerInput(), {
      finanzOnlineClient: client,
    })

    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('TID ungültig')
    expect(ergebnis.see).toBeDefined() // SEE wurde vorher generiert
    expect(client.startbelegPruefen).not.toHaveBeenCalled()
  })

  it('behandelt Exception aus FinanzOnline-Client', async () => {
    const client = mockClient({
      registrierungWirft: new Error('Netzwerkfehler: ECONNREFUSED'),
    })

    const ergebnis = await kasseAutomatischEinrichten(validerInput(), {
      finanzOnlineClient: client,
    })

    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('Netzwerkfehler')
  })

  it('bricht bei fehlgeschlagener Startbeleg-Prüfung ab', async () => {
    const client = mockClient({
      pruefungErfolg: false,
      pruefungFehler: 'Signatur konnte nicht verifiziert werden',
    })

    const ergebnis = await kasseAutomatischEinrichten(validerInput(), {
      finanzOnlineClient: client,
    })

    expect(ergebnis.erfolgreich).toBe(false)
    expect(ergebnis.fehler).toContain('Signatur')
    expect(ergebnis.startbeleg).toBeDefined() // Startbeleg wurde erstellt
  })

  it('protokolliert fehlgeschlagene Schritte', async () => {
    const client   = mockClient({ registrierungErfolg: false, registrierungFehler: 'Test' })
    const schritte: EinrichtungsSchritt[] = []

    await kasseAutomatischEinrichten(validerInput(), {
      finanzOnlineClient: client,
      onSchritt: (s) => schritte.push(s),
    })

    const fehlerSchritte = schritte.filter(s => s.status === 'fehler')
    expect(fehlerSchritte).toHaveLength(1)
    expect(fehlerSchritte[0]?.schritt).toBe('finanzonline-registrierung')
  })
})
