import { describe, it, expect } from 'vitest'
import { BonierungErgebnisSchema, bonRueckmeldung, bonierFehlschlaege, bonierUmleitungen, vereinigeUmleitungen } from './bonierung.js'
import type { BonierungErgebnis, BonierungInput } from './bonierung.js'

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

/**
 * bonierUmleitungen ist das Gegenstück: der Bon ist zugestellt (kein Fehlschlag),
 * liegt aber am Backup-Drucker statt am vorgesehenen Gerät. So wie der Server ihn
 * meldet: erfolgreich, Name „A → B“, IP von B, Hinweis in `fehler`.
 */
const umgeleitet = (von = 'Küchendrucker', an = 'Schankdrucker', ip = '192.168.1.51') => ({
  druckerId: '33333333-3333-3333-3333-333333333333',
  name: `${von} → ${an}`, ip, positionen: 2, erfolgreich: true, istBackup: false,
  fehler: `${von} nicht erreichbar — Bon wurde an ${an} umgeleitet`,
  umleitung: { von, an },
})

describe('bonierUmleitungen', () => {
  it('meldet nichts, wenn jeder Bon am vorgesehenen Drucker liegt', () => {
    expect(bonierUmleitungen(leer)).toEqual([])
    expect(bonierUmleitungen({
      ...leer, stationen: [station(true)], drucker: [drucker(true)],
    })).toEqual([])
  })

  it('meldet einen Bon, der am Backup-Drucker statt am vorgesehenen Drucker liegt', () => {
    const ergebnis = { ...leer, drucker: [umgeleitet()] }
    expect(bonierUmleitungen(ergebnis)).toEqual([{
      von:     'Küchendrucker',
      an:      'Schankdrucker',
      ip:      '192.168.1.51',      // die IP des Druckers, an dem der Bon liegt
      hinweis: 'Küchendrucker nicht erreichbar — Bon kam an Schankdrucker. Bitte weitergeben.',
    }])
    // Zugestellt ist zugestellt: das ist KEIN Fehlschlag (kein 207, keine rote Leiste)
    expect(bonierFehlschlaege(ergebnis)).toEqual([])
  })

  it('zählt reine Fehlschläge nicht — dafür ist bonierFehlschlaege da', () => {
    const ergebnis = {
      ...leer,
      stationen: [station(false, 'ETIMEDOUT')],
      drucker:   [drucker(false, false, 'ECONNREFUSED')],
    }
    expect(bonierUmleitungen(ergebnis)).toEqual([])
    expect(bonierFehlschlaege(ergebnis)).toHaveLength(2)
    // auch dann nicht, wenn ein gescheiterter Eintrag eine Umleitung trüge (der Server setzt sie nur bei Erfolg)
    expect(bonierUmleitungen({ ...leer, drucker: [{ ...umgeleitet(), erfolgreich: false }] })).toEqual([])
  })

  it('zählt Zweitdrucker-Kopien nicht — weder zugestellte noch gescheiterte', () => {
    // Der Zweitdrucker bekommt IMMER eine Kopie und wird nie ersetzt: keine Umleitung
    expect(bonierUmleitungen({
      ...leer, drucker: [drucker(true, true), drucker(false, true, 'EHOSTUNREACH')],
    })).toEqual([])
    // und eine Kopie gilt auch dann nicht, wenn sie (fälschlich) eine Umleitung trüge
    expect(bonierUmleitungen({ ...leer, drucker: [{ ...umgeleitet(), istBackup: true }] })).toEqual([])
  })

  it('meldet die Umleitung des Hauptdruckers, auch wenn daneben ein Zweitdrucker eine Kopie bekam', () => {
    const umleitungen = bonierUmleitungen({
      ...leer, drucker: [umgeleitet(), { ...drucker(true, true), druckerId: '44444444-4444-4444-4444-444444444444' }],
    })
    expect(umleitungen.map(u => u.von)).toEqual(['Küchendrucker'])
  })

  it('führt mehrere Umleitungen einzeln auf, auch wenn beide am selben Ersatz landen', () => {
    const umleitungen = bonierUmleitungen({
      ...leer,
      drucker: [
        umgeleitet('Küchendrucker', 'Schankdrucker'),
        { ...umgeleitet('Grill', 'Schankdrucker'), druckerId: '55555555-5555-5555-5555-555555555555' },
      ],
    })
    expect(umleitungen.map(u => u.hinweis)).toEqual([
      'Küchendrucker nicht erreichbar — Bon kam an Schankdrucker. Bitte weitergeben.',
      'Grill nicht erreichbar — Bon kam an Schankdrucker. Bitte weitergeben.',
    ])
  })

  it('berichtet Umleitung und Fehlschlag desselben Bons nebeneinander', () => {
    // Küchendrucker wich auf den Schank aus, die KDS-Station Küche blieb stumm
    const ergebnis = { ...leer, stationen: [station(false, 'ETIMEDOUT')], drucker: [umgeleitet()] }
    expect(bonierUmleitungen(ergebnis)).toHaveLength(1)
    expect(bonierFehlschlaege(ergebnis).map(f => f.ziel)).toEqual(['Küche'])
  })
})

