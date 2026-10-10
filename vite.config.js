import { defineConfig } from 'vite';

/**
 * Tighten the Content-Security-Policy for production builds. The dev server injects <style> tags (needs
 * 'unsafe-inline'); the built app only uses its own stylesheet and loads the hls.js worker from a real
 * file, so neither inline styles nor blob: workers are needed there.
 */
function strictBuildCsp() {
  return {
    name: 'strict-build-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const rules = [
        ["style-src 'self' 'unsafe-inline'", "style-src 'self'"],
        ["worker-src 'self' blob:", "worker-src 'self'"],
      ];
      return rules.reduce((out, [from, to]) => {
        if (!out.includes(from)) throw new Error(`strict-build-csp: "${from}" not found in index.html`);
        return out.replace(from, to);
      }, html);
    },
  };
}

// Relative base so the build works from any GitHub Pages path
// (https://<user>.github.io/<repo>/) or a custom domain without changes.
export default defineConfig({
  base: './',
  plugins: [strictBuildCsp()],
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
    // Tests run without the site's built-in relay unless they set one (vi.stubEnv) themselves.
    env: { VITE_BUILTIN_RELAY: 'off' },
  },
});
