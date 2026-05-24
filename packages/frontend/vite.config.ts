import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
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
