import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'

const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8')
) as { version: string }

export default defineConfig({
  define: {
    // zur Laufzeit als globale Konstante verfügbar: __APP_VERSION__
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Alle /api-Aufrufe werden an das Backend weitergeleitet
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/sse': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
