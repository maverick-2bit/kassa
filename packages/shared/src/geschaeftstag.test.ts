import { describe, it, expect } from 'vitest'
import {
  addTage,
  beginnFuer,
  beginnStunde,
  dauerStunden,
  geschaeftstagText,
  geschaeftstagVon,
  heuteGeschaeftstag,
  istKalenderDatum,
  istKalendertag,
  istStandardRegel,
  istTagesbeginn,
  normalisiereRegel,
  stundenAchse,
  tagesGrenzen,
  uebergangsVorschau,
  wienerZeit,
  wienerZeitpunkt,
  type TagesRegel,
} from './geschaeftstag.js'

const iso = (d: Date) => d.toISOString()
/** Wiener Wanduhr → ISO-UTC, bequem für Erwartungswerte */
const wien = (datum: string, hm: string) => iso(wienerZeitpunkt(datum, hm))

const SECHS_UHR: TagesRegel = [{ gueltigAb: '2026-01-01', beginn: '06:00' }]

describe('Prüfungen und Kalenderarithmetik', () => {
  it('istKalenderDatum erkennt echte Kalendertage', () => {
    expect(istKalenderDatum('2026-10-02')).toBe(true)
    expect(istKalenderDatum('2028-02-29')).toBe(true)
    expect(istKalenderDatum('2026-02-29')).toBe(false)
    expect(istKalenderDatum('2026-13-01')).toBe(false)
    expect(istKalenderDatum('26-10-02')).toBe(false)
    expect(istKalenderDatum('')).toBe(false)
  })

  it('istTagesbeginn: HH:MM von 00:00 bis 23:59', () => {
    for (const ok of ['00:00', '06:00', '23:59', '12:30']) expect(istTagesbeginn(ok)).toBe(true)
    for (const nok of ['24:00', '6:00', '06:60', '0600', '', '06:00:00']) expect(istTagesbeginn(nok)).toBe(false)
  })

  it('addTage rechnet rein kalendarisch (Monats-, Jahres-, Schaltjahrgrenzen)', () => {
    expect(addTage('2026-10-31', 1)).toBe('2026-11-01')
    expect(addTage('2026-01-01', -1)).toBe('2025-12-31')
    expect(addTage('2028-02-28', 1)).toBe('2028-02-29')
    expect(addTage('2026-02-28', 1)).toBe('2026-03-01')
    expect(addTage('2026-03-29', 0)).toBe('2026-03-29')
    expect(addTage('2026-10-24', 7)).toBe('2026-10-31')
  })

  it('beginnStunde + stundenAchse beginnen beim Tagesbeginn', () => {
    expect(beginnStunde('06:30')).toBe(6)
    expect(stundenAchse('00:00')).toEqual(Array.from({ length: 24 }, (_, i) => i))
    expect(stundenAchse('06:00')).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5])
    expect(stundenAchse('23:00')[0]).toBe(23)
    expect(stundenAchse('23:00')[1]).toBe(0)
    expect(new Set(stundenAchse('17:45')).size).toBe(24)
  })
})

describe('Regel: beginnFuer', () => {
  it('ohne Eintrag gilt 00:00', () => {
    expect(beginnFuer([], '2026-10-02')).toBe('00:00')
    expect(istStandardRegel([])).toBe(true)
  })

  it('vor dem ersten Stichtag gilt 00:00, am Stichtag der neue Wert', () => {
    expect(beginnFuer(SECHS_UHR, '2025-12-31')).toBe('00:00')
    expect(beginnFuer(SECHS_UHR, '2026-01-01')).toBe('06:00')
    expect(beginnFuer(SECHS_UHR, '2030-05-05')).toBe('06:00')
    expect(istStandardRegel(SECHS_UHR)).toBe(false)
  })

  it('der Eintrag mit dem größten gueltigAb <= Tag gewinnt — unabhängig von der Reihenfolge', () => {
    const regel: TagesRegel = [
      { gueltigAb: '2026-12-01', beginn: '04:00' },
      { gueltigAb: '2026-01-01', beginn: '06:00' },
      { gueltigAb: '2026-06-01', beginn: '00:00' },
    ]
    expect(beginnFuer(regel, '2026-05-31')).toBe('06:00')
    expect(beginnFuer(regel, '2026-06-01')).toBe('00:00')
    expect(beginnFuer(regel, '2026-11-30')).toBe('00:00')
    expect(beginnFuer(regel, '2026-12-01')).toBe('04:00')
  })

  it('normalisiereRegel sortiert, entdoppelt (später gewinnt) und verwirft Ungültiges', () => {
    const r = normalisiereRegel([
      { gueltigAb: '2026-12-01', beginn: '04:00' },
      { gueltigAb: '2026-01-01', beginn: '06:00' },
      { gueltigAb: '2026-12-01', beginn: '05:00' },
      { gueltigAb: 'kaputt',     beginn: '05:00' },
      { gueltigAb: '2026-03-01', beginn: '25:00' },
    ])
    expect(r).toEqual([
      { gueltigAb: '2026-01-01', beginn: '06:00' },
      { gueltigAb: '2026-12-01', beginn: '05:00' },
    ])
  })

  it('istKalendertag: nur wenn Tagesanfang UND Folgetagsanfang 00:00 sind', () => {
    expect(istKalendertag([], '2026-10-02')).toBe(true)
    expect(istKalendertag(SECHS_UHR, '2026-10-02')).toBe(false)
    // Tag vor dem Stichtag: endet zum neuen Beginn → kein Kalendertag
    expect(istKalendertag(SECHS_UHR, '2025-12-31')).toBe(false)
    expect(istKalendertag(SECHS_UHR, '2025-12-30')).toBe(true)
  })
})

