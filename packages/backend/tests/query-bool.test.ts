/**
 * Tests für queryBool — boolesche Query-Parameter ohne die z.coerce.boolean()-Falle
 * (Boolean("false") === true).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { queryBool } from '../src/routes/query-bool.js'

const mitStandard = (standard: boolean) => z.object({ nurAktive: queryBool(standard) })

describe('queryBool', () => {
  it('"false" ist false und "true" ist true — unabhängig vom Standard', () => {
    for (const standard of [true, false]) {
      expect(mitStandard(standard).parse({ nurAktive: 'false' })).toEqual({ nurAktive: false })
      expect(mitStandard(standard).parse({ nurAktive: 'true' })).toEqual({ nurAktive: true })
    }
  })

  it('fehlender Parameter → Standardwert', () => {
    expect(mitStandard(true).parse({})).toEqual({ nurAktive: true })
    expect(mitStandard(false).parse({})).toEqual({ nurAktive: false })
  })

  it('alles außer "true"/"false" wird abgelehnt statt umgedeutet', () => {
    for (const wert of ['', '1', '0', 'ja', 'nein', 'TRUE', 'False', ' true', ['true', 'false']]) {
      expect(mitStandard(true).safeParse({ nurAktive: wert }).success).toBe(false)
      expect(mitStandard(false).safeParse({ nurAktive: wert }).success).toBe(false)
    }
  })

  it('unbekannte Parameter bleiben unberührt (das Frontend schickt mandantId mit)', () => {
    expect(mitStandard(true).parse({ nurAktive: 'false', mandantId: 'egal' })).toEqual({ nurAktive: false })
  })

  it('die Falle, die der Helper umgeht: z.coerce.boolean() macht aus "false" true', () => {
    expect(z.coerce.boolean().parse('false')).toBe(true)
    expect(queryBool(true).parse('false')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Wächter: z.coerce.boolean() darf nirgends mehr in den Quellen stehen
// ---------------------------------------------------------------------------

function quelldateien(verzeichnis: string): string[] {
  return readdirSync(verzeichnis).flatMap(name => {
    const pfad = join(verzeichnis, name)
    if (statSync(pfad).isDirectory()) return name === 'node_modules' ? [] : quelldateien(pfad)
    return pfad.endsWith('.ts') ? [pfad] : []
  })
}

describe('Quellen-Wächter', () => {
  it('kein Schema in backend/src oder shared/src nutzt z.coerce.boolean() (Kommentare ausgenommen)', () => {
    const backendSrc = fileURLToPath(new URL('../src', import.meta.url))
    const sharedSrc  = fileURLToPath(new URL('../../shared/src', import.meta.url))

    const treffer = [...quelldateien(backendSrc), ...quelldateien(sharedSrc)].flatMap(datei =>
      readFileSync(datei, 'utf8').split('\n').flatMap((zeile, i) => {
        const code = zeile.trimStart()
        const kommentar = code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')
        return !kommentar && /coerce\s*\.\s*boolean/.test(zeile)
          ? [`${relative(backendSrc, datei)}:${i + 1}: ${zeile.trim()}`]
          : []
      }),
    )

    // Boolesche Query-Parameter laufen über queryBool() (routes/query-bool.ts)
    expect(treffer).toEqual([])
  })
})
