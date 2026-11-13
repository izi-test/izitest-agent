import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const MCP_BACKEND_PORT = process.env.MCP_PORT || 3467;

// What the server answers, with its token: the proxy adds it on the Node side, it never goes
// into the browser's bundle.
const toServer = {
  target: `http://127.0.0.1:${MCP_BACKEND_PORT}`,
  changeOrigin: true,
  headers: process.env.IZITEST_TOKEN
    ? { Authorization: `Bearer ${process.env.IZITEST_TOKEN}` }
    : {},
};

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
      '/api': toServer,
      // The live view of a tab an agent or a test works in (lib/live.js).
      '/live': toServer,
      // Images the server keeps: the page at a failed check, a visual check's baseline.
      // Without them here, the dashboard answered its own page for them: a broken image.
      '/assertion-screenshots': toServer,
      '/data/baselines': toServer,
    },
  },
})
