/**
 * Vitest config — frontend. Mirrors the backend `vitest.config.ts` shape
 * with two delta: `environment: 'jsdom'` (React components need a DOM)
 * and a setup file that imports `@testing-library/jest-dom` so matchers
 * like `toBeInTheDocument()` are available.
 *
 * # Why a separate config file rather than embedding in `vite.config.ts`
 *
 * The `vite.config.ts` is loaded by the dev server / Vite build, where
 * we don't want to pull jest-dom matchers into the production bundle.
 * Vitest reads `vitest.config.ts` first when present — the `defineConfig`
 * from `vitest/config` returns a Vite-compatible shape so plugins still
 * work.
 *
 * # Why minimal
 *
 * Same rationale as backend's config: this codebase doesn't yet need
 * coverage thresholds or watch mode by default. The canary tests
 * cover pure logic; we expect this config to grow with the test
 * suite over time.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    // Co-located tests: `Component.test.tsx` next to `Component.tsx`.
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    // One-shot by default; use `test:watch` for local iteration.
    watch: false,
    // Explicit imports keep tests grep-friendly (matches backend).
    globals: false,
    // Some MeshSDK-adjacent modules grab `window.crypto.subtle` on
    // module load. The default jsdom polyfills handle this, but the
    // canary tests don't touch wallet code so we keep the environment
    // pristine for now.
  },
});
