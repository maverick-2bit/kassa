import { describe, it, expect } from 'vitest'
import {
  imZeitfenster,
  imAnyZeitfenster,
  isoWochentag,
  datumISO,
  regelGiltJetzt,
  aktiverRabattProzent,
  aktiverFixpreisCent,
  aktiveAktion,
  aktionsPreisCent,
  happyHourPreisCent,
  preisregelFehler,
  endeNachAktionstagen,
  verbleibendeAktionstage,
  mengenRabattZeilen,
  aktiveMengenAktion,
  PreisregelInputSchema,
  type MengenPosition,
  type Preisregel,
  type PreisregelPruefung,
} from './preisregel.js'

const mkRegel = (over: Partial<Preisregel> = {}): Preisregel => ({
  id:            '00000000-0000-0000-0000-000000000001',
  name:          'Happy Hour',
  aktiv:         true,
  wochentage:    [1, 2, 3, 4, 5],
  datumTage:     [],
  zeitfenster:   [{ von: '17:00', bis: '19:00' }],
  gueltigVon:    null,
  gueltigBis:    null,
  rabattProzent: 20,
  artikelPreise: [],
  kategorieIds:  [],
  artikelIds:    [],
  mengeKauf:     null,
  mengeZahle:    null,
  mengeModus:    null,
  wiederholungen: null,
  createdAt:     '',
  updatedAt:     '',
  ...over,
})

// 6. Juli 2026 = Montag, 11. Juli 2026 = Samstag (lokale Zeit)
const mo18 = new Date(2026, 6, 6, 18, 0)
const mo16 = new Date(2026, 6, 6, 16, 0)
const mo13 = new Date(2026, 6, 6, 13, 0)
const mo19 = new Date(2026, 6, 6, 19, 0)
const sa18 = new Date(2026, 6, 11, 18, 0)

describe('imZeitfenster', () => {
  it('innerhalb des Fensters', () => expect(imZeitfenster('17:00', '19:00', mo18)).toBe(true))
  it('davor', () => expect(imZeitfenster('17:00', '19:00', mo16)).toBe(false))
  it('obere Grenze ist exklusiv', () => expect(imZeitfenster('17:00', '19:00', mo19)).toBe(false))
  it('über Mitternacht (von > bis)', () => {
    expect(imZeitfenster('22:00', '02:00', new Date(2026, 6, 6, 23, 0))).toBe(true)
    expect(imZeitfenster('22:00', '02:00', new Date(2026, 6, 6, 1, 0))).toBe(true)
    expect(imZeitfenster('22:00', '02:00', new Date(2026, 6, 6, 12, 0))).toBe(false)
  })
})

describe('imAnyZeitfenster / mehrere Fenster', () => {
  const fenster = [{ von: '12:00', bis: '14:00' }, { von: '18:00', bis: '20:00' }]
  it('erstes Fenster', () => expect(imAnyZeitfenster(fenster, mo13)).toBe(true))
  it('zweites Fenster', () => expect(imAnyZeitfenster(fenster, mo18)).toBe(true))
  it('zwischen den Fenstern', () => expect(imAnyZeitfenster(fenster, mo16)).toBe(false))
})

describe('isoWochentag / datumISO', () => {
  it('Montag = 1', () => expect(isoWochentag(mo18)).toBe(1))
  it('Samstag = 6', () => expect(isoWochentag(sa18)).toBe(6))
  it('datumISO lokal', () => expect(datumISO(mo18)).toBe('2026-07-06'))
})

describe('regelGiltJetzt — Zeit/Tag', () => {
  it('gilt Mo 18 Uhr', () => expect(regelGiltJetzt(mkRegel(), 'a1', null, mo18)).toBe(true))
  it('gilt nicht Sa (nicht in wochentage)', () => expect(regelGiltJetzt(mkRegel(), 'a1', null, sa18)).toBe(false))
  it('gilt nicht außerhalb der Zeit', () => expect(regelGiltJetzt(mkRegel(), 'a1', null, mo16)).toBe(false))
  it('inaktive Regel gilt nie', () => expect(regelGiltJetzt(mkRegel({ aktiv: false }), 'a1', null, mo18)).toBe(false))
})