describe('Wiener Ortszeit ↔ Zeitpunkt', () => {
  it('wienerZeit: Sommer- und Winterzeit, Datum und Offset', () => {
    expect(wienerZeit(new Date('2026-07-01T10:30:00Z'))).toEqual({ datum: '2026-07-01', hm: '12:30', offsetMin: 120 })
    expect(wienerZeit(new Date('2026-01-15T10:30:00Z'))).toEqual({ datum: '2026-01-15', hm: '11:30', offsetMin: 60 })
  })

  it('wienerZeit: Mitternacht zeigt 00:00, nicht 24:00', () => {
    expect(wienerZeit(new Date('2026-06-30T22:00:00Z'))).toMatchObject({ datum: '2026-07-01', hm: '00:00' })
    expect(wienerZeit(new Date('2026-01-14T23:00:00Z'))).toMatchObject({ datum: '2026-01-15', hm: '00:00' })
    expect(wienerZeit(new Date('2026-01-15T22:59:59.999Z'))).toMatchObject({ datum: '2026-01-15', hm: '23:59' })
  })

  it('wienerZeitpunkt: gewöhnliche Zeiten', () => {
    expect(wien('2026-07-01', '12:30')).toBe('2026-07-01T10:30:00.000Z')
    expect(wien('2026-01-15', '11:30')).toBe('2026-01-15T10:30:00.000Z')
    expect(wien('2026-07-01', '00:00')).toBe('2026-06-30T22:00:00.000Z')
  })

  it('Sommerzeit-Beginn 2026-03-29: Lücke 02:00–03:00 wird wie in PostgreSQL aufgelöst', () => {
    // PostgreSQL: '2026-03-29 02:30'::timestamp AT TIME ZONE 'Europe/Vienna' = 01:30Z
    expect(wien('2026-03-29', '01:59')).toBe('2026-03-29T00:59:00.000Z')
    expect(wien('2026-03-29', '02:00')).toBe('2026-03-29T01:00:00.000Z')
    expect(wien('2026-03-29', '02:30')).toBe('2026-03-29T01:30:00.000Z')
    expect(wien('2026-03-29', '03:00')).toBe('2026-03-29T01:00:00.000Z')
  })

  it('Winterzeit-Beginn 2026-10-25: Überlappung 02:00–03:00 gilt als Standardzeit', () => {
    expect(wien('2026-10-25', '01:59')).toBe('2026-10-24T23:59:00.000Z')
    expect(wien('2026-10-25', '02:00')).toBe('2026-10-25T01:00:00.000Z')
    expect(wien('2026-10-25', '02:30')).toBe('2026-10-25T01:30:00.000Z')
    expect(wien('2026-10-25', '03:00')).toBe('2026-10-25T02:00:00.000Z')
  })

  it('Rundlauf: jede existierende Wiener Zeit wird exakt zurückgerechnet (ganzes Jahr, 15-Minuten-Raster)', () => {
    let tag = '2026-01-01'
    let geprueft = 0
    while (tag <= '2026-12-31') {
      for (let h = 0; h < 24; h++) {
        for (const m of [0, 15, 30, 45]) {
          const hm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
          const z = wienerZeitpunkt(tag, hm)
          const w = wienerZeit(z)
          // In den zwei Zeitumstellungs-Stunden gibt es keine eindeutige Rückrechnung
          if (tag === '2026-03-29' && h === 2) continue
          if (tag === '2026-10-25' && h === 2) continue
          expect(`${w.datum} ${w.hm}`).toBe(`${tag} ${hm}`)
          geprueft++
        }
      }
      tag = addTage(tag, 1)
    }
    expect(geprueft).toBe(365 * 96 - 2 * 4)
  })
})

