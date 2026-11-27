import { describe, it, expect } from 'vitest'
import { KASSEN_ANSICHT, belegKassen, kasseName, umschaltKassen, zielNachWechsel } from './kassenWechsel'

const k = (id: string, kassenId: string, bezeichnung: string | null = null) => ({ id, kassenId, bezeichnung })

describe('belegKassen: wessen Belege darf dieser Benutzer sehen?', () => {
  const serverListe = [
    { ...k('1', 'K-1'), ausserBetriebAm: null },
    { ...k('2', 'K-2'), ausserBetriebAm: '2026-01-01' },
    { ...k('3', 'K-3'), ausserBetriebAm: null },
  ]
  const ids = (o: { alleErlaubt?: boolean; zugeordneteIds?: string[]; serverListe?: typeof serverListe }) =>
    belegKassen({ alleErlaubt: false, serverListe, zugeordneteIds: [], geraeteKasseId: '3', ...o }).map(x => x.id)

  it('mit Einstellungs-Recht alle, auch stillgelegte', () => {
    expect(ids({ alleErlaubt: true, zugeordneteIds: ['1'] })).toEqual(['1', '2', '3'])
  })
  it('sonst nur die zugeordneten (auch stillgelegte), nicht die des Geräts', () => {
    expect(ids({ zugeordneteIds: ['1', '2'] })).toEqual(['1', '2'])
  })
  it('ohne Zuordnung nur die Kasse dieses Geräts', () => {
    expect(ids({})).toEqual(['3'])
  })
  it('Liste noch nicht geladen → leer', () => {
    expect(belegKassen({ alleErlaubt: true, serverListe: undefined, zugeordneteIds: [], geraeteKasseId: '3' })).toEqual([])
  })
})

describe('umschaltKassen: zwischen welchen Kassen darf dieses Gerät umschalten?', () => {
  const auth = [k('1', 'K-1', 'Bar'), k('2', 'K-2', 'Kuchen')]
  const server = [
    { ...k('1', 'K-1', 'Bar'),        status: 'aktiv' },
    { ...k('2', 'K-2', 'Kuchen'),     status: 'aktiv' },
    { ...k('3', 'K-3', 'Neu'),        status: 'aktiv' },
    { ...k('4', 'K-4', 'Stillgelegt'), status: 'ausser_betrieb' },
  ]

  it('mit Einstellungs-Recht: alle Kassen in Betrieb vom Server — auch solche nach der Anmeldung', () => {
    expect(umschaltKassen({ alleErlaubt: true, serverListe: server, authKassen: auth }).map(x => x.id)).toEqual(['1', '2', '3'])
  })

  it('stillgelegte Kassen werden nie angeboten', () => {
    expect(umschaltKassen({ alleErlaubt: true, serverListe: server, authKassen: auth }).some(x => x.id === '4')).toBe(false)
  })

  it('ohne Einstellungs-Recht: nur die zugeordneten Kassen aus der Anmeldung (Serverliste egal)', () => {
    expect(umschaltKassen({ alleErlaubt: false, serverListe: server, authKassen: auth }).map(x => x.id)).toEqual(['1', '2'])
  })

  it('solange die Serverliste lädt: die Liste aus der Anmeldung', () => {
    expect(umschaltKassen({ alleErlaubt: true, serverListe: undefined, authKassen: auth }).map(x => x.id)).toEqual(['1', '2'])
  })

  it('ein Eintrag ohne Status zählt als in Betrieb', () => {
    expect(umschaltKassen({ alleErlaubt: true, serverListe: [k('1', 'K-1')], authKassen: [] })).toHaveLength(1)
  })
})

describe('zielNachWechsel: wohin nach dem Wechsel?', () => {
  it('ein einzelner offener Tisch gehört zur alten Kasse → Tischübersicht', () => {
    expect(zielNachWechsel('/tische/3f2a-uuid')).toBe('/tische')
    expect(zielNachWechsel('/tische/3f2a-uuid/')).toBe('/tische')
  })

  it('alles andere bleibt auf derselben Seite (mit Suche und Abschnitt)', () => {
    expect(zielNachWechsel('/kasse')).toBe('/kasse')
    expect(zielNachWechsel('/tische')).toBe('/tische')
    expect(zielNachWechsel('/einstellungen', '?bereich=kassen', '#einrichtung-routing')).toBe('/einstellungen?bereich=kassen#einrichtung-routing')
  })
})

describe('KASSEN_ANSICHT: wo geht beim Umschalten ein Warenkorb verloren?', () => {
  it('Kasse und einzelner Tisch ja — Übersichten und Einstellungen nein', () => {
    expect(KASSEN_ANSICHT.test('/kasse')).toBe(true)
    expect(KASSEN_ANSICHT.test('/tische/abc')).toBe(true)
    expect(KASSEN_ANSICHT.test('/tische')).toBe(false)
    expect(KASSEN_ANSICHT.test('/einstellungen')).toBe(false)
    expect(KASSEN_ANSICHT.test('/kassenbuch')).toBe(false)
  })
})

describe('kasseName', () => {
  it('Bezeichnung, sonst Kassen-ID', () => {
    expect(kasseName(k('1', 'K-1', 'Bar'))).toBe('Bar')
    expect(kasseName(k('1', 'K-1', null))).toBe('K-1')
    expect(kasseName(k('1', 'K-1', ''))).toBe('K-1')
  })
})
