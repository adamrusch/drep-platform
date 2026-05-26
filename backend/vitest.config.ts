import { defineConfig } from 'vitest/config';

/**
 * Vitest config — minimal. Tests live next to source as `*.test.ts`.
 *
 * Why minimal: this codebase doesn't (yet) need DOM, jsdom, or
 * coverage thresholds. Adding them later is cheap; over-configuring
 * the harness now would just be ceremony. Tests are pure-Node unit
 * tests that exercise the lib helpers and handler-internal logic
 * directly — anything that hits AWS / Koios / Blockfrost lives behind
 * a mock via vitest's `vi.mock`.
 */
export default defineConfig({
  test: {
    // Co-located tests: `lib/recognition.test.ts` next to
    // `lib/recognition.ts`. Avoids a parallel `__tests__/` tree.
    include: ['src/**/*.test.ts'],
    // No watch by default — `npm test` should be one-shot for CI/audit.
    // `npm run test:watch` is available for local iteration.
    watch: false,
    // Globals off — explicit `import { describe, it, expect } from 'vitest'`
    // keeps the test files self-describing and grep-friendly.
    globals: false,
  },
});
