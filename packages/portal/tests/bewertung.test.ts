import { describe, it, expect } from 'vitest'
import type { BoxStatus, PortalMeldung } from '@kassa/shared'
import { PortalMeldungSchema } from '@kassa/shared'
import { bewerteBox, dauerText, schlechtesterStatus, ZERTIFIKAT_WARNUNG_TAGE } from '../src/services/bewertung.js'

const JETZT = new Date('2026-11-27T12:00:00.000Z')
const vor = (sek: number) => new Date(JETZT.getTime() - sek * 1000)
const inTagen = (tage: number) => new Date(JETZT.getTime() + tage * 86_400_000).toISOString()
const G = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

type Kasse = PortalMeldung['betriebe'][number]['kassen'][number]
type Drucker = PortalMeldung['betriebe'][number]['drucker'][number]

const kasse = (o: Partial<Kasse> = {}): Kasse => ({
  id: G(2), kassenId: 'K-001', bezeichnung: null, status: 'aktiv', umgebung: 'produktion', seeTyp: 'software',
  seeAusgefallenSeit: null, seeGueltigBis: inTagen(400), offeneBonProbleme: 0, ...o,
})
const drucker = (o: Partial<Drucker> = {}): Drucker => ({
  quelle: 'bonier', name: 'Küche', erreichbar: true, geprueftAm: JETZT.toISOString(), fehler: null, ...o,
})

/** Eine gesunde Meldung; einzelne Teile lassen sich überschreiben. */
function meldung(o: Partial<PortalMeldung> = {}, betrieb: { kassen?: Kasse[]; drucker?: Drucker[]; firmenname?: string } = {}): PortalMeldung {
  const m: PortalMeldung = {
    schema: 1,
    gesendetAm: JETZT.toISOString(),
    version: '0.8.100',
    uptimeSek: 3600,
    db: { ok: true, latenzMs: 3 },
    backups: {
      dbBackup:  { letzteSicherung: JETZT.toISOString(), alterStunden: 2, zustand: 'ok' },
      depBackup: { letzteSicherung: JETZT.toISOString(), alterStunden: 2, zustand: 'ok' },
    },
    speicher: { zustand: 'ok', gesamtGb: 100, freiGb: 60, freiProzent: 60 },
    betriebe: [{ id: G(1), firmenname: betrieb.firmenname ?? 'Gasthaus Zur Post', status: 'aktiv', kassen: betrieb.kassen ?? [kasse()], drucker: betrieb.drucker ?? [drucker()] }],
    fehler: [],
    ...o,
  }
  return PortalMeldungSchema.parse(m) // die Testmeldung muss selbst gültig sein
}

const bewerte = (m: PortalMeldung | null, gesehenVorSek: number | null = 30, offlineNach = 600) =>
  bewerteBox({ meldung: m, zuletztGesehen: gesehenVorSek === null ? null : vor(gesehenVorSek), jetzt: JETZT, offlineNachSekunden: offlineNach })

const codes = (m: PortalMeldung | null, ...rest: [number | null?, number?]) => bewerte(m, ...rest).gruende.map(g => `${g.stufe}:${g.code}`)

describe('Bewertung — Grundzustände', () => {
  it('noch nie gemeldet → neu', () => {
    expect(bewerte(null, null)).toEqual({ status: 'neu', gruende: [{ stufe: 'info', code: 'neu', text: 'Noch keine Meldung eingegangen.' }] })
    expect(bewerte(meldung(), null).status).toBe('neu')
  })

  it('gesunde Box → ok ohne Gründe', () => {
    expect(bewerte(meldung())).toEqual({ status: 'ok', gruende: [] })
  })

  it('offline ab der Schwelle (genau die Schwelle zählt noch nicht); es zählt nur dieser Grund', () => {
    expect(bewerte(meldung(), 600).status).toBe('ok')
    const b = bewerte(meldung({ db: { ok: false, latenzMs: null } }), 601)
    expect(b.status).toBe('offline')
    expect(b.gruende).toEqual([{ stufe: 'kritisch', code: 'offline', text: 'Keine Meldung seit 10 Minuten.' }])
  })

  it('die Schwelle ist einstellbar', () => {
    expect(bewerte(meldung(), 200, 120).status).toBe('offline')
    expect(bewerte(meldung(), 200, 300).status).toBe('ok')
  })
})

