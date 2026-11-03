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

/** Basisadresse einer Geräte-App ohne Schrägstrich am Ende, z. B. `http://192.168.192.20:8083` */
export function geraeteBasis(
  app:       GeraeteApp,
  protocol:  string,
  host:      string,
  devServer: boolean = imDevServer(),
): string {
  return `${protocol}//${host}:${geraetePort(app, devServer)}`
}
