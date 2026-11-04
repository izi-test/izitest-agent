import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const MCP_BACKEND_PORT = process.env.MCP_PORT || 3467;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true
  },
  server: {
    // 5173 et 5174 sont pris (gemini-chat-api, Browser Pilot) : port dédié, sans repli.
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${MCP_BACKEND_PORT}`,
        changeOrigin: true,
        // Le serveur exige le jeton sur /api : le proxy l'ajoute côté Node, il ne
        // part jamais dans le bundle du navigateur.
        headers: process.env.IZITEST_TOKEN
          ? { Authorization: `Bearer ${process.env.IZITEST_TOKEN}` }
          : {},
      },
      // The live view of a tab an agent or a test works in (lib/live.js): the same token.
      '/live': {
        target: `http://127.0.0.1:${MCP_BACKEND_PORT}`,
        changeOrigin: true,
        headers: process.env.IZITEST_TOKEN
          ? { Authorization: `Bearer ${process.env.IZITEST_TOKEN}` }
          : {},
      },
    },
  },
})
