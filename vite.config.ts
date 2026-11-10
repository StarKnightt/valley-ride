import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html') } },
  },
  server: { host: '127.0.0.1', port: Number(process.env.VALLEY_PORT) || 5240, strictPort: false },
});
