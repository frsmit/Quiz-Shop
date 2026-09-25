import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Builds the two ES-module targets: the options page and the MV3 service
 * worker. The content script is built separately (see vite.content.config.ts)
 * because content scripts must be a single classic script, not an ES module.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // In watch mode (scripts/dev.mjs) both builds write into dist/ side by
    // side, so emptying it here would delete content.js on every rebuild.
    // dev.mjs clears dist/ once before either watcher starts instead.
    emptyOutDir: mode !== 'development',
    target: 'chrome114',
    sourcemap: true,
    rollupOptions: {
      input: {
        options: fileURLToPath(new URL('./options.html', import.meta.url)),
        popup: fileURLToPath(new URL('./popup.html', import.meta.url)),
        'service-worker': fileURLToPath(new URL('./src/background/service-worker.ts', import.meta.url)),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}));