describe('regelGiltJetzt — mehrere Zeitfenster', () => {
  const r = mkRegel({ zeitfenster: [{ von: '12:00', bis: '14:00' }, { von: '18:00', bis: '20:00' }] })
  it('gilt im Mittagsfenster', () => expect(regelGiltJetzt(r, 'a1', null, mo13)).toBe(true))
  it('gilt im Abendfenster', () => expect(regelGiltJetzt(r, 'a1', null, mo18)).toBe(true))
  it('gilt nicht dazwischen', () => expect(regelGiltJetzt(r, 'a1', null, mo16)).toBe(false))
})

describe('regelGiltJetzt — konkrete Kalendertage', () => {
  const r = mkRegel({ wochentage: [], datumTage: ['2026-07-11'] }) // nur Sa 11.7.
  it('gilt am konkreten Datum', () => expect(regelGiltJetzt(r, 'a1', null, sa18)).toBe(true))
  it('gilt nicht an anderem Datum', () => expect(regelGiltJetzt(r, 'a1', null, mo18)).toBe(false))
  it('Wochentag ODER Datum', () => {
    const r2 = mkRegel({ wochentage: [1], datumTage: ['2026-07-11'] })
    expect(regelGiltJetzt(r2, 'a1', null, mo18)).toBe(true) // Montag
    expect(regelGiltJetzt(r2, 'a1', null, sa18)).toBe(true) // konkretes Datum
  })
})

describe('regelGiltJetzt — Aktionszeitraum', () => {
  it('innerhalb des Zeitraums', () =>
    expect(regelGiltJetzt(mkRegel({ gueltigVon: '2026-07-01', gueltigBis: '2026-07-31' }), 'a1', null, mo18)).toBe(true))
  it('vor dem Zeitraum', () =>
    expect(regelGiltJetzt(mkRegel({ gueltigVon: '2026-08-01' }), 'a1', null, mo18)).toBe(false))
  it('nach dem Zeitraum', () =>
    expect(regelGiltJetzt(mkRegel({ gueltigBis: '2026-06-30' }), 'a1', null, mo18)).toBe(false))
})

describe('regelGiltJetzt — Geltungsbereich', () => {
  it('leer+leer gilt für alle Artikel', () => expect(regelGiltJetzt(mkRegel(), 'aX', 'kX', mo18)).toBe(true))
  it('Warengruppe: passende Kategorie', () => expect(regelGiltJetzt(mkRegel({ kategorieIds: ['k1'] }), 'a1', 'k1', mo18)).toBe(true))
  it('Warengruppe: andere Kategorie', () => expect(regelGiltJetzt(mkRegel({ kategorieIds: ['k1'] }), 'a1', 'k2', mo18)).toBe(false))
  it('Einzel-Artikel: passender Artikel', () => expect(regelGiltJetzt(mkRegel({ artikelIds: ['a1'] }), 'a1', 'k9', mo18)).toBe(true))
  it('Einzel-Artikel: anderer Artikel', () => expect(regelGiltJetzt(mkRegel({ artikelIds: ['a1'] }), 'a2', 'k9', mo18)).toBe(false))
})

describe('happyHourPreisCent / aktiverRabattProzent', () => {
  it('wendet den Rabatt an', () => expect(happyHourPreisCent(500, [mkRegel()], 'a1', null, mo18)).toBe(400))
  it('rundet kaufmännisch', () => expect(happyHourPreisCent(319, [mkRegel({ rabattProzent: 20 })], 'a1', null, mo18)).toBe(255)) // 255.2
  it('kein Rabatt außerhalb', () => expect(happyHourPreisCent(500, [mkRegel()], 'a1', null, mo16)).toBe(500))
  it('größter passender Rabatt gewinnt', () =>
    expect(aktiverRabattProzent([mkRegel({ rabattProzent: 10 }), mkRegel({ rabattProzent: 30 })], 'a1', null, mo18)).toBe(30))
})