describe('Geschäftstag eines Zeitpunkts (Standard 00:00 = Kalendertag)', () => {
  it('ohne Regel ist der Geschäftstag der Wiener Kalendertag — auch um Mitternacht und in UTC-Randstunden', () => {
    expect(geschaeftstagVon([], new Date('2026-10-02T21:59:59Z'))).toBe('2026-10-02') // 23:59:59 MESZ
    expect(geschaeftstagVon([], new Date('2026-10-02T22:00:00Z'))).toBe('2026-10-03') // 00:00 MESZ
    expect(geschaeftstagVon([], new Date('2026-01-15T22:59:59Z'))).toBe('2026-01-15') // 23:59:59 MEZ
    expect(geschaeftstagVon([], new Date('2026-01-15T23:00:00Z'))).toBe('2026-01-16') // 00:00 MEZ
  })
})

describe('Geschäftstag eines Zeitpunkts (Tagesbeginn 06:00)', () => {
  const tag = (z: string) => geschaeftstagVon(SECHS_UHR, new Date(z))

  it('Mitternacht, 05:59, 06:00, 06:01 — Sommerzeit (MESZ = UTC+2)', () => {
    expect(tag('2026-10-02T21:59:00Z')).toBe('2026-10-02') // 23:59 am 02.10.
    expect(tag('2026-10-02T22:00:00Z')).toBe('2026-10-02') // 00:00 am 03.10. → noch der 02.
    expect(tag('2026-10-03T03:59:59Z')).toBe('2026-10-02') // 05:59:59 am 03.10.
    expect(tag('2026-10-03T04:00:00Z')).toBe('2026-10-03') // 06:00 am 03.10. → neuer Tag
    expect(tag('2026-10-03T04:01:00Z')).toBe('2026-10-03') // 06:01
  })

  it('Mitternacht, 05:59, 06:00, 06:01 — Winterzeit (MEZ = UTC+1)', () => {
    expect(tag('2026-01-15T22:59:00Z')).toBe('2026-01-15') // 23:59 am 15.01.
    expect(tag('2026-01-15T23:00:00Z')).toBe('2026-01-15') // 00:00 am 16.01. → noch der 15.
    expect(tag('2026-01-16T04:59:59Z')).toBe('2026-01-15') // 05:59:59 am 16.01.
    expect(tag('2026-01-16T05:00:00Z')).toBe('2026-01-16') // 06:00 am 16.01.
    expect(tag('2026-01-16T05:01:00Z')).toBe('2026-01-16')
  })

  it('Nachtschicht 18:00–02:00 liegt komplett auf einem Geschäftstag', () => {
    expect(tag('2026-10-02T16:00:00Z')).toBe('2026-10-02') // 18:00 MESZ
    expect(tag('2026-10-03T00:00:00Z')).toBe('2026-10-02') // 02:00 MESZ am 03.10.
  })

  it('heuteGeschaeftstag: um 02:00 nachts ist „heute" noch der Vortag', () => {
    expect(heuteGeschaeftstag(SECHS_UHR, new Date('2026-10-03T00:00:00Z'))).toBe('2026-10-02')
    expect(heuteGeschaeftstag([], new Date('2026-10-03T00:00:00Z'))).toBe('2026-10-03')
  })

  it('Tag vor dem ersten Stichtag: Standard 00:00, aber der Stichtag selbst beginnt um 06:00', () => {
    // Stichtag 2026-01-01 06:00: der 31.12. endet erst dann (30 Stunden lang)
    expect(tag('2026-01-01T03:00:00Z')).toBe('2025-12-31') // 04:00 MEZ am 01.01.
    expect(tag('2026-01-01T05:00:00Z')).toBe('2026-01-01') // 06:00 MEZ
    expect(tag('2025-12-31T05:00:00Z')).toBe('2025-12-31') // 06:00 am 31.12. (alter Beginn 00:00)
  })
})

