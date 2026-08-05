import { describe, it, expect } from 'vitest'
import { bonierFehlschlaege } from './bonierung.js'
import type { BonierungErgebnis } from './bonierung.js'

/**
 * bonierFehlschlaege beantwortet die betrieblich teuerste Frage: ist der
 * Küchenbon angekommen? Backend (HTTP-Status), Kasse und Kellner-App hängen
 * alle daran — die Fälle hier sind die Grundlage dafür.
 */

const leer: BonierungErgebnis = { bonNummer: 'AE1', stationen: [], drucker: [] }

const station = (erfolgreich: boolean, fehler?: string) => ({
  station: 'kueche' as const, ip: '10.0.0.5', positionen: 2, erfolgreich,
  ...(fehler !== undefined && { fehler }),
})

const drucker = (erfolgreich: boolean, istBackup = false, fehler?: string) => ({
  druckerId: '11111111-1111-1111-1111-111111111111',
  name: 'Küchendrucker', ip: '192.168.1.50', positionen: 2, erfolgreich, istBackup,
  ...(fehler !== undefined && { fehler }),
})

describe('bonierFehlschlaege', () => {
  it('meldet nichts, wenn alles zugestellt wurde', () => {
    expect(bonierFehlschlaege(leer)).toEqual([])
    expect(bonierFehlschlaege({
      ...leer, stationen: [station(true)], drucker: [drucker(true)],
    })).toEqual([])
  })

  it('meldet eine nicht erreichte KDS-Station mit lesbarem Label', () => {
    const fehlend = bonierFehlschlaege({
      ...leer, stationen: [station(false, 'ETIMEDOUT')],
    })
    expect(fehlend).toHaveLength(1)
    expect(fehlend[0]!.ziel).toBe('Küche')        // Label, nicht der Enum-Wert
    expect(fehlend[0]!.ip).toBe('10.0.0.5')
    expect(fehlend[0]!.fehler).toBe('ETIMEDOUT')
    expect(fehlend[0]!.istBackup).toBe(false)
  })

  it('meldet auch einen toten Bonierdrucker — der Regressionsfall', () => {
    // Bis v0.7.142 prüfte die Route nur die Stationen: ein toter Drucker in der
    // Küche lieferte 200 und die Kasse zeigte grün.
    const fehlend = bonierFehlschlaege({
      ...leer,
      stationen: [station(true)],
      drucker:   [drucker(false, false, 'ECONNREFUSED')],
    })
    expect(fehlend).toHaveLength(1)
    expect(fehlend[0]!.ziel).toBe('Küchendrucker')
    expect(fehlend[0]!.fehler).toBe('ECONNREFUSED')
  })

  it('kennzeichnet Zweitdrucker, meldet sie aber ebenfalls', () => {
    // Zweitdrucker bekommen eine Kopie ALLER Positionen, nicht erst bei Ausfall
    // des Hauptdruckers — ein stummer Zweitdrucker ist also ein echter Ausfall.
    const fehlend = bonierFehlschlaege({
      ...leer, drucker: [drucker(false, true, 'EHOSTUNREACH')],
    })
    expect(fehlend).toHaveLength(1)
    expect(fehlend[0]!.istBackup).toBe(true)
  })

  it('sammelt mehrere Ausfälle über Stationen und Drucker hinweg', () => {
    const fehlend = bonierFehlschlaege({
      ...leer,
      stationen: [station(false, 'ETIMEDOUT'), { ...station(true), station: 'schank' as const }],
      drucker:   [drucker(false, false, 'ECONNREFUSED'), { ...drucker(true), druckerId: '22222222-2222-2222-2222-222222222222' }],
    })
    expect(fehlend.map(f => f.ziel)).toEqual(['Küche', 'Küchendrucker'])
  })

  it('setzt einen Ersatztext, wenn kein Fehlertext mitkam', () => {
    const fehlend = bonierFehlschlaege({ ...leer, stationen: [station(false)] })
    expect(fehlend[0]!.fehler).toBe('unbekannter Fehler')
  })
})
