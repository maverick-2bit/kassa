import { Agent } from 'node:http'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Nur die Einlass-Routen weiterleiten — wie die nginx-Konfiguration im Betrieb.
// 127.0.0.1 statt localhost (Windows löst teils zu ::1 → ECONNREFUSED).
const keepAliveAgent = new Agent({ keepAlive: true })
const API_PROXY = {
  '/api/einlass': { target: 'http://127.0.0.1:3000', changeOrigin: false, agent: keepAliveAgent },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server:  { port: 5182, proxy: API_PROXY },
  preview: { port: 5182, proxy: API_PROXY },
})
