import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GERAETE_PORTS, LAN_HTTPS_PORTS, geraeteBasis, geraeteBasisSicher, geraetePort, lanHttpsPort, type GeraeteApp } from './geraeteAdressen'

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

describe('HTTPS im LAN (Dienst lan-https)', () => {
  it('Kasse über https://<IP>:8443 offen: gesicherte Apps über ihren https-Port, die übrigen über http', () => {
    expect(geraeteBasis('kellner', 'https:', '192.168.1.50', false)).toBe('https://192.168.1.50:9083')
    expect(geraeteBasis('kds', 'https:', '192.168.1.50', false)).toBe('https://192.168.1.50:9080')
    expect(geraeteBasis('terminal', 'https:', 'localhost', false)).toBe('https://localhost:9084')
    expect(geraeteBasis('gast', 'https:', '192.168.1.50', false)).toBe('http://192.168.1.50:8082')
    expect(geraeteBasis('kundendisplay', 'https:', '192.168.1.50', false)).toBe('http://192.168.1.50:8081')
  })

  it('unter einem Domainnamen (Proxy-Modus) und über http bleibt alles wie bisher', () => {
    expect(geraeteBasis('kellner', 'https:', 'kassa.lan', false)).toBe('https://kassa.lan:8083')
    expect(geraeteBasis('kellner', 'http:', '192.168.1.50', false)).toBe('http://192.168.1.50:8083')
  })

  it('geraeteBasisSicher: nur Kellner, KDS und SB-Terminal haben einen gesicherten Eingang', () => {
    expect(geraeteBasisSicher('kellner', '10.0.0.7')).toBe('https://10.0.0.7:9083')
    for (const app of ['gast', 'kundendisplay', 'abholmonitor'] as const) expect(geraeteBasisSicher(app, '10.0.0.7')).toBeNull()
    expect(lanHttpsPort('kds')).toBe(LAN_HTTPS_PORTS.kds)
  })

  it('Ports = docker-compose.yml, Caddyfile.lan, Einrichtungsseite und Installer', () => {
    const compose = lies('docker-compose.yml')
    const dienst  = compose.slice(compose.indexOf('\n  lan-https:'), compose.indexOf('\nvolumes:'))
    const caddy   = lies('ops/caddy/Caddyfile.lan')
    const seite   = lies('ops/caddy/lan/index.html')
    const ps1     = lies('ops/lan-https.ps1')
    const sh      = lies('ops/install.sh')
    const alle = Object.values(LAN_HTTPS_PORTS).sort()
    const veroeffentlicht = [...dienst.matchAll(/- "(\d+):(\d+)"/g)].map(m => { expect(m[1]).toBe(m[2]); return Number(m[1]) }).sort()
    expect(veroeffentlicht).toEqual(alle)
    expect([...ps1.matchAll(/= (\d{4})\s*$/gm)].map(m => Number(m[1])).sort()).toEqual(alle)
    expect(sh.match(/LAN_HTTPS_PORTS="([\d ]+)"/)![1]!.split(' ').map(Number).sort()).toEqual(alle)
    // Kurzinfo des Dienstes nennt dieselben Ports
    const info = caddy.match(/respond `(.+)` 200/)![1]!.replace(/\\([{}])/g, '$1').replace('{$KASSA_LAN_IP}', '1.2.3.4')
    expect(JSON.parse(info).ports).toEqual(LAN_HTTPS_PORTS)
    // Jede gesicherte App hat ihren Site-Block mit dem richtigen Ziel
    const ziel: Record<string, string> = { kasse: 'frontend', kds: 'kds', kellner: 'kellner', terminal: 'terminal', einlass: 'einlass' }
    for (const [app, dienstName] of Object.entries(ziel)) {
      const port = LAN_HTTPS_PORTS[app as keyof typeof LAN_HTTPS_PORTS]
      expect(caddy, `${app}: Site-Block`).toMatch(new RegExp(`https://\\{\\$KASSA_LAN_IP\\}:${port}, https://localhost:${port} \\{\\n\\timport app ${dienstName}\\n\\}`))
      expect(seite, `${app}: Einrichtungsseite`).toContain(`, ${port}]`)
    }
    expect(caddy).toContain(`http://:${LAN_HTTPS_PORTS.einrichtung} {`)
  })
})
