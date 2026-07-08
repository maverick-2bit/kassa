import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'
import { Agent } from 'node:http'

/**
 * Dev-only: liefert unter /sw.js einen selbstzerstörenden Service Worker aus.
 * Hintergrund: hatte der Browser auf dieser Origin je einen Produktions-SW
 * (cache-first), bedient der die alte App-Shell weiter — Dev-Code lädt nie.
 * Der Kill-SW hat andere Bytes → Browser installiert ihn beim nächsten Laden,
 * er deregistriert sich und lädt alle Clients neu → sauberer Dev-Zustand.
 * (apply: 'serve' → gilt NUR für den Dev-Server; vite preview liefert dist/sw.js.)
 */
const killSwImDev = (): Plugin => ({
  name: 'kill-sw-im-dev',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] === '/sw.js') {
        res.setHeader('Content-Type', 'application/javascript')
        res.end(
          "self.addEventListener('install',()=>self.skipWaiting());" +
          "self.addEventListener('activate',e=>{e.waitUntil(" +
          "self.registration.unregister()" +
          ".then(()=>self.clients.matchAll({type:'window'}))" +
          ".then(cs=>cs.forEach(c=>c.navigate(c.url))))});",
        )
        return
      }
      next()
    })
  },
})

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
  plugins: [react(), tailwindcss(), killSwImDev()],
  // 127.0.0.1 statt localhost: das Backend lauscht IPv4 (0.0.0.0); auf Windows
  // loest localhost teils zuerst auf ::1 (IPv6) auf -> ECONNREFUSED.
  // Fuer server (dev) und preview (E2E gegen das gebaute Bundle) identisch.
  server:  { port: 5173, proxy: API_PROXY },
  preview: { port: 5173, proxy: API_PROXY },
})
