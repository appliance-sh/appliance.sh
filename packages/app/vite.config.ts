import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// Baked into the library bundle so downstream shells (console,
// desktop) see the version + build time without having to wire
// define themselves. Replacement happens during the app's lib
// build; by the time dist/index.js is consumed, these are plain
// string literals.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};
const BUILD_TIME = new Date().toISOString();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  define: {
    __APPLIANCE_VERSION__: JSON.stringify(pkg.version),
    __APPLIANCE_BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 'app',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
