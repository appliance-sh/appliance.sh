import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 2 dev server. Fixed port (not strict) so Tauri's
// devUrl in tauri.conf.json can find it. HMR over a distinct
// port keeps the dev reload channel off the app's window.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: true,
    target: 'es2022',
  },
});
