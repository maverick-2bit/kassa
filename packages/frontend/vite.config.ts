import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'
import { Agent } from 'node:http'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8')
) as { version: string }

// /api- und /sse-Aufrufe ans Backend weiterleiten (dev-server + preview).
// Keep-Alive-Agent: poolt Verbindungen zum Backend, statt pro Request einen
// neuen Socket zu oeffnen. Verhindert wiederholte teure Cold-Connects (auf
// Windows kann ein erster Connect bis ~21s haengen) beim parallelen Laden
// mehrerer Queries.
const keepAliveAgent = new Agent({ keepAlive: true })
const API_PROXY = {
  '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true, agent: keepAliveAgent },
  '/sse': { target: 'http://127.0.0.1:3000', changeOrigin: true, agent: keepAliveAgent },
}

export default defineConfig({
  define: {
    // zur Laufzeit als globale Konstante verfügbar: __APP_VERSION__
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [react(), tailwindcss()],
  // 127.0.0.1 statt localhost: das Backend lauscht IPv4 (0.0.0.0); auf Windows
  // loest localhost teils zuerst auf ::1 (IPv6) auf -> ECONNREFUSED.
  // Fuer server (dev) und preview (E2E gegen das gebaute Bundle) identisch.
  server:  { port: 5173, proxy: API_PROXY },
  preview: { port: 5173, proxy: API_PROXY },
})
