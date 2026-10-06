/**
 * Query-Key ↔ API-Aufruf der Stammdaten-Listen (Artikel, Warengruppen).
 *
 * `?nurAktive=false` liefert seit dem Fix des Query-Parsers (z.coerce.boolean machte aus
 * "false" true) wirklich auch deaktivierte Einträge — vorher bekam jeder Aufrufer still nur
 * aktive. Damit eine „alle"-Abfrage nie denselben React-Query-Cache belegt wie eine
 * „nur aktive"-Abfrage (sonst zeigte z. B. die Kasse nach einem Besuch der Artikelverwaltung
 * deaktivierte Warengruppen aus dem Cache), gilt durchgängig:
 *
 *   ['kategorien', …]             ⇔  kategorieApi.list(true)    (auch ohne Argument)
 *   ['kategorien', 'alle']        ⇔  kategorieApi.list(false)
 *   ['artikel', id, true|false]   ⇔  artikelApi.list(id, true|false)
 *   ['artikel', id]               ⇔  artikelApi.list(id)         (Standard: nur aktive)
 *
 * Der Test liest die Quellen beider Web-Apps (Kassa + Kellner; nur dieses Paket hat einen
 * Test-Runner) und prüft jedes `queryKey: […], queryFn: () => …Api.list(…)`-Paar.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const QUELLWURZELN = [
  fileURLToPath(new URL('..', import.meta.url)),                    // frontend/src
  fileURLToPath(new URL('../../../kellner/src', import.meta.url)),  // kellner/src
]

function quelldateien(verzeichnis: string): string[] {
  return readdirSync(verzeichnis).flatMap(name => {
    const pfad = join(verzeichnis, name)
    if (statSync(pfad).isDirectory()) return quelldateien(pfad)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [pfad] : []
  })
}

/** `queryKey: [...], queryFn: () => artikelApi|kategorieApi.list(...)` — Leerraum vorher vereinheitlicht */
const MUSTER = /queryKey:\s*(\[[^\]]*\])\s*,\s*queryFn:\s*\(\)\s*=>\s*(kategorieApi|artikelApi)\.list\(([^)]*)\)/g
const AUFRUF = /\b(?:kategorieApi|artikelApi)\.list\(/g

interface Pruefung { verstoesse: string[]; aufrufe: number; erkannt: number }

function pruefeQuelltext(quelltext: string, name = 'quelle'): Pruefung {
  const text = quelltext.replace(/\s+/g, ' ')
  const verstoesse: string[] = []
  let erkannt = 0

  for (const treffer of text.matchAll(MUSTER)) {
    const [, key = '', api = '', args = ''] = treffer
    erkannt++
    const schluessel = key.slice(1, -1).split(',').map(s => s.trim())
    const argumente  = args.split(',').map(s => s.trim()).filter(Boolean)
    const beschreibung = `${name}: queryKey ${key} ↔ ${api}.list(${args.trim()})`

    if (api === 'kategorieApi') {
      if (schluessel[0] !== "'kategorien'") continue // eigene Schlüsselfamilie, kein Cache-Konflikt
      const nurAktive = argumente[0] ?? 'true'        // Standard des Wrappers: nur aktive
      const erwartet  = schluessel.includes("'alle'") ? 'false' : 'true'
      if (nurAktive !== erwartet) verstoesse.push(`${beschreibung} — erwartet list(${erwartet})`)
    } else {
      if (schluessel[0] !== "'artikel'") continue
      const nurAktive = argumente[1] ?? 'true'
      const imKey     = schluessel[2]                 // fehlt = Standard „nur aktive"
      if ((imKey ?? 'true') !== nurAktive) verstoesse.push(`${beschreibung} — Key trägt ${imKey ?? 'nichts (= true)'}`)
    }
  }
  return { verstoesse, aufrufe: (text.match(AUFRUF) ?? []).length, erkannt }
}

describe('Query-Keys der Stammdaten-Listen', () => {
  it('jeder Aufruf von kategorieApi.list / artikelApi.list hat einen dazu passenden Query-Key', () => {
    const verstoesse = QUELLWURZELN.flatMap(wurzel =>
      quelldateien(wurzel).flatMap(datei =>
        pruefeQuelltext(readFileSync(datei, 'utf8'), relative(wurzel, datei)).verstoesse),
    )
    expect(verstoesse).toEqual([])
  })

  it('kein Aufruf bleibt ungeprüft (Schreibweise außerhalb des erkannten Musters → Test erweitern)', () => {
    const ungeprueft = QUELLWURZELN.flatMap(wurzel =>
      quelldateien(wurzel).flatMap(datei => {
        const { aufrufe, erkannt } = pruefeQuelltext(readFileSync(datei, 'utf8'))
        return aufrufe === erkannt ? [] : [`${relative(wurzel, datei)}: ${aufrufe} Aufrufe, ${erkannt} erkannt`]
      }),
    )
    expect(ungeprueft).toEqual([])
  })

  describe('der Prüfer selbst (damit der Test nicht still ins Leere läuft)', () => {
    it('meldet „alle" unter dem Schlüssel „nur aktive" — und umgekehrt', () => {
      const geteilt = `useQuery({ queryKey: ['kategorien'], queryFn: () => kategorieApi.list(false) })`
      expect(pruefeQuelltext(geteilt).verstoesse).toHaveLength(1)
      const umgekehrt = `useQuery({\n queryKey: ['kategorien', 'alle'],\n queryFn: () => kategorieApi.list(true),\n})`
      expect(pruefeQuelltext(umgekehrt).verstoesse).toHaveLength(1)
      const standard = `useQuery({ queryKey: ['kategorien', 'alle'], queryFn: () => kategorieApi.list() })`
      expect(pruefeQuelltext(standard).verstoesse).toHaveLength(1)
    })

    it('akzeptiert zusammenpassende Paare in beiden Schreibweisen', () => {
      const ok = [
        `useQuery({ queryKey: ['kategorien'], queryFn: () => kategorieApi.list(true) })`,
        `useQuery({ queryKey: ['kategorien'], queryFn: () => kategorieApi.list() })`,
        `useQuery({\n  queryKey: ['kategorien', 'alle'],\n  queryFn:  () => kategorieApi.list(false),\n})`,
        `useQuery({ queryKey: ['kategorien', identity?.kasseId], queryFn: () => kategorieApi.list(true) })`,
        `useQuery({ queryKey: ['artikel', identity.mandantId, true], queryFn: () => artikelApi.list(identity.mandantId, true) })`,
        `useQuery({ queryKey: ['artikel', auth?.mandant.id, false], queryFn: () => artikelApi.list(auth!.mandant.id, false) })`,
        `useQuery({ queryKey: ['artikel', identity.mandantId, nurAktive], queryFn: () => artikelApi.list(identity.mandantId, nurAktive) })`,
        `useQuery({ queryKey: ['artikel', auth.mandant.id], queryFn: () => artikelApi.list(auth.mandant.id) })`,
      ]
      for (const quelle of ok) {
        const { verstoesse, aufrufe, erkannt } = pruefeQuelltext(quelle)
        expect({ quelle, verstoesse, aufrufe, erkannt }).toEqual({ quelle, verstoesse: [], aufrufe: 1, erkannt: 1 })
      }
    })

    it('meldet einen Artikel-Key, dessen Flag nicht zum Aufruf passt', () => {
      const a = `useQuery({ queryKey: ['artikel', id, false], queryFn: () => artikelApi.list(id, true) })`
      const b = `useQuery({ queryKey: ['artikel', id], queryFn: () => artikelApi.list(id, false) })`
      const c = `useQuery({ queryKey: ['artikel', id, 'alle'], queryFn: () => artikelApi.list(id, false) })`
      expect(pruefeQuelltext(a).verstoesse).toHaveLength(1)
      expect(pruefeQuelltext(b).verstoesse).toHaveLength(1)
      expect(pruefeQuelltext(c).verstoesse).toHaveLength(1)
    })

    it('zählt einen nicht erkannten Aufruf (z. B. ohne queryKey-Paar) als ungeprüft', () => {
      const lose = `const liste = await kategorieApi.list(false)`
      const { aufrufe, erkannt } = pruefeQuelltext(lose)
      expect({ aufrufe, erkannt }).toEqual({ aufrufe: 1, erkannt: 0 })
    })
  })
})
