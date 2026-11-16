/**
 * Kassa im LAN ohne Internet: Keine Oberfläche darf beim Laden etwas aus dem Internet brauchen
 * (Schriften, CDN-Skripte, Icons, Stylesheets) — sonst bleibt sie offline weiß oder lädt erst nach
 * langem Zeitlimit. Geprüft werden index.html, Manifest und CSS ALLER Apps im Repo sowie Stellen,
 * an denen der Quelltext selbst absolute Adressen abruft (fetch/EventSource/WebSocket/import).
 * Links, die der Mensch anklickt (Hilfe, FinanzOnline …), sind erlaubt — die braucht der Betrieb nicht.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PAKETE = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const APPS = ['frontend', 'kellner', 'kds', 'kundendisplay', 'gast', 'einlass', 'tickets', 'abholmonitor', 'terminal']

function dateien(verzeichnis: string, endungen: string[]): string[] {
  if (!existsSync(verzeichnis)) return []
  const aus: string[] = []
  for (const name of readdirSync(verzeichnis)) {
    if (name === 'node_modules' || name === 'dist') continue
    const pfad = join(verzeichnis, name)
    if (statSync(pfad).isDirectory()) aus.push(...dateien(pfad, endungen))
    else if (endungen.some(e => name.endsWith(e)) && !/\.test\.tsx?$/.test(name)) aus.push(pfad)
  }
  return aus
}

/** Absolute Adresse ins Netz (nicht die eigene Kassa) */
const EXTERN = /(?:^|["'(\s=])(?:https?:)?\/\/(?!localhost|127\.0\.0\.1)[a-z0-9-]+\.[a-z0-9.-]+/i

describe('LAN ohne Internet: Oberflächen laden nichts von außen', () => {
  it('alle Apps sind vorhanden (sonst prüft der Test ins Leere)', () => {
    for (const app of APPS) expect(existsSync(join(PAKETE, app, 'index.html')), app).toBe(true)
  })

  it.each(APPS)('%s: index.html und Manifest verweisen nur auf eigene Dateien', (app) => {
    const html = readFileSync(join(PAKETE, app, 'index.html'), 'utf8')
    const verweise = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)].map(m => m[1]!)
    expect(verweise.filter(v => EXTERN.test(`"${v}`))).toEqual([])
    const manifest = join(PAKETE, app, 'public', 'manifest.json')
    if (existsSync(manifest)) expect(readFileSync(manifest, 'utf8')).not.toMatch(EXTERN)
  })

  it.each(APPS)('%s: kein Stylesheet lädt Schriften oder Bilder aus dem Netz', (app) => {
    const funde = dateien(join(PAKETE, app, 'src'), ['.css'])
      .flatMap(f => readFileSync(f, 'utf8').split('\n')
        .filter(z => /@import|url\(/.test(z) && EXTERN.test(z))
        .map(z => `${relative(PAKETE, f)}: ${z.trim()}`))
    expect(funde).toEqual([])
  })

  it.each(APPS)('%s: der Code ruft keine absolute Adresse ab (fetch/EventSource/WebSocket/import)', (app) => {
    const funde = dateien(join(PAKETE, app, 'src'), ['.ts', '.tsx'])
      .flatMap(f => readFileSync(f, 'utf8').split('\n')
        .filter(z => /\b(?:fetch|EventSource|WebSocket|import)\s*\(\s*[`'"]https?:\/\//.test(z))
        .map(z => `${relative(PAKETE, f)}: ${z.trim()}`))
    expect(funde).toEqual([])
  })
})
