/**
 * Kommandozeile für den Mandanten-Transfer (aufgerufen von ops/uebergabe.ps1 im Backend-Container):
 *
 *   node dist/cli/mandant-transfer.js liste
 *   node dist/cli/mandant-transfer.js export <mandantId> <datei.json>
 *   node dist/cli/mandant-transfer.js import <datei.json>
 *
 * Nutzt DATABASE_URL und MASTER_PASSPHRASE aus der Umgebung des Containers.
 * Die Exportdatei enthält Geheimnisse im Klartext und darf nur verschlüsselt weitergegeben werden.
 */

import { readFile, writeFile } from 'node:fs/promises'
import postgres from 'postgres'
import {
  exportiereMandant, importiereMandant, listeMandanten, type MandantExport,
} from '../services/mandant-transfer.service.js'

async function main(): Promise<void> {
  const [befehl, a, b] = process.argv.slice(2)
  const url        = process.env['DATABASE_URL']
  const passphrase = process.env['MASTER_PASSPHRASE']
  if (!url || !passphrase) throw new Error('DATABASE_URL und MASTER_PASSPHRASE müssen gesetzt sein.')
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    if (befehl === 'liste') {
      for (const m of await listeMandanten(sql)) console.log(`${m.id}\t${m.name}`)
    } else if (befehl === 'export' && a && b) {
      const daten = await exportiereMandant(sql, a, passphrase)
      await writeFile(b, JSON.stringify(daten), { mode: 0o600 })
      const zeilen = Object.values(daten.tabellen).reduce((n, z) => n + z.length, 0)
      console.log(`Mandant '${daten.name}' exportiert: ${Object.keys(daten.tabellen).length} Tabellen, ${zeilen} Zeilen.`)
    } else if (befehl === 'import' && a) {
      const daten = JSON.parse(await readFile(a, 'utf8')) as MandantExport
      const bericht = await importiereMandant(sql, daten, passphrase)
      const zeilen = Object.values(bericht.zeilen).reduce((n, z) => n + z, 0)
      console.log(`Mandant '${bericht.name}' importiert: ${Object.keys(bericht.zeilen).length} Tabellen, ${zeilen} Zeilen.`)
    } else {
      throw new Error('Aufruf: liste | export <mandantId> <datei> | import <datei>')
    }
  } finally {
    await sql.end()
  }
}

main().catch((e: unknown) => {
  console.error('FEHLER:', e instanceof Error ? e.message : e)
  process.exit(1)
})
