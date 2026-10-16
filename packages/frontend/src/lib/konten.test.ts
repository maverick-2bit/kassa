import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  entferneKonto, hatEinstellungsRecht, kasseFuerAnmeldung, ladeKonten, legeZurSeite, merkeAnmeldung, merkeKasse,
  mitKasse, nachAnmeldung, nimmAuf, ohneSitzungen, sitzungGueltig, speichereKonten, tokenAblauf, verwirfSitzungen,
  wechsle, type AktiveSitzung, type Konto, type Sitzung,
} from './konten'

/** „Jetzt" in den Tests: fester Zeitpunkt (ms) */
const JETZT = 1_800_000_000_000
const STUNDE = 3_600_000

/** Ein Token mit Ablaufzeit (exp in Sekunden); die Signatur spielt keine Rolle. */
function token(ablaufMs: number | null): string {
  const nutzlast = btoa(JSON.stringify(ablaufMs === null ? { sub: 'x' } : { sub: 'x', exp: Math.floor(ablaufMs / 1000) }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `kopf.${nutzlast}.signatur`
}

/** Eine Sitzung mit genau den Feldern, die konten.ts liest. */
function sitzung(mandant: string, opt: { admin?: boolean; ablauf?: number | null; kassen?: string[]; geraet?: string } = {}): Sitzung {
  const admin = opt.admin ?? true
  return {
    token: token(opt.ablauf === undefined ? JETZT + 8 * STUNDE : opt.ablauf),
    ...(opt.geraet ? { geraetToken: opt.geraet } : {}),
    user: { name: `Benutzer ${mandant}`, rolle: admin ? 'admin' : 'kellner', berechtigungen: admin ? ['einstellungen', 'kasse'] : ['kasse'] },
    mandant: { id: mandant, firmenname: `Firma ${mandant}` },
    kassen: (opt.kassen ?? [`${mandant}-k1`]).map(id => ({ id, kassenId: id.toUpperCase(), bezeichnung: null, umgebung: 'test' })),
  } as unknown as Sitzung
}

const aktiv = (s: Sitzung, kasseId: string | null = null): AktiveSitzung => ({ sitzung: s, kasseId })

function konto(mandant: string, ueberschreibe: Partial<Konto> = {}): Konto {
  return {
    mandantId: mandant, firmenname: `Firma ${mandant}`, kassen: [{ id: `${mandant}-k1`, kassenId: `${mandant}-K1`, bezeichnung: null }],
    kasseId: `${mandant}-k1`, benutzer: `Benutzer ${mandant}`, geraetToken: null, sitzung: null, ...ueberschreibe,
  }
}

const mandanten = (konten: readonly Konto[]) => konten.map(k => k.mandantId)

describe('hatEinstellungsRecht: wessen Sitzung darf gemerkt werden?', () => {
  it('Admin ja; Kellner nur mit dem Recht „einstellungen"', () => {
    expect(hatEinstellungsRecht({ rolle: 'admin', berechtigungen: [] })).toBe(true)
    expect(hatEinstellungsRecht({ rolle: 'kellner', berechtigungen: ['einstellungen'] })).toBe(true)
    expect(hatEinstellungsRecht({ rolle: 'kellner', berechtigungen: ['kasse', 'tische'] })).toBe(false)
  })
})

describe('Ablauf einer Sitzung', () => {
  it('tokenAblauf liest exp (in Sekunden) als Millisekunden; sonst null', () => {
    expect(tokenAblauf(token(JETZT))).toBe(JETZT)
    expect(tokenAblauf(token(null))).toBeNull()
    expect(tokenAblauf('kein-token')).toBeNull()
    expect(tokenAblauf('a.%%%.c')).toBeNull()
  })

  it('gültig, solange mehr als eine Minute bleibt; ohne lesbares Ablaufdatum entscheidet der Server', () => {
    expect(sitzungGueltig(sitzung('a', { ablauf: JETZT + STUNDE }), JETZT)).toBe(true)
    expect(sitzungGueltig(sitzung('a', { ablauf: JETZT + 30_000 }), JETZT)).toBe(false)     // läuft gleich ab
    expect(sitzungGueltig(sitzung('a', { ablauf: JETZT - STUNDE }), JETZT)).toBe(false)
    expect(sitzungGueltig(sitzung('a', { ablauf: null }), JETZT)).toBe(true)
    expect(sitzungGueltig(null, JETZT)).toBe(false)
  })
})

describe('nachAnmeldung: Konto merken, Sitzungen zur Seite legen oder verwerfen', () => {
  it('ein neues Konto wird aufgenommen — mit Kassen, erster Kasse, Benutzer und ohne Sitzung (die ist aktiv)', () => {
    const neu = nachAnmeldung([], sitzung('a', { kassen: ['a1', 'a2'], geraet: 'g-a' }), null, null)
    expect(neu).toEqual([{
      mandantId: 'a', firmenname: 'Firma a', kassen: [
        { id: 'a1', kassenId: 'A1', bezeichnung: null }, { id: 'a2', kassenId: 'A2', bezeichnung: null }],
      kasseId: 'a1', benutzer: 'Benutzer a', geraetToken: 'g-a', sitzung: null,
    }])
  })

  it('die bisherige Admin-Sitzung eines ANDEREN Mandanten wird zur Seite gelegt — mit der Kasse dieses Geräts', () => {
    const a = sitzung('a', { kassen: ['a1', 'a2'] })
    const neu = nachAnmeldung(nimmAuf([], a, 'a2'), sitzung('b'), aktiv(a, 'a2'), null)
    expect(mandanten(neu)).toEqual(['a', 'b'])
    expect(neu[0]!.sitzung).toBe(a)
    expect(neu[0]!.kasseId).toBe('a2')
    expect(neu[1]!.sitzung).toBeNull()
  })

  it('dieselbe Anmeldung noch einmal (gleicher Mandant): nichts wird zur Seite gelegt', () => {
    const a = sitzung('a')
    const neu = nachAnmeldung(nimmAuf([], a, null), sitzung('a'), aktiv(a), null)
    expect(neu.map(k => k.sitzung)).toEqual([null])
  })

  it('wer kein Einstellungs-Recht hat, lässt nichts liegen: alle gemerkten Sitzungen werden verworfen', () => {
    const a = sitzung('a')
    const vorher = [konto('a'), konto('c', { sitzung: sitzung('c') })]
    const neu = nachAnmeldung(vorher, sitzung('b', { admin: false }), aktiv(a), null)
    expect(neu.every(k => k.sitzung === null)).toBe(true)
    expect(mandanten(neu)).toEqual(['a', 'c', 'b'])                  // die Konten (ohne Geheimnisse) bleiben
  })

  it('die bisherige Sitzung eines Kassiers wird nicht gemerkt', () => {
    const kassier = sitzung('a', { admin: false })
    const neu = nachAnmeldung(nimmAuf([], kassier, null), sitzung('b'), aktiv(kassier), null)
    expect(neu.every(k => k.sitzung === null)).toBe(true)
  })

  it('behält Kasse und Geräte-Merkmal des Kontos; eine Kasse, die der Benutzer nicht mehr hat, fällt auf die erste zurück', () => {
    const vorher = [konto('a', { kassen: [{ id: 'a1', kassenId: 'A1', bezeichnung: null }, { id: 'a2', kassenId: 'A2', bezeichnung: null }], kasseId: 'a2', geraetToken: 'g-alt' })]
    expect(nachAnmeldung(vorher, sitzung('a', { kassen: ['a1', 'a2'] }), null, null)[0]).toMatchObject({ kasseId: 'a2', geraetToken: 'g-alt' })
    expect(nachAnmeldung(vorher, sitzung('a', { kassen: ['a1', 'a3'] }), null, null)[0]).toMatchObject({ kasseId: 'a1' })
    // die Kasse dieses Geräts hat Vorrang, wenn sie zum Mandanten gehört — eine fremde zählt nicht
    expect(nachAnmeldung(vorher, sitzung('a', { kassen: ['a1', 'a2'] }), null, 'a1')[0]).toMatchObject({ kasseId: 'a1' })
    expect(nachAnmeldung(vorher, sitzung('a', { kassen: ['a1', 'a2'] }), null, 'b9')[0]).toMatchObject({ kasseId: 'a2' })
  })

  it('eine zur Seite gelegte Sitzung des neuen Mandanten ist jetzt aktiv und liegt nicht mehr herum', () => {
    const neu = nachAnmeldung([konto('b', { sitzung: sitzung('b') })], sitzung('b'), null, null)
    expect(neu[0]!.sitzung).toBeNull()
  })
})

describe('wechsle: zu einem anderen Konto', () => {
  const a = sitzung('a')

  it('Ziel mit gültiger Sitzung: sie wird aktiv, die bisherige liegt danach zur Seite', () => {
    const b = sitzung('b', { ablauf: JETZT + STUNDE })
    const { konten, ziel } = wechsle([konto('a'), konto('b', { sitzung: b, geraetToken: 'g-b', kasseId: 'b1' })], aktiv(a, 'a1'), 'b', JETZT)
    expect(ziel).toEqual({ art: 'sitzung', sitzung: b, kasseId: 'b1', geraetToken: 'g-b' })
    expect(konten.find(k => k.mandantId === 'a')!.sitzung).toBe(a)
    expect(konten.find(k => k.mandantId === 'b')!.sitzung).toBeNull()
  })

  it('Ziel mit abgelaufener Sitzung: Anmeldung nötig — die abgelaufene wird weggeworfen, die bisherige liegt zur Seite', () => {
    const { konten, ziel } = wechsle([konto('a'), konto('b', { sitzung: sitzung('b', { ablauf: JETZT - STUNDE }) })], aktiv(a), 'b', JETZT)
    expect(ziel).toMatchObject({ art: 'anmeldung', konto: { mandantId: 'b', sitzung: null } })
    expect(konten.find(k => k.mandantId === 'b')!.sitzung).toBeNull()
    expect(konten.find(k => k.mandantId === 'a')!.sitzung).toBe(a)
  })

  it('Ziel ohne Sitzung: Anmeldung nötig', () => {
    expect(wechsle([konto('a'), konto('b')], aktiv(a), 'b', JETZT).ziel).toMatchObject({ art: 'anmeldung' })
  })

  it('unbekanntes Konto oder das aktive selbst: nichts zu tun, die Liste bleibt', () => {
    const konten = [konto('a'), konto('b')]
    expect(wechsle(konten, aktiv(a), 'x', JETZT)).toEqual({ konten, ziel: null })
    expect(wechsle(konten, aktiv(a), 'a', JETZT)).toEqual({ konten, ziel: null })
  })

  it('die Sitzung eines Kassiers wird nicht zur Seite gelegt', () => {
    const kassier = sitzung('a', { admin: false })
    const { konten } = wechsle([konto('a'), konto('b')], aktiv(kassier), 'b', JETZT)
    expect(konten.every(k => k.sitzung === null)).toBe(true)
  })

  it('weitere zur Seite gelegte Sitzungen bleiben unberührt', () => {
    const c = sitzung('c')
    const { konten } = wechsle([konto('a'), konto('b'), konto('c', { sitzung: c })], aktiv(a), 'b', JETZT)
    expect(konten.find(k => k.mandantId === 'c')!.sitzung).toBe(c)
  })
})

describe('kleine Listenfunktionen', () => {
  it('ohneSitzungen verwirft nur die Sitzungen', () => {
    const neu = ohneSitzungen([konto('a', { sitzung: sitzung('a') }), konto('b')])
    expect(neu.map(k => [k.mandantId, k.sitzung])).toEqual([['a', null], ['b', null]])
  })

  it('legeZurSeite hängt die Sitzung an ein (neues) Konto', () => {
    const a = sitzung('a', { kassen: ['a1'] })
    expect(legeZurSeite([], aktiv(a, 'a1'))[0]).toMatchObject({ mandantId: 'a', sitzung: a, kasseId: 'a1' })
  })

  it('nimmAuf fasst nur das aktive Konto an — gemerkte Sitzungen anderer bleiben', () => {
    const c = sitzung('c')
    const neu = nimmAuf([konto('c', { sitzung: c })], sitzung('a'), null)
    expect(neu.find(k => k.mandantId === 'c')!.sitzung).toBe(c)
    expect(mandanten(neu)).toEqual(['c', 'a'])
  })

  it('entferneKonto', () => {
    expect(mandanten(entferneKonto([konto('a'), konto('b')], 'a'))).toEqual(['b'])
  })

  it('mitKasse merkt nur eine Kasse, die das Konto kennt', () => {
    const konten = [konto('a', { kassen: [{ id: 'a1', kassenId: 'A1', bezeichnung: null }, { id: 'a2', kassenId: 'A2', bezeichnung: null }], kasseId: 'a1' })]
    expect(mitKasse(konten, 'a', 'a2')[0]!.kasseId).toBe('a2')
    expect(mitKasse(konten, 'a', 'fremd')[0]!.kasseId).toBe('a1')
    expect(mitKasse(konten, 'x', 'a2')).toEqual(konten)
  })

  it('kasseFuerAnmeldung: die zuletzt benutzte, sonst die erste, sonst keine', () => {
    const kassen = [{ id: 'a1', kassenId: 'A1', bezeichnung: null }, { id: 'a2', kassenId: 'A2', bezeichnung: null }]
    expect(kasseFuerAnmeldung(konto('a', { kassen, kasseId: 'a2' }))!.id).toBe('a2')
    expect(kasseFuerAnmeldung(konto('a', { kassen, kasseId: null }))!.id).toBe('a1')
    expect(kasseFuerAnmeldung(konto('a', { kassen: [], kasseId: null }))).toBeNull()
  })
})

describe('Speicher', () => {
  const daten = new Map<string, string>()
  beforeEach(() => {
    daten.clear()
    vi.stubGlobal('localStorage', {
      getItem:    (k: string) => daten.get(k) ?? null,
      setItem:    (k: string, v: string) => { daten.set(k, v) },
      removeItem: (k: string) => { daten.delete(k) },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('leer oder kaputt → keine Konten; unbrauchbare Einträge werden übersprungen, Lücken aufgefüllt', () => {
    expect(ladeKonten()).toEqual([])
    daten.set('kassa:konten', '{kaputt')
    expect(ladeKonten()).toEqual([])
    daten.set('kassa:konten', JSON.stringify({ kein: 'array' }))
    expect(ladeKonten()).toEqual([])
    daten.set('kassa:konten', JSON.stringify([{ mandantId: 'a', firmenname: 'Firma a' }, { firmenname: 'ohne Id' }, 42]))
    expect(ladeKonten()).toEqual([{ mandantId: 'a', firmenname: 'Firma a', kassen: [], kasseId: null, benutzer: null, geraetToken: null, sitzung: null }])
  })

  it('speichern und laden; eine leere Liste entfernt den Eintrag', () => {
    speichereKonten([konto('a')])
    expect(ladeKonten()).toEqual([konto('a')])
    speichereKonten([])
    expect(daten.has('kassa:konten')).toBe(false)
  })

  it('merkeAnmeldung legt die bisherige Admin-Sitzung zur Seite; verwirfSitzungen löscht sie wieder (die Konten bleiben)', () => {
    const a = sitzung('a')
    merkeAnmeldung(a, null, 'a1')
    merkeAnmeldung(sitzung('b'), aktiv(a, 'a1'), null)
    expect(ladeKonten().map(k => [k.mandantId, k.sitzung !== null])).toEqual([['a', true], ['b', false]])
    verwirfSitzungen()
    expect(ladeKonten().map(k => [k.mandantId, k.sitzung !== null])).toEqual([['a', false], ['b', false]])
  })

  it('merkeKasse speichert die Kasse im Konto', () => {
    speichereKonten([konto('a', { kassen: [{ id: 'a1', kassenId: 'A1', bezeichnung: null }, { id: 'a2', kassenId: 'A2', bezeichnung: null }] })])
    merkeKasse('a', 'a2')
    expect(ladeKonten()[0]!.kasseId).toBe('a2')
  })
})