describe('Aktionspreise (fixer Preis je Artikel)', () => {
  const mitFixpreis = (preisCent: number, artikelId = 'a1', over: Partial<Preisregel> = {}) =>
    mkRegel({ rabattProzent: 0, artikelPreise: [{ artikelId, preisCent }], ...over })

  it('fixer Preis ersetzt den Basispreis', () =>
    expect(aktionsPreisCent(950, [mitFixpreis(750)], 'a1', null, mo18)).toBe(750))

  it('gilt nur für den hinterlegten Artikel', () =>
    expect(aktionsPreisCent(950, [mitFixpreis(750, 'a1')], 'a2', null, mo18)).toBe(950))

  it('außerhalb des Zeitfensters bleibt der Basispreis', () =>
    expect(aktionsPreisCent(950, [mitFixpreis(750)], 'a1', null, mo16)).toBe(950))

  it('niedrigster Fixpreis gewinnt', () =>
    expect(aktiverFixpreisCent([mitFixpreis(800), mitFixpreis(700)], 'a1', null, mo18)).toBe(700))

  it('Fixpreis schlägt den Prozent-Rabatt (auch wenn Prozent günstiger wäre)', () =>
    expect(aktionsPreisCent(1000, [
      mitFixpreis(900),
      mkRegel({ rabattProzent: 50 }),
    ], 'a1', null, mo18)).toBe(900))

  it('ohne Fixpreis greift weiterhin der Prozentsatz', () =>
    expect(aktionsPreisCent(1000, [mitFixpreis(900, 'a9'), mkRegel({ rabattProzent: 25 })], 'a1', null, mo18)).toBe(750))

  it('aktiveAktion meldet den Typ für die Kassen-Badge', () => {
    expect(aktiveAktion([mitFixpreis(750)], 'a1', null, mo18)).toEqual({ typ: 'fix', preisCent: 750 })
    expect(aktiveAktion([mkRegel({ rabattProzent: 15 })], 'a1', null, mo18)).toEqual({ typ: 'prozent', prozent: 15 })
    expect(aktiveAktion([mkRegel()], 'a1', null, mo16)).toBeNull()
  })

  it('happyHourPreisCent bleibt als Alias kompatibel', () =>
    expect(happyHourPreisCent(1000, [mkRegel({ rabattProzent: 20 })], 'a1', null, mo18)).toBe(800))
})

// ---------------------------------------------------------------------------
// Wiederholung: Enddatum aus „nach X Aktionstagen"
// ---------------------------------------------------------------------------

describe('endeNachAktionstagen', () => {
  // 2026-07-06 ist ein Montag
  it('Montags, 4 Aktionstage → der vierte Montag ab dem Start (inklusive Starttag)', () => {
    expect(endeNachAktionstagen('2026-07-06', [1], 1)).toBe('2026-07-06')
    expect(endeNachAktionstagen('2026-07-06', [1], 4)).toBe('2026-07-27')
  })
  it('Startdatum, das selbst kein Aktionstag ist: gezählt wird ab dem nächsten passenden Tag', () => {
    expect(endeNachAktionstagen('2026-07-07', [1], 1)).toBe('2026-07-13')   // Dienstag → nächster Montag
  })
  it('mehrere Wochentage zählen jeder Tag einzeln mit (Mo+Mi, 4 → Mo, Mi, Mo, Mi)', () => {
    expect(endeNachAktionstagen('2026-07-06', [1, 3], 4)).toBe('2026-07-15')
    expect(endeNachAktionstagen('2026-07-06', [3, 1], 3)).toBe('2026-07-13')
  })
  it('Sonntag ist 7; über Monats- und Jahreswechsel; Schaltjahr', () => {
    expect(endeNachAktionstagen('2026-12-27', [7], 2)).toBe('2027-01-03')
    expect(endeNachAktionstagen('2028-02-26', [2], 1)).toBe('2028-02-29')
  })
  it('Sommerzeitumstellung verschiebt nichts (reine Kalenderrechnung)', () => {
    // 2026-03-29 = Sonntag mit Umstellung auf Sommerzeit
    expect(endeNachAktionstagen('2026-03-22', [7], 2)).toBe('2026-03-29')
    expect(endeNachAktionstagen('2026-03-22', [7], 3)).toBe('2026-04-05')
  })
  it('ungültige Eingaben → null', () => {
    expect(endeNachAktionstagen('2026-07-06', [], 3)).toBeNull()
    expect(endeNachAktionstagen('2026-07-06', [1], 0)).toBeNull()
    expect(endeNachAktionstagen('06.07.2026', [1], 1)).toBeNull()
  })
  it('große Anzahl bei einem Wochentag (500 Montage) wird gefunden', () => {
    const ende = endeNachAktionstagen('2026-07-06', [1], 500)!
    expect(ende > '2035-01-01').toBe(true)
  })
})

