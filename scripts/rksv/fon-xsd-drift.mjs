#!/usr/bin/env node
// Vergleicht die mitgeführten FinanzOnline-Schemas (packages/rksv/tests/fixtures/fon-xsd) mit dem, was das BMF
// heute unter https://finanzonline.bmf.gv.at/fonws/ws/ ausliefert. Ändert das BMF die Schnittstelle, melden sich die
// Tests sonst erst, wenn jemand die Fixtures von Hand erneuert — und der Client würde gegen veraltete Schemas „geprüft".
//
//   node scripts/rksv/fon-xsd-drift.mjs                  vergleichen (Exit 0 = unverändert, 1 = geändert, 3 = BMF nicht erreichbar)
//   node scripts/rksv/fon-xsd-drift.mjs --aktualisieren  neu laden, Dateien + SHA256SUMS überschreiben
//
// Zusätzlich (nur als Hinweis, ändert den Exit-Code nicht): gibt es eine neuere Version des BMF-Prüftools als die festgelegte?

import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASIS = 'https://finanzonline.bmf.gv.at/fonws/ws/'
const ORDNER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'rksv', 'tests', 'fixtures', 'fon-xsd')
const PRUEFTOOL_VERSION = '1.1.1'
const aktualisieren = process.argv.includes('--aktualisieren')

const sha256 = daten => createHash('sha256').update(daten).digest('hex')

async function lade(name, versuche = 3) {
  let letzter
  for (let i = 1; i <= versuche; i++) {
    try {
      const antwort = await fetch(BASIS + name, { signal: AbortSignal.timeout(30_000) })
      if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`)
      return Buffer.from(await antwort.arrayBuffer())
    } catch (fehler) {
      letzter = fehler
      await new Promise(r => setTimeout(r, 1500 * i))
    }
  }
  throw letzter
}

const bekannt = new Map(readFileSync(join(ORDNER, 'SHA256SUMS'), 'utf8').split(/\r?\n/).filter(Boolean).map(z => {
  const [hash, name] = z.split(/\s+/)
  return [name, hash]
}))

const zeilen = []
let geaendert = 0, unerreichbar = 0
const neu = new Map()
for (const name of [...bekannt.keys()].sort()) {
  try {
    const daten = await lade(name)
    const hash = sha256(daten)
    neu.set(name, { daten, hash })
    if (hash === bekannt.get(name)) zeilen.push(`  unverändert  ${name}`)
    else { geaendert++; zeilen.push(`  GEÄNDERT     ${name}  (${bekannt.get(name).slice(0, 12)}… → ${hash.slice(0, 12)}…)`) }
  } catch (fehler) {
    unerreichbar++
    zeilen.push(`  NICHT ERREICHBAR  ${name}: ${fehler.message}`)
  }
}
console.log(`FinanzOnline-Schemas gegen ${BASIS}:`)
console.log(zeilen.join('\n'))

// Hinweis auf neuere Prüftool-Version (nur Information)
try {
  const kopf = { 'User-Agent': 'kassa-rksv-pruefstrecke', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }
  const antwort = await fetch('https://api.github.com/repos/BMF-RKSV-Technik/at-registrierkassen-mustercode/releases?per_page=30', { headers: kopf, signal: AbortSignal.timeout(30_000) })
  if (antwort.ok) {
    const versionen = (await antwort.json())
      .flatMap(r => (r.assets ?? []).map(a => /^regkassen-verification-(\d+\.\d+\.\d+)\.zip$/.exec(a.name)?.[1]).filter(Boolean))
    const vergleich = (a, b) => a.split('.').map(Number).reduce((s, x, i) => s || x - Number(b.split('.')[i]), 0)
    const neueste = versionen.sort(vergleich).at(-1)
    if (neueste && vergleich(neueste, PRUEFTOOL_VERSION) > 0) {
      console.log(`HINWEIS: Es gibt ein neueres BMF-Prüftool (${neueste}), festgelegt ist ${PRUEFTOOL_VERSION} — in scripts/rksv/bmf-pruefer.mjs URL und Prüfsumme nachziehen.`)
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `⚠️ Neueres BMF-Prüftool verfügbar: ${neueste} (festgelegt: ${PRUEFTOOL_VERSION})\n`)
    } else console.log(`BMF-Prüftool: ${PRUEFTOOL_VERSION} ist die neueste Version mit Download.`)
  }
} catch { /* nur ein Hinweis */ }

if (aktualisieren) {
  if (unerreichbar) { console.error('Nicht aktualisiert: nicht alle Dateien erreichbar.'); process.exit(3) }
  for (const [name, { daten }] of neu) writeFileSync(join(ORDNER, name), daten)
  writeFileSync(join(ORDNER, 'SHA256SUMS'), [...neu].map(([name, { hash }]) => `${hash}  ${name}`).join('\n') + '\n')
  console.log(`Aktualisiert: ${neu.size} Dateien, SHA256SUMS neu geschrieben. Jetzt die Tests laufen lassen (packages/rksv: pnpm test).`)
  process.exit(0)
}

if (geaendert) {
  const meldung = `Das BMF hat ${geaendert} Schema-Datei(en) geändert. Mit „node scripts/rksv/fon-xsd-drift.mjs --aktualisieren" neu laden und prüfen, ob der FinanzOnline-Client noch passt.`
  console.error(meldung)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `❌ ${meldung}\n`)
  process.exit(1)
}
if (unerreichbar) { console.error('FinanzOnline nicht (vollständig) erreichbar — kein Vergleich möglich.'); process.exit(3) }
console.log('Alle Schemas unverändert.')
