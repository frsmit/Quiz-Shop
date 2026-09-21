import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The content script is bundled on its own as a self-contained IIFE. Chrome
 * loads declarative content scripts as classic scripts, so code splitting and
 * `import` statements are not available at this entry point.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome114',
    sourcemap: true,
    lib: {
      entry: fileURLToPath(new URL('./src/content/content.ts', import.meta.url)),
      formats: ['iife'],
      name: 'AiBrowserAssistantContent',
      fileName: () => 'content.js',
    },
  },
});
