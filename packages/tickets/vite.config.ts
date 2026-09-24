import { Agent } from 'node:http'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Nur die öffentlichen Ticket-Routen weiterleiten — wie die nginx-Konfiguration
// im Betrieb. Explizit 127.0.0.1 statt localhost (Windows löst teils zu ::1 →
// ECONNREFUSED), Keep-Alive gegen teure Cold-Connects.
const keepAliveAgent = new Agent({ keepAlive: true })
const API_PROXY = {
  '/api/ticketshop': { target: 'http://127.0.0.1:3000', changeOrigin: false, agent: keepAliveAgent },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server:  { port: 5181, proxy: API_PROXY },
  preview: { port: 5181, proxy: API_PROXY },
})
