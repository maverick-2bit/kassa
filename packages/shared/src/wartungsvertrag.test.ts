import { describe, expect, it } from 'vitest'
import {
  addMonate,
  ersteVertragsperiode,
  letzteVertragsperiode,
  letzterVertragsmonat,
  positionFaellig,
  rechnungFaellig,
  rechnungsBlockEnde,
  vertragsPerioden,
  WartungsvertragInputSchema,
} from './index.js'

describe('Wartungsvertrag: Perioden', () => {
  it('addMonate über den Jahreswechsel', () => {
    expect(addMonate('2026-11', 2)).toBe('2027-01')
    expect(addMonate('2026-01', -1)).toBe('2025-12')
    expect(addMonate('2026-05', 24)).toBe('2028-05')
  })

  it('Startmonat zählt nie: erste Periode ist der Folgemonat, egal an welchem Tag', () => {
    expect(ersteVertragsperiode('2026-03-01')).toBe('2026-04')
    expect(ersteVertragsperiode('2026-03-16')).toBe('2026-04')
    expect(ersteVertragsperiode('2026-03-31')).toBe('2026-04')
    expect(ersteVertragsperiode('2026-12-20')).toBe('2027-01')
  })

  it('Endmonat zählt immer, auch wenn er nur angefangen ist', () => {
    expect(letzteVertragsperiode('2026-09-30')).toBe('2026-09')
    expect(letzteVertragsperiode('2026-09-14')).toBe('2026-09')
    expect(letzteVertragsperiode('2026-09-01')).toBe('2026-09')
  })

  it('vertragsPerioden endet am aktuellen Monat bzw. Vertragsende', () => {
    expect(vertragsPerioden('2026-08-01', undefined, '2026-10')).toEqual(['2026-09', '2026-10'])
    expect(vertragsPerioden('2026-08-01', '2026-09-15', '2026-12')).toEqual(['2026-09'])
    expect(vertragsPerioden('2026-08-31', '2026-09-01', '2026-12')).toEqual(['2026-09'])
    expect(vertragsPerioden('2026-10-05', undefined, '2026-10')).toEqual([])
    expect(vertragsPerioden('2026-08-01', '2026-08-20', '2026-12')).toEqual([])
  })
})

