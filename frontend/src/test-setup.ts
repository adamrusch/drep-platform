/**
 * Vitest setup — runs once before each test file.
 *
 * Imports `@testing-library/jest-dom` so the custom matchers like
 * `toBeInTheDocument()`, `toHaveClass()`, `toHaveStyle()` are wired
 * into the global `expect` object. Without this import the matchers
 * fall back to the default vitest assertions, which return
 * "TypeError: expect(...).toBeInTheDocument is not a function" on
 * any test that uses them.
 *
 * # Why a setup file instead of `import` per test
 *
 * `@testing-library/jest-dom` patches `expect` globally. Importing
 * once in setup keeps each test file focused on its component logic
 * — they don't need to re-import the matchers boilerplate.
 *
 * # Explicit cleanup
 *
 * Vitest is configured with `globals: false` (matches backend) so
 * the RTL auto-`afterEach(cleanup)` hook does NOT auto-register.
 * Wire it up here so React components unmount between tests; without
 * this, queries from a prior test's render leak into the next
 * test's DOM and cause `getByText` ambiguity failures.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  cleanup();
});
