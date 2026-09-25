/**
 * korrekturbonFehler: Aus der Storno-Antwort (Position korrigiert oder Tisch
 * verworfen) wird die Nachsendung für die rote Leiste.
 * Anlass: Beim Verwerfen verschwand ein nicht zugestellter Korrekturbon — die
 * Station bereitete den ganzen Tisch weiter zu, und niemand erfuhr es.
 */

import { describe, it, expect } from 'vitest'
import type { TabPositionenAntwort } from '../lib/api'
import { korrekturbonFehler } from './BonierFehlerLeiste'

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
