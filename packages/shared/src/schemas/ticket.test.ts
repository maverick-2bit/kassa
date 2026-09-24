import { describe, it, expect } from 'vitest'
import {
  alterAm,
  bandFuerAlter,
  bandAltersText,
  ticketCodeAusScan,
  ticketUrl,
  wienerTag,
  STANDARD_BAENDER,
  TicketBaenderSetzenSchema,
  GeburtsdatumSchema,
  TicketAusstellenInputSchema,
  TicketEventInputSchema,
} from './ticket.js'

describe('alterAm — Alter am Eventtag', () => {
  it('zählt vollendete Jahre', () => {
    expect(alterAm('2008-10-17', '2026-10-17')).toBe(18)   // Geburtstag am Eventtag: schon 18
    expect(alterAm('2008-10-18', '2026-10-17')).toBe(17)   // einen Tag später: noch 17
    expect(alterAm('2008-01-01', '2026-10-17')).toBe(18)
    expect(alterAm('2008-12-31', '2026-10-17')).toBe(17)
  })

  it('Stichtag ist der Eventtag, nicht heute — wer bis zum Event 18 wird, zählt als 18', () => {
    // Bestellung im Juli mit 17, Event im Oktober nach dem Geburtstag
    expect(alterAm('2008-09-01', '2026-07-15')).toBe(17)
    expect(alterAm('2008-09-01', '2026-10-17')).toBe(18)
  })

  it('29. Februar: in Nicht-Schaltjahren erst am 1. März ein Jahr älter (vorsichtige Lesart)', () => {
    expect(alterAm('2008-02-29', '2026-02-28')).toBe(17)
    expect(alterAm('2008-02-29', '2026-03-01')).toBe(18)
    expect(alterAm('2008-02-29', '2028-02-29')).toBe(20)
  })
})

describe('bandFuerAlter — Standardbänder', () => {
  const baender = STANDARD_BAENDER.map(b => ({ ...b, alterVon: b.alterVon, alterBis: b.alterBis }))

  it('ordnet jede Altersgruppe genau einem Band zu', () => {
    expect(bandFuerAlter(baender, 18)?.bezeichnung).toBe('Grün')
    expect(bandFuerAlter(baender, 45)?.bezeichnung).toBe('Grün')
    expect(bandFuerAlter(baender, 17)?.bezeichnung).toBe('Gelb')
    expect(bandFuerAlter(baender, 16)?.bezeichnung).toBe('Gelb')
    expect(bandFuerAlter(baender, 15)?.bezeichnung).toBe('Rot')
    expect(bandFuerAlter(baender, 0)?.bezeichnung).toBe('Rot')
  })

  it('liefert null, wenn kein Band passt', () => {
    expect(bandFuerAlter([{ alterVon: 18, alterBis: null }], 17)).toBeNull()
  })

  it('Standardbänder sind lückenlos und überschneidungsfrei', () => {
    expect(TicketBaenderSetzenSchema.safeParse({ baender: STANDARD_BAENDER }).success).toBe(true)
    for (let alter = 0; alter <= 120; alter++) {
      expect(bandFuerAlter(baender, alter), `Alter ${alter}`).not.toBeNull()
    }
  })
})

describe('bandAltersText', () => {
  it('formuliert die Grenzen so, wie sie auf dem Ticket stehen', () => {
    expect(bandAltersText({ alterVon: 18,   alterBis: null })).toBe('ab 18 Jahre')
    expect(bandAltersText({ alterVon: 16,   alterBis: 17 })).toBe('16–17 Jahre')
    expect(bandAltersText({ alterVon: null, alterBis: 15 })).toBe('unter 16 Jahre')
    expect(bandAltersText({ alterVon: 16,   alterBis: 16 })).toBe('16 Jahre')
    expect(bandAltersText({ alterVon: null, alterBis: null })).toBe('alle Altersgruppen')
  })
})

