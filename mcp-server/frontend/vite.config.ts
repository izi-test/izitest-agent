import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const MCP_BACKEND_PORT = process.env.MCP_PORT || 3457;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${MCP_BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
})
