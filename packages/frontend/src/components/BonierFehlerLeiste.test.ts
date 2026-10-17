/**
 * korrekturbonFehler: Aus der Storno-Antwort (Position korrigiert oder Tisch
 * verworfen) wird die Nachsendung für die rote Leiste.
 * Anlass: Beim Verwerfen verschwand ein nicht zugestellter Korrekturbon — die
 * Station bereitete den ganzen Tisch weiter zu, und niemand erfuhr es.
 */

import { describe, it, expect } from 'vitest'
import type { BonRueckmeldung } from '@kassa/shared'
import type { TabPositionenAntwort } from '../lib/api'
import { korrekturbonFehler, rueckmeldungFehler } from './BonierFehlerLeiste'

const KASSE_ID   = '11111111-1111-4111-8111-111111111111'
const TAB_ID     = '22222222-2222-4222-8222-222222222222'
const ARTIKEL_ID = '33333333-3333-4333-8333-333333333333'

const antwort: TabPositionenAntwort = {
  id:              TAB_ID,
  kasseId:         KASSE_ID,
  tischNummer:     'T5',
  kellner:         'Kellner Karl',
  positionen:      [{ artikelId: ARTIKEL_ID, bezeichnung: 'Schnitzel', preisBruttoCent: 1450, menge: 3 }],
  status:          'offen',
  summeGesamtCent: 4350,
  geoffnetAm:      '2026-09-25T18:00:00.000Z',
  createdAt:       '2026-09-25T18:00:00.000Z',
  updatedAt:       '2026-09-25T18:30:00.000Z',
}

const stornoBon: NonNullable<TabPositionenAntwort['stornoBon']> = {
  fehler:     [{ ziel: 'Küche', ip: '192.168.192.50', fehler: 'connect ECONNREFUSED', istBackup: false }],
  positionen: [{ artikelId: ARTIKEL_ID, menge: 3 }],
}

describe('korrekturbonFehler', () => {
  it('Korrekturbon zugestellt (kein stornoBon) → keine Leiste', () => {
    expect(korrekturbonFehler(antwort, TAB_ID)).toBeNull()
  })

  it('nicht zugestellt → Storno-Bon ohne Lagerabzug zum Nachsenden', () => {
    expect(korrekturbonFehler({ ...antwort, stornoBon }, TAB_ID)).toEqual({
      ziele: stornoBon.fehler,
      nachsenden: {
        kasseId:        KASSE_ID,
        tabId:          TAB_ID,
        tisch:          'T5',
        kellner:        'Kellner Karl',
        positionen:     [{ artikelId: ARTIKEL_ID, menge: 3 }],
        ohneLagerabzug: true,
        storno:         true,
      },
    })
  })

  it('Verwerfen: ohne tabId — Nachsenden braucht den geschlossenen Tab nicht', () => {
    const fehler = korrekturbonFehler({ ...antwort, stornoBon })
    expect(fehler?.nachsenden).not.toHaveProperty('tabId')
    expect(fehler?.nachsenden).toMatchObject({ kasseId: KASSE_ID, tisch: 'T5', storno: true })
  })
})

describe('korrekturbonFehler: Umleitung ist kein Fehlschlag', () => {
  it('Korrekturbon am Backup-Drucker (nur stornoUmleitungen) → keine rote Leiste', () => {
    const umgeleitet: TabPositionenAntwort = {
      ...antwort,
      stornoUmleitungen: [{ von: 'Küchendrucker', an: 'Schankdrucker', ip: '192.168.1.51', hinweis: 'Küchendrucker nicht erreichbar — Bon kam an Schankdrucker. Bitte weitergeben.' }],
    }
    expect(korrekturbonFehler(umgeleitet, TAB_ID)).toBeNull()
  })

  it('beides: der Fehlschlag bleibt eine Leiste, die Umleitung ändert sie nicht', () => {
    const beides: TabPositionenAntwort = {
      ...antwort,
      stornoBon,
      stornoUmleitungen: [{ von: 'Grill', an: 'Schankdrucker', ip: '192.168.1.51', hinweis: 'Grill nicht erreichbar — Bon kam an Schankdrucker. Bitte weitergeben.' }],
    }
    expect(korrekturbonFehler(beides, TAB_ID)?.ziele).toEqual(stornoBon.fehler)
  })
})

/**
 * rueckmeldungFehler: Gang abrufen und Position nachschicken boniert der Server selbst; seine Rückmeldung (`bon`)
 * wird zur roten Leiste — mit der fertigen Bonierung (Bestell-ID!) für „Nochmal senden“.
 */
describe('rueckmeldungFehler', () => {
  const nachsenden = {
    kasseId:    KASSE_ID,
    tabId:      TAB_ID,
    tisch:      'T5 · 2. Gang',
    kellner:    'Kellner Karl',
    positionen: [{ artikelId: ARTIKEL_ID, menge: 3, gang: 2 }],
    ohneLagerabzug: true,
    bestellId:  '44444444-4444-4444-8444-444444444444',
  }
  const bon: BonRueckmeldung = {
    fehler:      [{ ziel: 'Küche', ip: '192.168.192.50', fehler: 'connect ECONNREFUSED', istBackup: false }],
    umleitungen: [],
    nachsenden,
  }

  it('Bon nicht angekommen → rote Leiste mit der Nachsende-Bonierung des Servers (samt Bestell-ID)', () => {
    expect(rueckmeldungFehler(bon)).toEqual({ ziele: bon.fehler, nachsenden })
    expect(rueckmeldungFehler(bon)?.nachsenden.bestellId).toBe('44444444-4444-4444-8444-444444444444')
  })

  it('keine Rückmeldung (alles angekommen) → keine Leiste', () => {
    expect(rueckmeldungFehler(undefined)).toBeNull()
    expect(rueckmeldungFehler(null)).toBeNull()
  })

  it('nur Umleitung (kein Fehlschlag) → keine rote Leiste, der bernsteinfarbene Hinweis kommt aus `umleitungen`', () => {
    expect(rueckmeldungFehler({ ...bon, fehler: [], umleitungen: [{ von: 'Küche', an: 'Schank', ip: '1.2.3.4', hinweis: 'x' }] })).toBeNull()
  })
})