describe('TicketBaenderSetzenSchema', () => {
  it('lehnt überlappende Altersbereiche ab', () => {
    const r = TicketBaenderSetzenSchema.safeParse({ baender: [
      { bezeichnung: 'A', farbe: '#000000', alterVon: 16, alterBis: null },
      { bezeichnung: 'B', farbe: '#ffffff', alterVon: null, alterBis: 17 },
    ] })
    expect(r.success).toBe(false)
  })

  it('lehnt von > bis ab', () => {
    const r = TicketBaenderSetzenSchema.safeParse({ baender: [
      { bezeichnung: 'A', farbe: '#000000', alterVon: 18, alterBis: 16 },
    ] })
    expect(r.success).toBe(false)
  })
})

describe('Ticket-Code aus Scan', () => {
  const code = 'ixn3fc4rypdsvd59'.replace('i', 'a')   // „i" ist nicht im Alphabet

  it('akzeptiert den Link zur Ticketseite, egal welche Domain', () => {
    expect(ticketCodeAusScan(ticketUrl('https://tickets.example.at/', code))).toBe(code)
    expect(ticketCodeAusScan(`http://192.168.192.10:8086/t/${code}`)).toBe(code)
    expect(ticketCodeAusScan(`https://x.at/t/${code}?ref=wa`)).toBe(code)
  })

  it('akzeptiert den nackten Code, auch groß geschrieben und mit Leerzeichen', () => {
    expect(ticketCodeAusScan(`  ${code.toUpperCase()}\n`)).toBe(code)
  })

  it('lehnt fremde QR-Inhalte ab', () => {
    expect(ticketCodeAusScan('https://example.at/speisekarte')).toBeNull()
    expect(ticketCodeAusScan('hallo')).toBeNull()
    expect(ticketCodeAusScan('0000000000000000')).toBeNull()   // 0 ist nicht im Alphabet
  })
})

describe('Eingabeprüfung', () => {
  it('Geburtsdatum: echtes Datum, nicht in der Zukunft', () => {
    expect(GeburtsdatumSchema.safeParse('2008-10-17').success).toBe(true)
    expect(GeburtsdatumSchema.safeParse('2008-02-30').success).toBe(false)
    expect(GeburtsdatumSchema.safeParse('17.10.2008').success).toBe(false)
    expect(GeburtsdatumSchema.safeParse('2999-01-01').success).toBe(false)
    expect(GeburtsdatumSchema.safeParse('1850-01-01').success).toBe(false)
  })

  it('Ausstellen: Einzelticket braucht Ticketart, Mehrfachticket eine Rolle', () => {
    expect(TicketAusstellenInputSchema.safeParse({ typ: 'einzel', anzahl: 1 }).success).toBe(false)
    expect(TicketAusstellenInputSchema.safeParse({ typ: 'mehrfach', anzahl: 5 }).success).toBe(false)
    expect(TicketAusstellenInputSchema.safeParse({ typ: 'mehrfach', anzahl: 5, rolle: 'Crew' }).success).toBe(true)
  })

  it('Ausstellen: Name/Geburtsdatum nur bei genau einem Ticket', () => {
    const r = TicketAusstellenInputSchema.safeParse({
      typ: 'mehrfach', anzahl: 3, rolle: 'Crew', geburtsdatum: '2000-01-01',
    })
    expect(r.success).toBe(false)
  })

  it('Event: Ende muss nach dem Beginn liegen', () => {
    const basis = { titel: 'X', ort: 'Leoben', beginn: '2026-10-17T13:00:00.000Z' }
    expect(TicketEventInputSchema.safeParse({ ...basis, ende: '2026-10-17T12:00:00.000Z' }).success).toBe(false)
    expect(TicketEventInputSchema.safeParse({ ...basis, ende: '2026-10-17T22:00:00.000Z' }).success).toBe(true)
  })
})

describe('wienerTag', () => {
  it('rechnet in Wiener Zeit — 23:30 UTC ist in Wien schon der nächste Tag', () => {
    expect(wienerTag('2026-10-16T23:30:00Z')).toBe('2026-10-17')   // Sommerzeit, UTC+2
    expect(wienerTag('2026-12-31T23:30:00Z')).toBe('2027-01-01')   // Winterzeit, UTC+1
    expect(wienerTag('2026-12-31T22:30:00Z')).toBe('2026-12-31')
  })
})
