import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `npm run dev:web -w license-server` proxies /api to a running License Server (LS_API, default http://127.0.0.1:7780).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: { sourcemap: false, outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': { target: process.env.LS_API ?? 'http://127.0.0.1:7780' } } },
});
