import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: `npm run dev` proxies /api to the running vpm web service (VPM_API, default https://localhost:8443).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    sourcemap: false, // never ship source maps (spec §10)
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': { target: process.env.VPM_API ?? 'https://localhost:8443', changeOrigin: false, secure: false },
    },
  },
});