describe('Bewertung — Box', () => {
  it('Datenbank nicht erreichbar → kritisch; langsam (> 1 s) → Warnung', () => {
    expect(codes(meldung({ db: { ok: false, latenzMs: null } }))).toEqual(['kritisch:db'])
    expect(bewerte(meldung({ db: { ok: true, latenzMs: 1500 } })).status).toBe('warnung')
    expect(bewerte(meldung({ db: { ok: true, latenzMs: 1000 } })).status).toBe('ok')
  })

  it('Sicherungen: veraltet und fehlt sind Warnungen, mit lesbarem Alter', () => {
    const m = meldung({
      backups: {
        dbBackup:  { letzteSicherung: null, alterStunden: null, zustand: 'fehlt' },
        depBackup: { letzteSicherung: JETZT.toISOString(), alterStunden: 52, zustand: 'veraltet' },
      },
    })
    const b = bewerte(m)
    expect(b.status).toBe('warnung')
    expect(b.gruende.map(g => g.text)).toEqual([
      'Datenbank-Sicherung: noch keine vorhanden.',
      'DEP-Sicherung veraltet (zuletzt vor 2 Tagen).',
    ])
  })

  it('Speicher: kritisch, knapp, unbekannt (nur Info)', () => {
    const speicher = (zustand: PortalMeldung['speicher']['zustand'], freiGb: number | null) =>
      meldung({ speicher: { zustand, gesamtGb: 100, freiGb, freiProzent: freiGb } })
    expect(bewerte(speicher('kritisch', 1.234)).gruende[0]).toEqual({ stufe: 'kritisch', code: 'speicher', text: 'Speicherplatz fast voll (frei: 1,2 GB).' })
    expect(bewerte(speicher('knapp', 8)).status).toBe('warnung')
    const unbekannt = bewerte(speicher('unbekannt', null))
    expect(unbekannt.status).toBe('ok')
    expect(unbekannt.gruende.map(g => g.stufe)).toEqual(['info'])
  })
})

describe('Bewertung — Kassen', () => {
  it('Signatureinheit ausgefallen → kritisch, mit Dauer', () => {
    const m = meldung({}, { kassen: [kasse({ seeAusgefallenSeit: vor(3 * 3600).toISOString() })] })
    expect(bewerte(m).gruende[0]).toEqual({ stufe: 'kritisch', code: 'see', text: 'Signatureinheit ausgefallen seit 3 Stunden (Kasse K-001).' })
  })

  it('Zertifikat: abgelaufen kritisch, bald ablaufend Warnung, später nichts', () => {
    const mit = (iso: string) => meldung({}, { kassen: [kasse({ seeGueltigBis: iso })] })
    expect(codes(mit(inTagen(-1)))).toEqual(['kritisch:zertifikat'])
    expect(bewerte(mit(inTagen(10))).gruende[0]!.text).toBe('Signaturzertifikat läuft in 10 Tagen ab (Kasse K-001).')
    expect(bewerte(mit(inTagen(ZERTIFIKAT_WARNUNG_TAGE - 0.5))).status).toBe('warnung')
    expect(bewerte(mit(inTagen(ZERTIFIKAT_WARNUNG_TAGE + 1))).status).toBe('ok')
    expect(bewerte(mit(inTagen(0.2))).gruende[0]!.text).toContain('in 1 Tag ab')
  })

  it('ein unlesbares Datum bringt die Bewertung nicht zu Fall', () => {
    expect(bewerte(meldung({}, { kassen: [kasse({ seeGueltigBis: 'kein-datum' })] })).status).toBe('ok')
  })

  it('Bons nicht zugestellt → Warnung, Einzahl/Mehrzahl', () => {
    expect(bewerte(meldung({}, { kassen: [kasse({ offeneBonProbleme: 1 })] })).gruende[0]!.text).toBe('1 Bon nicht zugestellt (Kasse K-001).')
    expect(bewerte(meldung({}, { kassen: [kasse({ offeneBonProbleme: 4 })] })).gruende[0]!.text).toBe('4 Bons nicht zugestellt (Kasse K-001).')
  })

  it('stillgelegte Kassen sind kein Fehler, auch wenn ihre Werte schlecht sind', () => {
    const still = kasse({ status: 'ausser_betrieb', seeAusgefallenSeit: vor(86_400).toISOString(), seeGueltigBis: inTagen(-100), offeneBonProbleme: 9 })
    expect(bewerte(meldung({}, { kassen: [still] }))).toEqual({ status: 'ok', gruende: [] })
  })

  it('der Betriebsname steht nur dabei, wenn die Box mehrere Betriebe hat', () => {
    const k = kasse({ offeneBonProbleme: 1 })
    expect(bewerte(meldung({}, { kassen: [k] })).gruende[0]!.text).not.toContain('Gasthaus')
    const zwei = meldung({}, { kassen: [k] })
    zwei.betriebe.push({ ...zwei.betriebe[0]!, id: G(9), firmenname: 'Café Mitte', kassen: [kasse({ kassenId: 'K-002', offeneBonProbleme: 2 })] })
    expect(bewerte(zwei).gruende.map(g => g.text)).toEqual([
      '1 Bon nicht zugestellt (Kasse K-001, Gasthaus Zur Post).',
      '2 Bons nicht zugestellt (Kasse K-002, Café Mitte).',
    ])
  })
})

