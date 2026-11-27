/**
 * Benutzer des Portals auf der Kommandozeile verwalten (es gibt bewusst keine Selbstregistrierung):
 *
 *   pnpm --filter @kassa/portal benutzer anlegen            --email chef@firma.at [--passwort …]
 *   pnpm --filter @kassa/portal benutzer passwort-setzen    --email chef@firma.at [--passwort …]
 *   pnpm --filter @kassa/portal benutzer totp-zuruecksetzen --email chef@firma.at
 *
 * Ohne --passwort wird ein zufälliges erzeugt und EINMAL ausgegeben. Beim ersten Anmelden richtet der Benutzer seine
 * Authenticator-App ein (TOTP); `totp-zuruecksetzen` ist der Weg bei einem verlorenen Handy.
 */

import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { loadConfig } from '../config.js'
import { createDbWithPool } from '../db/client.js'
import { PortalFehler } from '../fehler.js'
import { legeBenutzerAn, setzePasswort, setzeTotpZurueck } from '../services/benutzer.service.js'

const HILFE = `Aufruf: benutzer <anlegen|passwort-setzen|totp-zuruecksetzen> --email <adresse> [--passwort <passwort>]`

/** 24 Zeichen aus gut lesbaren Zeichen (ohne 0/O, 1/l/I) — für das Erstpasswort. */
function zufallsPasswort(): string {
  const zeichen = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(randomBytes(24), b => zeichen[b % zeichen.length]).join('')
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { email: { type: 'string' }, passwort: { type: 'string' } },
  })
  const befehl = positionals[0]
  const email = values.email
  if (!befehl || !email) { console.error(HILFE); process.exit(2) }

  const config = loadConfig()
  const { db, sql } = createDbWithPool(config.DATABASE_URL)
  try {
    if (befehl === 'anlegen' || befehl === 'passwort-setzen') {
      const erzeugt = values.passwort === undefined
      const passwort = values.passwort ?? zufallsPasswort()
      if (befehl === 'anlegen') await legeBenutzerAn(db, email, passwort)
      else await setzePasswort(db, email, passwort)
      console.info(befehl === 'anlegen' ? `Benutzer ${email} angelegt.` : `Passwort für ${email} gesetzt.`)
      if (erzeugt) console.info(`Passwort (wird nur jetzt angezeigt): ${passwort}`)
      console.info('Beim ersten Anmelden wird die Authenticator-App eingerichtet.')
    } else if (befehl === 'totp-zuruecksetzen') {
      await setzeTotpZurueck(db, email)
      console.info(`Authenticator-App von ${email} zurückgesetzt — sie wird beim nächsten Anmelden neu eingerichtet.`)
    } else {
      console.error(HILFE)
      process.exit(2)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err instanceof PortalFehler ? err.message : err)
  process.exit(1)
})
