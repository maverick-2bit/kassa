/**
 * Adressen der Geräte-Apps (Kellner-Handy, KDS, Kundendisplay, …) — Grundlage der
 * QR-Codes und Links unter Einstellungen → Geräte.
 *
 * Jede App hat zwei Ports: den Vite-Dev-Server (`pnpm dev`) und den Docker-Betrieb
 * (Vorgabewerte der `*_PORT`-Variablen in docker-compose.yml). Welcher gilt, entscheidet
 * das GEBAUTE Bundle (`import.meta.env.DEV`) — nicht der Host, unter dem die Seite gerade
 * offen ist: Am Kassen-PC selbst heißt der Host auch im Docker-Betrieb `localhost`. Die
 * frühere Unterscheidung nach dem Host lieferte dort die Dev-Ports (:5178, :5175 …), auf
 * denen nichts lauscht — der QR-Code führte ins Leere. geraeteAdressen.test.ts hält die
 * Tabelle gegen docker-compose.yml und die dev-Skripte der Pakete.
 */

export interface GeraetePorts {
  /** Vite-Dev-Server (`vite --port …` im dev-Skript des Pakets) */
  dev:  number
  /** Docker-Betrieb (Vorgabe der `*_PORT`-Variable in docker-compose.yml) */
  prod: number
}

export type GeraeteApp = 'kds' | 'kundendisplay' | 'gast' | 'kellner' | 'terminal' | 'abholmonitor'

export const GERAETE_PORTS: Record<GeraeteApp, GeraetePorts> = {
  kds:           { dev: 5175, prod: 8080 },
  kundendisplay: { dev: 5176, prod: 8081 },
  gast:          { dev: 5177, prod: 8082 },
  kellner:       { dev: 5178, prod: 8083 },
  terminal:      { dev: 5179, prod: 8084 },
  abholmonitor:  { dev: 5180, prod: 8085 },
}

/** Läuft dieses Bundle im Vite-Dev-Server? Vite setzt den Wert beim Bauen fest ein. */
export function imDevServer(): boolean {
  return import.meta.env.DEV
}

export function geraetePort(app: GeraeteApp, devServer: boolean = imDevServer()): number {
  return devServer ? GERAETE_PORTS[app].dev : GERAETE_PORTS[app].prod
}

/**
 * HTTPS im LAN (Docker-Dienst „lan-https", ops/caddy/Caddyfile.lan): feste Ports der
 * gesicherten Eingänge. Nur die Apps des Personals — Gast, Kundendisplay und
 * Abholmonitor bleiben bei http (fremde Handys bzw. Bildschirme ohne Mikrofon/Kamera).
 * geraeteAdressen.test.ts hält die Tabelle gegen docker-compose.yml und Caddyfile.lan.
 */
export const LAN_HTTPS_PORTS = {
  kasse:       8443,
  kds:         9080,
  kellner:     9083,
  terminal:    9084,
  einlass:     9087,
  /** Einrichtungsseite + Stammzertifikat — bewusst http (vor der Einrichtung vertraut das Gerät der CA nicht) */
  einrichtung: 9079,
} as const

/** Gesicherter Port einer Geräte-App, falls sie einen hat */
export function lanHttpsPort(app: GeraeteApp): number | null {
  return app === 'kds' || app === 'kellner' || app === 'terminal' ? LAN_HTTPS_PORTS[app] : null
}

/** IPv4-Adresse oder localhost — also kein Domainname (Proxy-Modus) */
export function istLanHost(host: string): boolean {
  return host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
}

/**
 * Basisadresse einer Geräte-App ohne Schrägstrich am Ende, z. B. `http://192.168.192.20:8083`.
 *
 * Ist die Kasse selbst über HTTPS im LAN offen (https://<IP>:8443), gelten deren Ports:
 * gesicherte Apps über ihren https-Port, die übrigen weiter über http — derselbe Port
 * unter https führte ins Leere. Unter einem Domainnamen (Proxy-Modus) bleibt alles wie bisher.
 */
export function geraeteBasis(
  app:       GeraeteApp,
  protocol:  string,
  host:      string,
  devServer: boolean = imDevServer(),
): string {
  if (!devServer && protocol === 'https:' && istLanHost(host)) {
    const sicher = lanHttpsPort(app)
    return sicher ? `https://${host}:${sicher}` : `http://${host}:${geraetePort(app, false)}`
  }
  return `${protocol}//${host}:${geraetePort(app, devServer)}`
}

/** Gesicherte Adresse einer Geräte-App (HTTPS im LAN) oder null, wenn die App keine hat */
export function geraeteBasisSicher(app: GeraeteApp, ip: string): string | null {
  const sicher = lanHttpsPort(app)
  return sicher ? `https://${ip}:${sicher}` : null
}
