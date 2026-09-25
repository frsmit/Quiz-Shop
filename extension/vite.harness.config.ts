import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Builds the development harness (src/dev/live-demo.ts) as a single IIFE that
 * can be pasted into any page's console. Not part of the extension bundle.
 */
export default defineConfig({
  build: {
    outDir: 'dist-dev',
    emptyOutDir: true,
    target: 'chrome114',
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./src/dev/live-demo.ts', import.meta.url)),
      formats: ['iife'],
      name: 'AiBrowserAssistantHarness',
      fileName: () => 'live-demo.js',
    },
  },
});