describe('Wartungsvertrag: Häufigkeit (Laufzeit)', () => {
  it('monatlich × 12 = ein Jahr ab der ersten Periode', () => {
    expect(letzterVertragsmonat('2026-01-15', undefined, { anzahl: 12, intervall: 'monatlich' })).toBe('2027-01')
  })

  it('quartal × 4 = ein Jahr, jahr × 2 = zwei Jahre', () => {
    expect(letzterVertragsmonat('2026-01-01', undefined, { anzahl: 4, intervall: 'quartal' })).toBe('2027-01')
    expect(letzterVertragsmonat('2026-01-01', undefined, { anzahl: 2, intervall: 'jahr' })).toBe('2028-01')
  })

  it('das frühere von Ende und Häufigkeit gilt; ohne beides unbefristet', () => {
    expect(letzterVertragsmonat('2026-01-01', '2026-06-30', { anzahl: 12, intervall: 'monatlich' })).toBe('2026-06')
    expect(letzterVertragsmonat('2026-01-01', '2030-01-01', { anzahl: 3, intervall: 'monatlich' })).toBe('2026-04')
    expect(letzterVertragsmonat('2026-01-01', undefined, null)).toBeUndefined()
  })

  it('vertragsPerioden begrenzt durch die Häufigkeit', () => {
    expect(vertragsPerioden('2026-01-10', undefined, '2026-12', { anzahl: 3, intervall: 'monatlich' }))
      .toEqual(['2026-02', '2026-03', '2026-04'])
  })
})
describe('Wartungsvertrag: Positions-Fälligkeit', () => {
  const erste = '2026-03'

  it('monatlich ist immer fällig', () => {
    for (let m = 1; m <= 12; m++) {
      expect(positionFaellig({ intervall: 'monatlich' }, `2026-${String(m).padStart(2, '0')}`, erste)).toBe(true)
    }
  })

  it('jährlich nur im Anker-Monat (Zertifikat im Januar)', () => {
    const pos = { intervall: 'jahr' as const, ankerMonat: 1 }
    const faellig = Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`)
      .filter(p => positionFaellig(pos, p, erste))
    expect(faellig).toEqual(['2027-01'])
  })

  it('ohne Anker gilt der Monat der ersten Vertragsperiode', () => {
    const pos = { intervall: 'jahr' as const }
    expect(positionFaellig(pos, '2026-03', erste)).toBe(true)
    expect(positionFaellig(pos, '2026-04', erste)).toBe(false)
    expect(positionFaellig(pos, '2027-03', erste)).toBe(true)
  })

  it('quartalsweise ab Anker 2: Feb, Mai, Aug, Nov', () => {
    const pos = { intervall: 'quartal' as const, ankerMonat: 2 }
    const faellig = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))
      .filter(m => positionFaellig(pos, `2026-${m}`, erste))
    expect(faellig).toEqual(['02', '05', '08', '11'])
  })

  it('halbjährlich ab Anker 11 geht über den Jahreswechsel', () => {
    const pos = { intervall: 'halbjahr' as const, ankerMonat: 11 }
    expect(positionFaellig(pos, '2026-11', erste)).toBe(true)
    expect(positionFaellig(pos, '2027-05', erste)).toBe(true)
    expect(positionFaellig(pos, '2027-02', erste)).toBe(false)
  })
})

describe('Wartungsvertrag: Rechnungsblöcke', () => {
  it('monatlich: jede Periode schließt einen Block', () => {
    expect(rechnungFaellig('monatlich', '2026-05', '2026-05')).toBe(true)
    expect(rechnungsBlockEnde('monatlich', '2026-07', '2026-05')).toBe('2026-07')
  })

  it('quartal ab Mai: Blöcke Mai–Jul, Aug–Okt …; Rechnung mit dem letzten Monat', () => {
    expect(rechnungFaellig('quartal', '2026-05', '2026-05')).toBe(false)
    expect(rechnungFaellig('quartal', '2026-06', '2026-05')).toBe(false)
    expect(rechnungFaellig('quartal', '2026-07', '2026-05')).toBe(true)
    expect(rechnungsBlockEnde('quartal', '2026-05', '2026-05')).toBe('2026-07')
    expect(rechnungsBlockEnde('quartal', '2026-08', '2026-05')).toBe('2026-10')
  })

  it('jahr: Block endet nach 12 Monaten, auch über den Jahreswechsel', () => {
    expect(rechnungsBlockEnde('jahr', '2026-09', '2026-09')).toBe('2027-08')
    expect(rechnungFaellig('jahr', '2027-08', '2026-09')).toBe(true)
    expect(rechnungFaellig('jahr', '2027-07', '2026-09')).toBe(false)
  })
})

describe('Wartungsvertrag: Eingabe-Schema', () => {
  const basis = {
    kasseId: '11111111-1111-4111-8111-111111111111',
    kundeId: '22222222-2222-4222-8222-222222222222',
    bezeichnung: 'Wartung Kassa',
    beginn: '2026-01-01',
    positionen: [{ bezeichnung: 'Support', einzelpreisBreutto: 5000, mwstSatz: 'normal' }],
  }

  it('setzt Standardwerte (monatlich, aktiv, Menge 1, Position erbt das Intervall)', () => {
    const r = WartungsvertragInputSchema.parse(basis)
    expect(r.rechnungsIntervall).toBe('monatlich')
    expect(r.status).toBe('aktiv')
    expect(r.positionen[0]).toMatchObject({ menge: 1 })
    expect(r.positionen[0]!.intervall).toBeUndefined()   // leer = wie das Rechnungsintervall des Vertrags
  })

  it('lehnt Ende vor Beginn und leere Positionen ab', () => {
    expect(WartungsvertragInputSchema.safeParse({ ...basis, ende: '2025-12-31' }).success).toBe(false)
    expect(WartungsvertragInputSchema.safeParse({ ...basis, positionen: [] }).success).toBe(false)
  })
})
