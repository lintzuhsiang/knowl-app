import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      // All AI / data / auth calls go through the Express backend.
      // No direct LLM proxy here — the API key never leaves the server.
      '/api/db':   { target: 'http://localhost:3001', changeOrigin: true },
      '/api/auth': { target: 'http://localhost:3001', changeOrigin: true },
      '/api/ai':   { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
})