describe('vereinigeUmleitungen', () => {
  const kueche = bonierUmleitungen({ ...leer, drucker: [umgeleitet('Küchendrucker', 'Schankdrucker')] })
  const grill  = bonierUmleitungen({ ...leer, drucker: [umgeleitet('Grill', 'Schankdrucker')] })

  it('hängt Neues an, ohne das schon Angezeigte zu verlieren', () => {
    expect(vereinigeUmleitungen(kueche, grill).map(u => u.von)).toEqual(['Küchendrucker', 'Grill'])
  })

  it('führt denselben Hinweis nur einmal auf (dritter Bon bei weiter defektem Drucker)', () => {
    expect(vereinigeUmleitungen(kueche, kueche)).toEqual(kueche)
    expect(vereinigeUmleitungen([], [...kueche, ...kueche])).toEqual(kueche)
  })

  it('ein Bon ohne Umleitung nimmt den Hinweis nicht weg — erst „Verstanden“ tut das', () => {
    expect(vereinigeUmleitungen(kueche, [])).toBe(kueche)
  })
})

/**
 * bonRueckmeldung: Was ein Tisch-Vorgang (Gang abrufen, Position nachschicken) dem Personal meldet. Nur wenn es
 * etwas zu melden gibt — sonst bleibt die Antwort des Vorgangs wie vor diesem Feld.
 */
describe('bonRueckmeldung', () => {
  const nachsenden: BonierungInput = {
    kasseId:    '11111111-1111-4111-8111-111111111111',
    tabId:      '22222222-2222-4222-8222-222222222222',
    tisch:      'T5 · 2. Gang',
    kellner:    'Kellner Karl',
    positionen: [{ artikelId: '33333333-3333-4333-8333-333333333333', menge: 2, gang: 2 }],
    ohneLagerabzug: true,
    bestellId:  '44444444-4444-4444-8444-444444444444',
  }

  it('alles am vorgesehenen Gerät angekommen (oder nichts zu bonieren) → keine Rückmeldung', () => {
    expect(bonRueckmeldung(null, nachsenden)).toBeNull()
    expect(bonRueckmeldung(leer, nachsenden)).toBeNull()
    expect(bonRueckmeldung({ ...leer, stationen: [station(true)], drucker: [drucker(true)] }, nachsenden)).toBeNull()
  })

  it('Fehlschlag → Ziele samt der Bonierung zum Nachsenden (mit der Bestell-ID des ersten Versuchs)', () => {
    const r = bonRueckmeldung({ ...leer, drucker: [drucker(false, false, 'ECONNREFUSED')] }, nachsenden)
    expect(r?.fehler.map(f => f.ziel)).toEqual(['Küchendrucker'])
    expect(r?.umleitungen).toEqual([])
    expect(r?.nachsenden).toBe(nachsenden)
    expect(r?.nachsenden.bestellId).toBe('44444444-4444-4444-8444-444444444444')
  })

  it('Umleitung auf den Backup-Drucker → Hinweis ohne Fehlschlag', () => {
    const r = bonRueckmeldung({ ...leer, drucker: [umgeleitet()] }, nachsenden)
    expect(r?.fehler).toEqual([])
    expect(r?.umleitungen.map(u => u.hinweis)).toEqual([
      'Küchendrucker nicht erreichbar — Bon kam an Schankdrucker. Bitte weitergeben.',
    ])
  })

  it('beides nebeneinander: ein Drucker wich aus, ein anderes Ziel blieb stumm', () => {
    const r = bonRueckmeldung({ ...leer, stationen: [station(false, 'ETIMEDOUT')], drucker: [umgeleitet()] }, nachsenden)
    expect(r?.fehler.map(f => f.ziel)).toEqual(['Küche'])
    expect(r?.umleitungen).toHaveLength(1)
  })

  it('Zweitdrucker-Kopie am Backup-Drucker zählt nicht als Umleitung → keine Rückmeldung', () => {
    expect(bonRueckmeldung({ ...leer, drucker: [drucker(true, true)] }, nachsenden)).toBeNull()
  })
})

describe('BonierungErgebnisSchema: Umleitung', () => {
  // Wiederholt der Kellner eine Bestellung („Nochmal senden“), liest der Server das gespeicherte
  // Ergebnis der ersten Runde durch dieses Schema — ein Feld, das es nicht kennt, ginge dabei still verloren.
  it('behält die Umleitung beim Lesen (sonst verschwindet der Hinweis bei „Nochmal senden“)', () => {
    const gelesen = BonierungErgebnisSchema.parse({ ...leer, drucker: [umgeleitet()] })
    expect(bonierUmleitungen(gelesen)).toHaveLength(1)
  })

  it('liest auch Ergebnisse ohne Umleitung (Bestand vor diesem Feld)', () => {
    const gelesen = BonierungErgebnisSchema.parse({ ...leer, drucker: [drucker(true)] })
    expect(gelesen.drucker[0]!.umleitung).toBeUndefined()
    expect(bonierUmleitungen(gelesen)).toEqual([])
  })
})
