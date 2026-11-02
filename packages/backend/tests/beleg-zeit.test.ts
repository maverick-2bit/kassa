/**
 * Zeitstempel eines neuen Belegs: nie vor dem Vorbeleg (Uhr-Plausibilisierung).
 */

import { describe, expect, it } from 'vitest'
import { bestimmeBelegZeit, UHR_TOLERANZ_MS } from '../src/services/beleg-zeit.js'

const t = (iso: string): Date => new Date(iso)

describe('bestimmeBelegZeit', () => {
  it('ohne Vorbeleg gilt die aktuelle Zeit', () => {
    const jetzt = t('2026-07-01T10:00:00Z')
    expect(bestimmeBelegZeit(jetzt, undefined)).toEqual({ ok: true, zeit: jetzt, angeglichenUmMs: 0 })
    expect(bestimmeBelegZeit(jetzt, null)).toEqual({ ok: true, zeit: jetzt, angeglichenUmMs: 0 })
  })

  it('läuft die Uhr normal, gilt die aktuelle Zeit (auch bei gleicher Sekunde)', () => {
    const jetzt = t('2026-07-01T10:00:05.000Z')
    expect(bestimmeBelegZeit(jetzt, t('2026-07-01T10:00:00Z'))).toMatchObject({ ok: true, angeglichenUmMs: 0 })
    expect(bestimmeBelegZeit(jetzt, jetzt)).toMatchObject({ ok: true, angeglichenUmMs: 0 })
  })

  it('kleiner Rücksprung (bis zur Toleranz): der Beleg bekommt die Zeit des Vorbelegs, nie eine frühere', () => {
    const vor   = t('2026-07-01T10:00:30Z')
    const jetzt = t('2026-07-01T10:00:00Z')                      // 30 s zurück
    const r = bestimmeBelegZeit(jetzt, vor)
    expect(r).toMatchObject({ ok: true, angeglichenUmMs: 30_000 })
    if (r.ok) {
      expect(r.zeit.getTime()).toBe(vor.getTime())
      expect(r.zeit).not.toBe(vor)                               // eigene Kopie, kein geteiltes Date
    }
  })

  it('genau an der Toleranzgrenze noch angeglichen, eine Millisekunde darüber abgelehnt', () => {
    const vor = t('2026-07-01T10:05:00.000Z')
    expect(bestimmeBelegZeit(new Date(vor.getTime() - UHR_TOLERANZ_MS), vor)).toMatchObject({ ok: true })
    const r = bestimmeBelegZeit(new Date(vor.getTime() - UHR_TOLERANZ_MS - 1), vor)
    expect(r).toMatchObject({ ok: false, rueckstandMs: UHR_TOLERANZ_MS + 1 })
  })

  it('Uhr um Stunden oder Jahre zurück (leere CMOS-Batterie): abgelehnt', () => {
    const vor = t('2026-07-01T10:00:00Z')
    expect(bestimmeBelegZeit(t('2026-07-01T07:00:00Z'), vor)).toMatchObject({ ok: false })
    expect(bestimmeBelegZeit(t('2000-01-01T00:00:00Z'), vor)).toMatchObject({ ok: false })
  })

  it('Zeitumstellung ist kein Rücksprung: UTC-Zeitpunkte laufen immer vorwärts', () => {
    // 2026-10-25: Wien 02:59:59 MESZ → 02:00:00 MEZ — als Zeitpunkt eine Sekunde später
    const vorher  = t('2026-10-25T00:59:59Z')
    const nachher = t('2026-10-25T01:00:00Z')
    expect(bestimmeBelegZeit(nachher, vorher)).toMatchObject({ ok: true, angeglichenUmMs: 0 })
  })
})
