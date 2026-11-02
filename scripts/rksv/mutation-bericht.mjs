#!/usr/bin/env node
// Wandelt den JSON-Bericht von Stryker (reports/mutation/mutation.json) in eine lesbare Übersicht:
// Punktzahl je Datei und die überlebenden Mutanten — also die Behauptungen im Code, die kein Test festnagelt.
//
//   node scripts/rksv/mutation-bericht.mjs packages/rksv/reports/mutation/mutation.json [--markdown ausgabe.md] [--maximal 40]
//
// Mutant-Status laut Stryker: Killed/Timeout = erkannt, Survived = ein Test lief und blieb grün (Lücke),
// NoCoverage = kein Test führt die Zeile aus (Lücke), CompileError/RuntimeError/Ignored zählen nicht in die Punktzahl.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const [, , eingabe, ...rest] = process.argv
if (!eingabe) { console.error('Aufruf: mutation-bericht.mjs <mutation.json> [--markdown datei] [--maximal n]'); process.exit(2) }
const opt = { maximal: 40 }
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--markdown') opt.markdown = rest[++i]
  else if (rest[i] === '--maximal') opt.maximal = Number(rest[++i])
}

const bericht = JSON.parse(readFileSync(eingabe, 'utf8'))
const gezaehlt = new Set(['Killed', 'Timeout', 'Survived', 'NoCoverage'])
const erkannt = new Set(['Killed', 'Timeout'])

const zeilen = ['# Mutationstest RKSV-Kern', '']
const tabelle = ['| Datei | Mutanten | erkannt | überlebt | ohne Abdeckung | Punktzahl |', '|---|---:|---:|---:|---:|---:|']
const luecken = []
let summe = { alle: 0, erkannt: 0, ueberlebt: 0, ohne: 0 }

for (const [datei, f] of Object.entries(bericht.files ?? {}).sort()) {
  const m = f.mutants.filter(x => gezaehlt.has(x.status))
  const e = m.filter(x => erkannt.has(x.status)).length
  const u = m.filter(x => x.status === 'Survived')
  const o = m.filter(x => x.status === 'NoCoverage')
  summe = { alle: summe.alle + m.length, erkannt: summe.erkannt + e, ueberlebt: summe.ueberlebt + u.length, ohne: summe.ohne + o.length }
  tabelle.push(`| \`${datei}\` | ${m.length} | ${e} | ${u.length} | ${o.length} | ${m.length ? ((100 * e) / m.length).toFixed(1) : '–'} % |`)
  const quellzeilen = f.source.split(/\r?\n/)
  const eintraege = [...u, ...o].sort((a, b) => a.location.start.line - b.location.start.line)
  if (eintraege.length) {
    luecken.push(`## ${datei} — ${eintraege.length} Lücken`, '')
    for (const x of eintraege.slice(0, opt.maximal)) {
      const zeile = (quellzeilen[x.location.start.line - 1] ?? '').trim().slice(0, 140)
      const wie = x.status === 'NoCoverage' ? 'kein Test führt die Zeile aus' : 'Tests bleiben grün'
      luecken.push(`- Zeile ${x.location.start.line}: \`${zeile}\` — ${x.mutatorName}${x.replacement ? ` → \`${String(x.replacement).replace(/\s+/g, ' ').slice(0, 100)}\`` : ''} (${wie})`)
    }
    if (eintraege.length > opt.maximal) luecken.push(`- … und ${eintraege.length - opt.maximal} weitere`)
    luecken.push('')
  }
}

const punkte = summe.alle ? ((100 * summe.erkannt) / summe.alle).toFixed(1) : '–'
zeilen.push(`**Gesamt: ${punkte} %** — ${summe.erkannt} von ${summe.alle} Mutanten erkannt, ${summe.ueberlebt} überlebt, ${summe.ohne} ohne Abdeckung.`, '', ...tabelle, '')
zeilen.push(...luecken)
const text = zeilen.join('\n') + '\n'
if (opt.markdown) writeFileSync(opt.markdown, text)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
console.log(text)
