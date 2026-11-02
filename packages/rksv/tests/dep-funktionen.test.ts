/**
 * DEP7/DEP131-Funktionen im Einzelnen: Zusammenführen, formale Prüfung, JSON, Feldzuordnung.
 *
 * Anlass (Mutationstest, siehe PRUEFSTRECKE.md): dep.ts hatte nur 49 % Punktzahl — mergeDEP7Exports, die Fehlerzweige von
 * validiereDEP7, dep7AusJson und der DEP131-Export wurden in der schnellen Suite nie ausgeführt (nur in Integrationstests).
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  dep131ZuJson, dep7AusJson, dep7ZuJson, erstelleDEP131Export, erstelleDEP7Export, mergeDEP7Exports, validiereDEP7,
} from '../src/dep.js'
import { Umsatzzaehler, signiereBeleg } from '../src/beleg.js'
import { generateSEE } from '../src/see.js'
import type { DEP131BelegInput, DEP7Export, SEEConfig, SignedBeleg } from '../src/types.js'

let see: SEEConfig
let belege: SignedBeleg[]

beforeAll(async () => {
  see = await generateSEE({ kassenId: 'DEP-1', uid: 'ATU12345678', firmenname: 'Dep GmbH' })
  const kontext = { see, umsatzzaehler: new Umsatzzaehler(0n) }
  belege = []
  for (let i = 1; i <= 3; i++) {
    const b = await signiereBeleg({ kassenId: 'DEP-1', belegNummer: i, datumUhrzeit: new Date(2026, 5, 15, 10, i), belegTyp: i === 1 ? 'Startbeleg' : 'Barzahlungsbeleg',
      positionen: i === 1 ? [] : [{ bezeichnung: 'Ware', menge: 1, einzelpreisBreutto: 100 * i, mwstSatz: 'normal' }] }, kontext)
    kontext.letzterBelegCode = b.maschinenlesbareCode
    belege.push(b)
  }
})

describe('erstelleDEP7Export', () => {
  it('eine Gruppe: Zertifikat (Base64 DER), keine Zertifizierungsstellen, Belege als JWS-Compact in Reihenfolge', () => {
    const dep = erstelleDEP7Export(belege, see)
    expect(dep['Belege-Gruppe']).toHaveLength(1)
    const g = dep['Belege-Gruppe'][0]!
    expect(g.Signaturzertifikat).toBe(see.zertifikatDER.toString('base64'))
    expect(g.Zertifizierungsstellen).toEqual([])
    expect(g['Belege-kompakt']).toEqual(belege.map(b => b.jwsCompact))
  })
})

describe('mergeDEP7Exports', () => {
  it('hängt die Gruppen der Reihe nach an', () => {
    const a = erstelleDEP7Export(belege.slice(0, 2), see)
    const b = erstelleDEP7Export(belege.slice(2), see)
    const m = mergeDEP7Exports(a, b)
    expect(m['Belege-Gruppe']).toHaveLength(2)
    expect(m['Belege-Gruppe'][0]!['Belege-kompakt']).toHaveLength(2)
    expect(m['Belege-Gruppe'][1]!['Belege-kompakt']).toEqual([belege[2]!.jwsCompact])
  })

  it('ein einzelner Export bleibt unverändert, kein Export ist ein Fehler', () => {
    const a = erstelleDEP7Export(belege, see)
    expect(mergeDEP7Exports(a)).toEqual(a)
    expect(() => mergeDEP7Exports()).toThrow('Keine Exporte angegeben')
  })
})

describe('validiereDEP7', () => {
  it('gültiger Export: Anzahl der Belege, keine Fehler', () => {
    expect(validiereDEP7(erstelleDEP7Export(belege, see))).toEqual({ gueltig: true, anzahlBelege: 3, fehler: [] })
  })

  it('zählt über mehrere Gruppen', () => {
    const m = mergeDEP7Exports(erstelleDEP7Export(belege.slice(0, 1), see), erstelleDEP7Export(belege.slice(1), see))
    expect(validiereDEP7(m)).toMatchObject({ gueltig: true, anzahlBelege: 3 })
  })

  it('keine Gruppe / keine Liste → ungültig', () => {
    expect(validiereDEP7({ 'Belege-Gruppe': [] })).toEqual({ gueltig: false, anzahlBelege: 0, fehler: ['Keine Belege-Gruppe vorhanden'] })
    expect(validiereDEP7({ 'Belege-Gruppe': 'x' } as unknown as DEP7Export)).toMatchObject({ gueltig: false, fehler: ['Keine Belege-Gruppe vorhanden'] })
  })

  it('Gruppe ohne Signaturzertifikat', () => {
    const dep = erstelleDEP7Export(belege, see)
    dep['Belege-Gruppe'][0]!.Signaturzertifikat = ''
    expect(validiereDEP7(dep)).toMatchObject({ gueltig: false, anzahlBelege: 3, fehler: ['Gruppe ohne Signaturzertifikat'] })
  })

  it('Belege-kompakt ist kein Array', () => {
    const dep = erstelleDEP7Export(belege, see)
    ;(dep['Belege-Gruppe'][0] as unknown as { 'Belege-kompakt': unknown })['Belege-kompakt'] = 'nein'
    expect(validiereDEP7(dep)).toMatchObject({ gueltig: false, anzahlBelege: 0, fehler: ['Belege-kompakt ist kein Array'] })
  })

  it('Eintrag, der kein JWS ist, wird mit den ersten 30 Zeichen gemeldet und nicht gezählt', () => {
    const dep = erstelleDEP7Export(belege, see)
    const kaputt = 'das-ist-kein-jws-sondern-ein-langer-text-ohne-punkte'
    dep['Belege-Gruppe'][0]!['Belege-kompakt'].push(kaputt)
    const r = validiereDEP7(dep)
    expect(r.gueltig).toBe(false)
    expect(r.anzahlBelege).toBe(3)
    expect(r.fehler).toEqual([`Ungültiger Beleg (kein RKSV-JWS): ${kaputt.substring(0, 30)}...`])
  })

  it('drei Teile, aber Nutzlast ohne _R1- → ungültig; zwei Teile mit richtiger Nutzlast → ebenfalls', () => {
    const [kopf, nutzlast, sig] = belege[1]!.jwsCompact.split('.') as [string, string, string]
    const fremd = [kopf, Buffer.from('irgendwas', 'utf8').toString('base64url'), sig].join('.')
    const zweiTeile = [kopf, nutzlast].join('.')
    const dep: DEP7Export = { 'Belege-Gruppe': [{ Signaturzertifikat: 'AAA', Zertifizierungsstellen: [], 'Belege-kompakt': [fremd, zweiTeile] }] }
    const r = validiereDEP7(dep)
    expect(r.anzahlBelege).toBe(0)
    expect(r.fehler).toHaveLength(2)
  })
})

describe('JSON', () => {
  it('dep7ZuJson → dep7AusJson ist verlustfrei, Einrückung 2', () => {
    const dep = erstelleDEP7Export(belege, see)
    const json = dep7ZuJson(dep)
    expect(json).toContain('\n  "Belege-Gruppe"')
    expect(dep7AusJson(json)).toEqual(dep)
  })

  it.each([['"text"'], ['null'], ['42'], ['{}'], ['{"andere":[]}']])('%s ist kein DEP7', json => {
    expect(() => dep7AusJson(json)).toThrow('Ungültiges DEP7-Format')
  })
})

describe('DEP131', () => {
  const eingabe: DEP131BelegInput[] = [{
    belegNummer: 2, datumUhrzeit: new Date('2026-06-15T08:31:00.000Z'), belegTyp: 'Barzahlungsbeleg',
    positionen: [{ bezeichnung: 'Kaffee', menge: 2, einzelpreisBreutto: 350, mwstSatz: 'ermaessigt1' }],
    betraege: { normal: 0, ermaessigt1: 700, ermaessigt2: 0, null: 0, besonders: 0 },
    zahlung: { barCent: 500, karteCent: 100, sonstigeCent: 100 },
    maschinenlesbareCode: '_R1-AT0_K_2_x', signaturwert: 'SIG', umsatzzaehlerVerschluesselt: 'ZAEHLER', zertifikatSN: 'ABC', sigVorbeleg: 'VOR',
  }]

  it('ordnet jedes Feld zu (Namen wie im Export)', () => {
    const dep = erstelleDEP131Export(eingabe, 'KASSE-9')
    expect(dep.kassenId).toBe('KASSE-9')
    expect(Date.parse(dep.exportDatum)).not.toBeNaN()
    expect(dep.Belege).toEqual([{
      Belegtyp: 'Barzahlungsbeleg', Belegnummer: 2, DatumUhrzeit: '2026-06-15T08:31:00.000Z',
      Positionen: [{ Bezeichnung: 'Kaffee', Menge: 2, EinzelpreisBreuttoCent: 350, MwStSatz: 'ermaessigt1' }],
      Betraege: { NormalCent: 0, Ermaessigt1Cent: 700, Ermaessigt2Cent: 0, NullCent: 0, BesondersCent: 0 },
      Zahlung: { BarCent: 500, KarteCent: 100, SonstigeCent: 100 },
      MaschinenlesbareCode: '_R1-AT0_K_2_x', Signaturwert: 'SIG', UmsatzzaehlerVerschluesselt: 'ZAEHLER', ZertifikatSN: 'ABC', SigVorbeleg: 'VOR',
    }])
  })

  it('dep131ZuJson: lesbares JSON mit Einrückung 2, verlustfrei', () => {
    const dep = erstelleDEP131Export(eingabe, 'KASSE-9')
    const json = dep131ZuJson(dep)
    expect(json).toContain('\n  "kassenId": "KASSE-9"')
    expect(JSON.parse(json)).toEqual(dep)
  })
})
