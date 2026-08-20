import { readFileSync } from 'node:fs'
import { Agent } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string }

/**
 * Dev-only: liefert unter /sw.js einen selbstzerstörenden Service Worker aus.
 * Hintergrund: hatte der Browser auf dieser Origin je einen Produktions-SW
 * (cache-first), bedient der die alte App-Shell weiter — Dev-Code lädt nie.
 * Der Kill-SW hat andere Bytes → Browser installiert ihn beim nächsten Laden,
 * er deregistriert sich und lädt alle Clients neu → sauberer Dev-Zustand.
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

// /api ans Backend weiterleiten (dev-server + preview). Explizit 127.0.0.1
// statt localhost (Windows löst teils zu ::1 → ECONNREFUSED) und Keep-Alive-
// Agent gegen teure Cold-Connects — Muster identisch zum Haupt-Frontend.
const keepAliveAgent = new Agent({ keepAlive: true })
const API_PROXY = {
  '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true, agent: keepAliveAgent },
  // SSE-Kanal (KDS→Kellner-Nachrichten) — läuft bewusst außerhalb von /api
  '/sse': { target: 'http://127.0.0.1:3000', changeOrigin: true, agent: keepAliveAgent },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), killSwImDev()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server:  { proxy: API_PROXY },
  // preview braucht einen EIGENEN Proxy (server.proxy gilt dort nicht) —
  // Voraussetzung für die Kellner-E2E gegen das gebaute Bundle (Port 5178).
  preview: { port: 5178, proxy: API_PROXY },
})
