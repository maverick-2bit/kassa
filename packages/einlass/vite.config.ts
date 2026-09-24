import { readFileSync } from 'node:fs'
import { Agent } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string }

/**
 * Dev-only: unter /sw.js ein selbstzerstörender Service Worker (Muster wie in
 * der Kellner-App). Hatte der Browser hier je einen Produktions-SW (cache-first),
 * lüde Dev-Code sonst nie — der Kill-SW deregistriert sich und lädt neu.
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

// Nur die Einlass-Routen weiterleiten — wie die nginx-Konfiguration im Betrieb.
// 127.0.0.1 statt localhost (Windows löst teils zu ::1 → ECONNREFUSED).
const keepAliveAgent = new Agent({ keepAlive: true })
const API_PROXY = {
  '/api/einlass': { target: 'http://127.0.0.1:3000', changeOrigin: false, agent: keepAliveAgent },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), killSwImDev()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server:  { port: 5182, proxy: API_PROXY },
  preview: { port: 5182, proxy: API_PROXY },
})
