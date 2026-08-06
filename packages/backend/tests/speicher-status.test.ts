/**
 * Plattenplatz-Schwellen (holeSpeicherStatus).
 *
 * Die volle Platte legt Postgres UND die Sicherung gleichzeitig lahm. Die
 * Schwellen sind deshalb der eigentliche Wert dieser Funktion — und im echten
 * Betrieb kaum nachstellbar, ohne eine Platte vollzuschreiben. Also hier, über
 * die injizierbare Messfunktion.
 */

import { describe, it, expect } from 'vitest'
import { holeSpeicherStatus, type StatfsFn } from '../src/services/monitoring.service.js'

const GB = 1024 ** 3

/** Messfunktion mit 1-Byte-Blöcken — die Zahlen sind damit direkt Bytes. */
function platte(gesamtGb: number, verfuegbarGb: number): StatfsFn {
  return async () => ({ bsize: 1, blocks: gesamtGb * GB, bavail: verfuegbarGb * GB })
}

describe('holeSpeicherStatus', () => {
  it('meldet ok bei reichlich Platz', async () => {
    const s = await holeSpeicherStatus('/data/db-backups', platte(500, 300))
    expect(s.zustand).toBe('ok')
    expect(s.gesamtGb).toBe(500)
    expect(s.freiGb).toBe(300)
    expect(s.freiProzent).toBe(60)
    expect(s.pfad).toBe('/data/db-backups')
  })

  it('rechnet mit bavail — die root-Reserve nützt dem Backend nichts', async () => {
    // bfree wäre hier größer; gemessen wird ausdrücklich der für normale
    // Prozesse verfügbare Platz.
    const s = await holeSpeicherStatus('/data', platte(100, 8))
    expect(s.freiGb).toBe(8)
    expect(s.freiProzent).toBe(8)
    expect(s.zustand).toBe('knapp')
  })

  it('warnt prozentual auf kleinen Platten', async () => {
    // 6 von 64 GB = 9,4 % — unter 10, aber über 5
    expect((await holeSpeicherStatus('/data', platte(64, 6))).zustand).toBe('knapp')
  })

  it('schlägt prozentual Alarm', async () => {
    // 3 von 64 GB = 4,7 %
    expect((await holeSpeicherStatus('/data', platte(64, 3))).zustand).toBe('kritisch')
  })

  it('nimmt die Absolutgrenze, wenn der Prozentsatz noch harmlos aussieht', async () => {
    // 3 von 20 GB = 15 % — prozentual unauffällig, absolut aber schon knapp
    expect((await holeSpeicherStatus('/data', platte(20, 3))).zustand).toBe('knapp')
    // 1,5 von 20 GB = 7,5 % — die Absolutgrenze zieht auf kritisch
    expect((await holeSpeicherStatus('/data', platte(20, 1.5))).zustand).toBe('kritisch')
  })

  it('warnt auch auf sehr großen Platten', async () => {
    expect((await holeSpeicherStatus('/data', platte(2000, 4))).zustand).toBe('kritisch')
    expect((await holeSpeicherStatus('/data', platte(2000, 1200))).zustand).toBe('ok')
  })

  it('weicht auf das Arbeitsverzeichnis aus, wenn der Pfad noch nicht existiert', async () => {
    // Direkt nach der Installation gibt es das Sicherungsverzeichnis noch nicht
    // — es entsteht erst beim ersten nächtlichen Lauf. Bis dahin darf der Platz
    // nicht unbeobachtet bleiben.
    const nurZweiterVersuch: StatfsFn = async (p) => {
      if (p !== process.cwd()) throw new Error('ENOENT')
      return { bsize: 1, blocks: 100 * GB, bavail: 50 * GB }
    }
    const s = await holeSpeicherStatus('/data/db-backups', nurZweiterVersuch)
    expect(s.zustand).toBe('ok')
    expect(s.freiProzent).toBe(50)
    expect(s.pfad).toBe(process.cwd())   // gemeldet wird, was gemessen wurde
  })

  it('meldet unbekannt statt zu werfen, wenn gar nichts messbar ist', async () => {
    // Der Monitoring-Endpoint darf an einem kaputten Messpunkt nicht scheitern.
    const kaputt: StatfsFn = async () => { throw new Error('ENOENT') }
    const s = await holeSpeicherStatus('/gibt/es/nicht', kaputt)
    expect(s.zustand).toBe('unbekannt')
    expect(s.gesamtGb).toBeNull()
    expect(s.freiGb).toBeNull()
    expect(s.freiProzent).toBeNull()
    expect(s.pfad).toBe('/gibt/es/nicht')
  })

  it('verkraftet eine Platte mit Größe 0 ohne Division durch null', async () => {
    const s = await holeSpeicherStatus('/data', platte(0, 0))
    expect(s.freiProzent).toBe(0)
    expect(s.zustand).toBe('kritisch')
  })

  it('misst ohne Injektion einen echten Pfad', async () => {
    // Beweist, dass die Voreinstellung wirklich das echte statfs ist.
    const s = await holeSpeicherStatus(process.cwd())
    expect(s.zustand).not.toBe('unbekannt')
    expect(s.gesamtGb).toBeGreaterThan(0)
  })
})