describe('Tagesgrenzen', () => {
  it('Standard: ein Kalendertag von 00:00 bis 00:00 Wiener Zeit', () => {
    const g = tagesGrenzen([], '2026-10-02')
    expect(iso(g.von)).toBe('2026-10-01T22:00:00.000Z')
    expect(iso(g.bis)).toBe('2026-10-02T22:00:00.000Z')
    expect(dauerStunden(g)).toBe(24)
  })

  it('Tag der Umstellung auf Sommerzeit (2026-03-29) hat 23 Stunden', () => {
    const g = tagesGrenzen([], '2026-03-29')
    expect(iso(g.von)).toBe('2026-03-28T23:00:00.000Z')
    expect(iso(g.bis)).toBe('2026-03-29T22:00:00.000Z')
    expect(dauerStunden(g)).toBe(23)
  })

  it('Tag der Umstellung auf Winterzeit (2026-10-25) hat 25 Stunden', () => {
    const g = tagesGrenzen([], '2026-10-25')
    expect(iso(g.von)).toBe('2026-10-24T22:00:00.000Z')
    expect(iso(g.bis)).toBe('2026-10-25T23:00:00.000Z')
    expect(dauerStunden(g)).toBe(25)
  })

  it('Tagesbeginn 06:00: 06:00 bis 06:00 des Folgetags; der Tag MIT Umstellung ist 23 bzw. 25 Stunden lang', () => {
    // Die Umstellung (02:00 Wiener Zeit am 29.03.) liegt im Geschäftstag 28.03. (28.03. 06:00 – 29.03. 06:00)
    expect(dauerStunden(tagesGrenzen(SECHS_UHR, '2026-03-28'))).toBe(23)
    expect(dauerStunden(tagesGrenzen(SECHS_UHR, '2026-03-29'))).toBe(24)
    expect(dauerStunden(tagesGrenzen(SECHS_UHR, '2026-10-24'))).toBe(25)
    expect(dauerStunden(tagesGrenzen(SECHS_UHR, '2026-10-25'))).toBe(24)
    const g = tagesGrenzen(SECHS_UHR, '2026-10-02')
    expect(iso(g.von)).toBe('2026-10-02T04:00:00.000Z') // 06:00 MESZ
    expect(iso(g.bis)).toBe('2026-10-03T04:00:00.000Z')
  })
})