describe('Bewertung — Drucker und Fehler', () => {
  it('nicht erreichbare Drucker → Warnung, mit Art und Fehler', () => {
    const m = meldung({}, { drucker: [
      drucker({ quelle: 'bonier', name: 'Küche', erreichbar: false, fehler: 'Zeitüberschreitung' }),
      drucker({ quelle: 'beleg', name: 'Bar', erreichbar: false }),
      drucker({ name: 'Keller', erreichbar: true }),
    ] })
    expect(bewerte(m).gruende.map(g => g.text)).toEqual([
      'Bonierdrucker „Küche" nicht erreichbar: Zeitüberschreitung.',
      'Belegdrucker „Bar" nicht erreichbar.',
    ])
  })

  it('Serverfehler sind nur eine Info und ändern den Status nicht', () => {
    const f = (anzahl: number, hash: string) => ({ hash, name: 'Error', meldung: 'x', route: null, mandantId: null, anzahl, ersterAm: JETZT.toISOString(), letzterAm: JETZT.toISOString() })
    const b = bewerte(meldung({ fehler: [f(3, 'a'), f(2, 'b')] }))
    expect(b.status).toBe('ok')
    expect(b.gruende).toEqual([{ stufe: 'info', code: 'fehler', text: '5 Serverfehler seit der letzten Meldung (2 verschiedene).' }])
  })
})

describe('Bewertung — Reihenfolge und Zusammenfassung', () => {
  it('Gründe: kritisch vor Warnung vor Info; der Status folgt dem Schlimmsten', () => {
    const m = meldung({
      db: { ok: false, latenzMs: null },
      speicher: { zustand: 'unbekannt', gesamtGb: null, freiGb: null, freiProzent: null },
      backups: { dbBackup: { letzteSicherung: null, alterStunden: null, zustand: 'fehlt' }, depBackup: { letzteSicherung: JETZT.toISOString(), alterStunden: 1, zustand: 'ok' } },
    })
    const b = bewerte(m)
    expect(b.status).toBe('kritisch')
    expect(b.gruende.map(g => g.stufe)).toEqual(['kritisch', 'warnung', 'info'])
  })

  it('schlechtester Status eines Betriebs: offline > kritisch > warnung > neu > ok; leer = ok', () => {
    const s = (...l: BoxStatus[]) => schlechtesterStatus(l)
    expect(s()).toBe('ok')
    expect(s('ok', 'ok')).toBe('ok')
    expect(s('ok', 'neu')).toBe('neu')
    expect(s('neu', 'warnung', 'ok')).toBe('warnung')
    expect(s('warnung', 'kritisch')).toBe('kritisch')
    expect(s('kritisch', 'offline', 'ok')).toBe('offline')
  })

  it('Dauer in lesbarer Form', () => {
    expect(dauerText(1)).toBe('1 Sekunde')
    expect(dauerText(45)).toBe('45 Sekunden')
    expect(dauerText(60)).toBe('1 Minute')
    expect(dauerText(600)).toBe('10 Minuten')
    expect(dauerText(3600)).toBe('1 Stunde')
    expect(dauerText(5 * 3600)).toBe('5 Stunden')
    expect(dauerText(86_400)).toBe('1 Tag')
    expect(dauerText(3 * 86_400)).toBe('3 Tagen')
    expect(dauerText(-5)).toBe('0 Sekunden')
  })
})
