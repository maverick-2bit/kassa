import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GERAETE_PORTS, geraeteBasis, geraetePort, type GeraeteApp } from './geraeteAdressen'

// Repo-Wurzel: packages/frontend/src/lib → vier Ebenen hoch
const WURZEL = fileURLToPath(new URL('../../../../', import.meta.url))
const lies = (pfad: string) => readFileSync(`${WURZEL}${pfad}`, 'utf8').replace(/\r\n/g, '\n')

const APPS = Object.keys(GERAETE_PORTS) as GeraeteApp[]

describe('geraetePort / geraeteBasis', () => {
  it('gebautes Bundle (Docker): Port des Docker-Betriebs', () => {
    expect(geraetePort('kellner', false)).toBe(8083)
    expect(geraetePort('kds', false)).toBe(8080)
    expect(geraeteBasis('kellner', 'http:', '192.168.192.20', false)).toBe('http://192.168.192.20:8083')
  })

  it('Vite-Dev-Server: Port des Dev-Servers', () => {
    expect(geraetePort('kellner', true)).toBe(5178)
    expect(geraeteBasis('kds', 'http:', '192.168.192.20', true)).toBe('http://192.168.192.20:5175')
  })

  it('der Host ändert den Port nie — auch localhost nicht (Kassen-PC im Docker-Betrieb)', () => {
    expect(geraeteBasis('kellner', 'http:', 'localhost', false)).toBe('http://localhost:8083')
    expect(geraeteBasis('abholmonitor', 'https:', 'kassa.lan', false)).toBe('https://kassa.lan:8085')
  })

  it('unter vitest läuft der Dev-Modus (import.meta.env.DEV = true)', () => {
    expect(geraetePort('terminal')).toBe(GERAETE_PORTS.terminal.dev)
  })
})

describe('Port-Tabelle gegen die Quellen der Wahrheit', () => {
  it('Docker-Ports = Vorgaben der *_PORT-Variablen in docker-compose.yml und .env.example', () => {
    const compose = lies('docker-compose.yml')
    const env     = lies('.env.example')
    for (const app of APPS) {
      const name = `${app.toUpperCase()}_PORT`
      const c = compose.match(new RegExp(`\\$\\{${name}:-(\\d+)\\}:80`))
      expect(c, `${name} fehlt in docker-compose.yml`).not.toBeNull()
      expect(GERAETE_PORTS[app].prod, `${app} gegen docker-compose.yml`).toBe(Number(c![1]))
      const e = env.match(new RegExp(`^${name}=(\\d+)`, 'm'))
      expect(e, `${name} fehlt in .env.example`).not.toBeNull()
      expect(GERAETE_PORTS[app].prod, `${app} gegen .env.example`).toBe(Number(e![1]))
    }
  })

  it('Dev-Ports = `vite --port …` im dev-Skript des jeweiligen Pakets', () => {
    for (const app of APPS) {
      const paket = JSON.parse(lies(`packages/${app}/package.json`)) as { scripts?: { dev?: string } }
      const m = paket.scripts?.dev?.match(/--port\s+(\d+)/)
      expect(m, `packages/${app}: dev-Skript ohne --port`).not.toBeNull()
      expect(GERAETE_PORTS[app].dev, `${app} gegen package.json`).toBe(Number(m![1]))
    }
  })

  it('die Einstellungen-Seite wählt Ports nie nach dem Host (localhost ist kein Entwicklungsbetrieb)', () => {
    const seite = lies('packages/frontend/src/pages/EinstellungenPage.tsx')
    expect(seite).not.toMatch(/hostname\s*===\s*['"]localhost['"]/)
  })
})
