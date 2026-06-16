/**
 * E2E-Runner: legt eine frische E2E-Datenbank an, startet Playwright (das
 * Backend+Frontend als webServer hochfaehrt) und loescht die DB danach wieder.
 *
 * Der DB-Lebenszyklus liegt bewusst HIER und nicht in Playwrights globalSetup,
 * weil Playwright den webServer vor globalSetup startet — das Backend wuerde
 * sonst gegen eine noch nicht existierende DB migrieren.
 */
import postgres from 'postgres'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const BASE = process.env.E2E_BASIS_DATABASE_URL ?? 'postgresql://kassa:kassa@localhost:5432/kassa'
const NAME = `kassa_e2e_${randomBytes(5).toString('hex')}`
const url  = new URL(BASE)
url.pathname = `/${NAME}`
const E2E_DATABASE_URL = url.toString()

async function dropDb() {
  const admin = postgres(BASE, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`)
  } finally {
    await admin.end()
  }
}

const admin = postgres(BASE, { max: 1 })
try {
  await admin.unsafe(`CREATE DATABASE ${NAME}`)
  console.info(`[e2e] Datenbank ${NAME} angelegt`)
} finally {
  await admin.end()
}

let status = 1
try {
  const res = spawnSync('npx', ['playwright', 'test', ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, E2E_DATABASE_URL },
  })
  status = res.status ?? 1
} finally {
  await dropDb()
  console.info(`[e2e] Datenbank ${NAME} entfernt`)
}

process.exit(status)
