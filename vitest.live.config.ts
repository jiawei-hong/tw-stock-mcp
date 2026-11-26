import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Live contract tests: `pnpm test:live`. Every tests/live/**\/*.live.test.ts
 * file calls the real exchange endpoints with global fetch. No setup file or
 * shared helper is needed. Files run one at a time and the tests in a file in
 * order, so the exchanges never see a burst; a failed test is retried once to
 * ride out a transient network error.
 */
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    exclude: [...configDefaults.exclude],
    globals: true,
    fileParallelism: false,
    maxConcurrency: 1,
    // Some datasets are 10-30 MB (TDCC) or slow to build (TWSE OpenAPI).
    testTimeout: 180_000,
    hookTimeout: 180_000,
    retry: 1,
    // One line per endpoint in the CI log.
    reporters: ['verbose'],
  },
})
