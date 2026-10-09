import { defineConfig } from 'vite';

// Relative base so the build works from any GitHub Pages path
// (https://<user>.github.io/<repo>/) or a custom domain without changes.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.js'],
  },
});