describe('verbleibendeAktionstage', () => {
  const r = { wochentage: [1], gueltigVon: '2026-07-06', gueltigBis: '2026-07-27' }
  it('zählt die Aktionstage ab heute bis zum Ende, einschließlich beider Grenzen', () => {
    expect(verbleibendeAktionstage(r, '2026-07-01')).toBe(4)    // vor dem Start: alle vier
    expect(verbleibendeAktionstage(r, '2026-07-06')).toBe(4)
    expect(verbleibendeAktionstage(r, '2026-07-07')).toBe(3)
    expect(verbleibendeAktionstage(r, '2026-07-27')).toBe(1)
  })
  it('nach dem Ende 0; ohne Ende oder ohne Wochentage null', () => {
    expect(verbleibendeAktionstage(r, '2026-07-28')).toBe(0)
    expect(verbleibendeAktionstage({ ...r, gueltigBis: null }, '2026-07-06')).toBeNull()
    expect(verbleibendeAktionstage({ ...r, wochentage: [] }, '2026-07-06')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Querprüfung (preisregelFehler / Eingabe-Schema)
// ---------------------------------------------------------------------------

describe('preisregelFehler', () => {
  const basis: PreisregelPruefung = { wochentage: [1], datumTage: [], rabattProzent: 20, artikelPreise: [], mengeKauf: null, mengeZahle: null, mengeModus: null, wiederholungen: null, gueltigVon: null, gueltigBis: null }
  it('gültige Preisaktion und gültige Mengenaktion', () => {
    expect(preisregelFehler({ ...basis })).toBeNull()
    expect(preisregelFehler({ ...basis, rabattProzent: 0, mengeKauf: 3, mengeZahle: 2, mengeModus: 'artikel' })).toBeNull()
  })
  it('Mengenaktion: „zahle" muss kleiner als „kaufe" sein; alle drei Felder zusammen', () => {
    expect(preisregelFehler({ ...basis, rabattProzent: 0, mengeKauf: 3, mengeZahle: 3, mengeModus: 'artikel' })).toMatch(/kleiner/)
    expect(preisregelFehler({ ...basis, rabattProzent: 0, mengeKauf: 3, mengeZahle: null, mengeModus: 'artikel' })).toMatch(/zusammen/)
    expect(preisregelFehler({ ...basis, rabattProzent: 0, mengeKauf: 3, mengeZahle: 2, mengeModus: null })).toMatch(/zusammen/)
  })
  it('Mengenaktion und Prozent-Rabatt/Aktionspreise schließen sich aus; ohne beides ist die Preisaktion leer', () => {
    expect(preisregelFehler({ ...basis, mengeKauf: 3, mengeZahle: 2, mengeModus: 'artikel' })).toMatch(/eigene Aktion/)
    expect(preisregelFehler({ ...basis, rabattProzent: 0, artikelPreise: [{ artikelId: 'x', preisCent: 1 }], mengeKauf: 3, mengeZahle: 2, mengeModus: 'auswahl' })).toMatch(/eigene Aktion/)
    expect(preisregelFehler({ ...basis, rabattProzent: 0 })).toMatch(/Prozent-Rabatt oder/)
  })
  it('Wiederholungen brauchen Wochentage und Startdatum; Ende vor Start ist ungültig; ohne Tag ungültig', () => {
    expect(preisregelFehler({ ...basis, wiederholungen: 4, gueltigVon: '2026-07-06' })).toBeNull()
    expect(preisregelFehler({ ...basis, wiederholungen: 4 })).toMatch(/Startdatum/)
    expect(preisregelFehler({ ...basis, wochentage: [], datumTage: ['2026-07-06'], wiederholungen: 4, gueltigVon: '2026-07-06' })).toMatch(/Wochentagen/)
    expect(preisregelFehler({ ...basis, gueltigVon: '2026-07-10', gueltigBis: '2026-07-01' })).toMatch(/vor/)
    expect(preisregelFehler({ ...basis, wochentage: [], datumTage: [] })).toMatch(/Wochentag/)
  })
  it('Eingabe-Schema nutzt dieselbe Prüfung', () => {
    const ok = PreisregelInputSchema.safeParse({ name: '3 für 2', wochentage: [1], zeitfenster: [{ von: '08:00', bis: '18:00' }], rabattProzent: 0, mengeKauf: 3, mengeZahle: 2, mengeModus: 'auswahl' })
    expect(ok.success).toBe(true)
    const schlecht = PreisregelInputSchema.safeParse({ name: 'x', wochentage: [1], zeitfenster: [{ von: '08:00', bis: '18:00' }], rabattProzent: 0, mengeKauf: 2, mengeZahle: 2, mengeModus: 'artikel' })
    expect(schlecht.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mengenaktion „X zum Preis von Y"
// ---------------------------------------------------------------------------

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const C = '00000000-0000-0000-0000-00000000000c'
const KAT = '00000000-0000-0000-0000-0000000000f1'

const mengen = (over: Partial<Preisregel> = {}) => mkRegel({
  id: '00000000-0000-0000-0000-0000000000m1'.replace('m', '1'), name: '3 für 2', rabattProzent: 0,
  mengeKauf: 3, mengeZahle: 2, mengeModus: 'artikel', wochentage: [1], zeitfenster: [{ von: '08:00', bis: '20:00' }], ...over,
})
const pos = (artikelId: string, menge: number, preisCent: number, extra: Partial<MengenPosition> = {}): MengenPosition =>
  ({ artikelId, kategorieId: KAT, bezeichnung: `Art ${artikelId.slice(-1)}`, mwstSatz: 'normal', menge, preisCent, ...extra })

describe('mengenRabattZeilen — Zählweise „je gleichem Artikel"', () => {
  it('3 gleiche Artikel → 1 gratis; 2 → keiner; 6 → 2; 7 → 2', () => {
    expect(mengenRabattZeilen([mengen()], [pos(A, 3, 800)], mo13)).toEqual([
      { regelId: expect.any(String), regelName: '3 für 2', bezeichnung: '3 für 2 (3 für 2): Art a', mwstSatz: 'normal', menge: 1, preisCent: -800 },
    ])
    expect(mengenRabattZeilen([mengen()], [pos(A, 2, 800)], mo13)).toEqual([])
    expect(mengenRabattZeilen([mengen()], [pos(A, 6, 800)], mo13)[0]!.menge).toBe(2)
    expect(mengenRabattZeilen([mengen()], [pos(A, 7, 800)], mo13)[0]!.menge).toBe(2)
  })
  it('verschiedene Artikel werden NICHT zusammengezählt (je 2 von A und B → nichts)', () => {
    expect(mengenRabattZeilen([mengen()], [pos(A, 2, 800), pos(B, 2, 500)], mo13)).toEqual([])
  })
  it('derselbe Artikel in zwei Positionen (z. B. mit/ohne Option) zählt zusammen; die günstigste Einheit ist gratis', () => {
    const z = mengenRabattZeilen([mengen()], [pos(A, 2, 800), pos(A, 1, 650)], mo13)
    expect(z).toHaveLength(1)
    expect(z[0]).toMatchObject({ menge: 1, preisCent: -650 })
  })
  it('X für 1 (z. B. 4 für 1) und 5 für 3', () => {
    expect(mengenRabattZeilen([mengen({ mengeKauf: 4, mengeZahle: 1 })], [pos(A, 4, 100)], mo13)[0]).toMatchObject({ menge: 3 })
    expect(mengenRabattZeilen([mengen({ mengeKauf: 5, mengeZahle: 3 })], [pos(A, 5, 100)], mo13)[0]).toMatchObject({ menge: 2 })
  })
})

describe('mengenRabattZeilen — Zählweise „über die ganze Auswahl"', () => {
  const auswahl = () => mengen({ mengeModus: 'auswahl' })
  it('beliebige 3 Artikel der Auswahl → der günstigste ist gratis', () => {
    const z = mengenRabattZeilen([auswahl()], [pos(A, 1, 800), pos(B, 1, 500), pos(C, 1, 650)], mo13)
    expect(z).toHaveLength(1)
    expect(z[0]).toMatchObject({ bezeichnung: '3 für 2 (3 für 2): Art b', menge: 1, preisCent: -500 })
  })
  it('6 Einheiten → zwei Gruppen; Gruppen bilden sich nach Preis absteigend (die Teuren zusammen)', () => {
    // 900 900 900 | 300 300 300 → je Gruppe eine gratis: 900 und 300
    const z = mengenRabattZeilen([auswahl()], [pos(A, 3, 900), pos(B, 3, 300)], mo13)
    expect(z.map(x => [x.preisCent, x.menge]).sort()).toEqual([[-300, 1], [-900, 1]].sort())
  })
  it('weniger als X Einheiten → nichts; Rest nach vollen Gruppen bekommt nichts', () => {
    expect(mengenRabattZeilen([auswahl()], [pos(A, 1, 800), pos(B, 1, 500)], mo13)).toEqual([])
    expect(mengenRabattZeilen([auswahl()], [pos(A, 4, 100)], mo13)[0]!.menge).toBe(1)
  })
  it('nur Artikel im Geltungsbereich zählen (Warengruppe/Artikel)', () => {
    const regel = auswahl()
    const nurKat = { ...regel, kategorieIds: [KAT] }
    const andere = '00000000-0000-0000-0000-0000000000f2'
    expect(mengenRabattZeilen([nurKat], [pos(A, 2, 800), pos(B, 1, 500, { kategorieId: andere })], mo13)).toEqual([])
    expect(mengenRabattZeilen([nurKat], [pos(A, 2, 800), pos(B, 1, 500)], mo13)).toHaveLength(1)
    const nurArtikel = { ...regel, artikelIds: [A] }
    expect(mengenRabattZeilen([nurArtikel], [pos(A, 2, 800), pos(B, 1, 500)], mo13)).toEqual([])
  })
})

describe('mengenRabattZeilen — Zeit, Ausnahmen, Steuer, Überschneidung', () => {
  it('nur im Aktionszeitfenster und an den Aktionstagen', () => {
    const r = mengen()
    expect(mengenRabattZeilen([r], [pos(A, 3, 800)], mo13)).toHaveLength(1)
    expect(mengenRabattZeilen([r], [pos(A, 3, 800)], new Date(2026, 6, 6, 21, 0))).toEqual([])   // nach 20 Uhr
    expect(mengenRabattZeilen([r], [pos(A, 3, 800)], sa18)).toEqual([])                         // Samstag
    expect(mengenRabattZeilen([mengen({ aktiv: false })], [pos(A, 3, 800)], mo13)).toEqual([])
  })
  it('Ende nach Aktionstagen wirkt über gueltigBis', () => {
    expect(mengenRabattZeilen([mengen({ gueltigVon: '2026-07-06', gueltigBis: '2026-07-06' })], [pos(A, 3, 800)], mo13)).toHaveLength(1)
    expect(mengenRabattZeilen([mengen({ gueltigVon: '2026-06-01', gueltigBis: '2026-06-30' })], [pos(A, 3, 800)], mo13)).toEqual([])
  })
  it('ausgenommene Positionen (von Hand rabattiert), Gratis- und Negativpreise zählen nicht mit', () => {
    expect(mengenRabattZeilen([mengen()], [pos(A, 3, 800, { ausgenommen: true })], mo13)).toEqual([])
    expect(mengenRabattZeilen([mengen()], [pos(A, 3, 0)], mo13)).toEqual([])
    expect(mengenRabattZeilen([mengen()], [pos(A, 3, -200)], mo13)).toEqual([])
    // von drei Einheiten ist eine ausgenommen → nur 2 zählen → kein Gratis
    expect(mengenRabattZeilen([mengen()], [pos(A, 2, 800), pos(A, 1, 800, { ausgenommen: true })], mo13)).toEqual([])
  })
  it('Steuersatz des Artikels steht auf der Rabattzeile (gemischte Sätze bleiben getrennt)', () => {
    const regel = mengen({ mengeModus: 'auswahl' })
    const z = mengenRabattZeilen([regel], [pos(A, 1, 800, { mwstSatz: 'ermaessigt1' }), pos(B, 1, 500, { mwstSatz: 'normal' }), pos(C, 1, 650, { mwstSatz: 'normal' })], mo13)
    expect(z).toHaveLength(1)
    expect(z[0]).toMatchObject({ mwstSatz: 'normal', preisCent: -500 })      // der günstigste ist Artikel B (20 %)
  })
  it('gleicher Artikel zu zwei Preisen ergibt zwei getrennte Zeilen, wenn beide Einheiten gratis fallen', () => {
    const z = mengenRabattZeilen([mengen({ mengeKauf: 2, mengeZahle: 1 })], [pos(A, 2, 800), pos(A, 2, 400)], mo13)
    expect(z.map(x => [x.menge, x.preisCent]).sort()).toEqual([[1, -400], [1, -800]].sort())
  })
  it('überschneidende Aktionen: eine Einheit nimmt nur an der besten teil (kein doppelter Nachlass)', () => {
    const drei = mengen({ id: '00000000-0000-0000-0000-000000000002', name: '3 für 2' })
    const zwei = mengen({ id: '00000000-0000-0000-0000-000000000003', name: '2 für 1', mengeKauf: 2, mengeZahle: 1 })
    // 3 Einheiten: „2 für 1" (Nachlassanteil 50 %) gewinnt gegen „3 für 2" (33 %) und verbraucht 2; die dritte bleibt allein
    const z = mengenRabattZeilen([drei, zwei], [pos(A, 3, 600)], mo13)
    expect(z).toHaveLength(1)
    expect(z[0]).toMatchObject({ regelName: '2 für 1', menge: 1 })
  })
  it('ohne Mengenaktionen oder bei leerem Warenkorb → leer', () => {
    expect(mengenRabattZeilen([mkRegel()], [pos(A, 3, 800)], mo13)).toEqual([])
    expect(mengenRabattZeilen([mengen()], [], mo13)).toEqual([])
  })
  it('Preisaktionen bleiben von Mengenaktionen unberührt (Prozent 0, keine Fixpreise)', () => {
    const r = mengen()
    expect(aktiverRabattProzent([r], A, KAT, mo13)).toBe(0)
    expect(aktiverFixpreisCent([r], A, KAT, mo13)).toBeNull()
    expect(aktionsPreisCent(800, [r], A, KAT, mo13)).toBe(800)
  })
})

describe('aktiveMengenAktion (Hinweis an der Kasse)', () => {
  it('liefert die gerade geltende Aktion für den Artikel, sonst null; bei mehreren die mit dem größten Nachlassanteil', () => {
    expect(aktiveMengenAktion([mengen()], A, KAT, mo13)).toEqual({ kauf: 3, zahle: 2 })
    expect(aktiveMengenAktion([mengen()], A, KAT, sa18)).toBeNull()
    expect(aktiveMengenAktion([mkRegel()], A, KAT, mo18)).toBeNull()
    const zwei = mengen({ id: '00000000-0000-0000-0000-000000000003', mengeKauf: 2, mengeZahle: 1 })
    expect(aktiveMengenAktion([mengen(), zwei], A, KAT, mo13)).toEqual({ kauf: 2, zahle: 1 })
  })
})