describe('Wechsel des Tagesbeginns mit Stichtag', () => {
  /** 00:00 bis 02.11., ab 03.11. um 06:00 → der 02.11. wird LÄNGER (30 Stunden) */
  const spaeter: TagesRegel = [{ gueltigAb: '2026-11-03', beginn: '06:00' }]
  /** 06:00 bis 02.11., ab 03.11. um 00:00 → der 02.11. wird KÜRZER (18 Stunden) */
  const frueher: TagesRegel = [
    { gueltigAb: '2026-01-01', beginn: '06:00' },
    { gueltigAb: '2026-11-03', beginn: '00:00' },
  ]

  it('00:00 → 06:00: Übergangstag 30 Stunden, danach 24-Stunden-Tage ab 06:00', () => {
    const uebergang = tagesGrenzen(spaeter, '2026-11-02')
    expect(iso(uebergang.von)).toBe(wien('2026-11-02', '00:00'))
    expect(iso(uebergang.bis)).toBe(wien('2026-11-03', '06:00'))
    expect(dauerStunden(uebergang)).toBe(30)
    expect(iso(tagesGrenzen(spaeter, '2026-11-03').von)).toBe(wien('2026-11-03', '06:00'))
    // 03.11. 03:00 gehört noch zum langen Übergangstag
    expect(geschaeftstagVon(spaeter, wienerZeitpunkt('2026-11-03', '03:00'))).toBe('2026-11-02')
    expect(geschaeftstagVon(spaeter, wienerZeitpunkt('2026-11-03', '06:00'))).toBe('2026-11-03')
  })

  it('06:00 → 00:00: Übergangstag nur 18 Stunden, der Stichtag beginnt um Mitternacht', () => {
    const uebergang = tagesGrenzen(frueher, '2026-11-02')
    expect(iso(uebergang.von)).toBe(wien('2026-11-02', '06:00'))
    expect(iso(uebergang.bis)).toBe(wien('2026-11-03', '00:00'))
    expect(dauerStunden(uebergang)).toBe(18)
    expect(geschaeftstagVon(frueher, wienerZeitpunkt('2026-11-03', '00:00'))).toBe('2026-11-03')
    expect(geschaeftstagVon(frueher, wienerZeitpunkt('2026-11-02', '23:59'))).toBe('2026-11-02')
    expect(geschaeftstagVon(frueher, wienerZeitpunkt('2026-11-03', '05:59'))).toBe('2026-11-03')
  })

  it('Wechsel genau an der Zeitumstellung (ab 2026-10-25 um 06:00): Übergangstag 31 Stunden', () => {
    const regel: TagesRegel = [{ gueltigAb: '2026-10-25', beginn: '06:00' }]
    // 24.10. 00:00 MESZ bis 25.10. 06:00 MEZ = 24 + 6 + 1 (Rückstellung) Stunden
    expect(dauerStunden(tagesGrenzen(regel, '2026-10-24'))).toBe(31)
  })

  it('uebergangsVorschau nennt Tag, Grenzen und Dauer des Übergangstags', () => {
    const v = uebergangsVorschau([], { gueltigAb: '2026-11-03', beginn: '06:00' })
    expect(v.datum).toBe('2026-11-02')
    expect(iso(v.von)).toBe(wien('2026-11-02', '00:00'))
    expect(iso(v.bis)).toBe(wien('2026-11-03', '06:00'))
    expect(v.dauerStunden).toBe(30)

    const k = uebergangsVorschau(frueher.slice(0, 1), { gueltigAb: '2026-11-03', beginn: '00:00' })
    expect(k.dauerStunden).toBe(18)
  })

  const regeln: [string, TagesRegel][] = [
    ['Standard', []],
    ['06:00 ab Jahresbeginn', SECHS_UHR],
    ['00:00 → 06:00', spaeter],
    ['06:00 → 00:00', frueher],
    ['mehrfacher Wechsel über beide Zeitumstellungen', [
      { gueltigAb: '2026-02-01', beginn: '05:00' },
      { gueltigAb: '2026-03-29', beginn: '23:30' },
      { gueltigAb: '2026-06-15', beginn: '00:00' },
      { gueltigAb: '2026-10-25', beginn: '04:15' },
      { gueltigAb: '2026-11-03', beginn: '12:00' },
    ]],
  ]

  for (const [name, regel] of regeln) {
    it(`lückenlos und überschneidungsfrei — ${name}`, () => {
      // 1) Der Beginn jedes Tages ist das Ende des Vortags, und jeder Tag ist nicht leer
      let tag = '2025-12-20'
      let summeStunden = 0
      const erster = tagesGrenzen(regel, tag).von
      let letztes = erster
      for (let i = 0; i < 400; i++) {
        const g = tagesGrenzen(regel, tag)
        expect(iso(g.von)).toBe(iso(letztes))
        expect(g.bis.getTime()).toBeGreaterThan(g.von.getTime())
        summeStunden += dauerStunden(g)
        letztes = g.bis
        tag = addTage(tag, 1)
      }
      // 2) Summe aller Tage = Gesamtzeitraum
      expect(summeStunden).toBe((letztes.getTime() - erster.getTime()) / 3_600_000)

      // 3) Jeder Zeitpunkt gehört zu genau EINEM Geschäftstag: sein Etikett passt zu den Tagesgrenzen
      const start = Date.parse('2026-01-05T00:00:00Z')
      for (let t = start; t < start + 330 * 86_400_000; t += 37 * 60_000) {
        const z = new Date(t)
        const label = geschaeftstagVon(regel, z)
        const g = tagesGrenzen(regel, label)
        expect(z.getTime()).toBeGreaterThanOrEqual(g.von.getTime())
        expect(z.getTime()).toBeLessThan(g.bis.getTime())
      }
    })
  }
})

describe('Anzeige', () => {
  it('geschaeftstagText schreibt den Zeitraum in Wiener Zeit aus', () => {
    const g = tagesGrenzen(SECHS_UHR, '2026-10-02')
    expect(geschaeftstagText(g.von, g.bis)).toBe('Geschäftstag 02.10.2026, 06:00 – 03.10.2026, 06:00')
    // auch mit ISO-Strings (so kommt es aus der API)
    expect(geschaeftstagText(iso(g.von), iso(g.bis))).toBe('Geschäftstag 02.10.2026, 06:00 – 03.10.2026, 06:00')
  })
})
