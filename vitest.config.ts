import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Live contract tests call the exchanges; they run only with `pnpm test:live`.
    exclude: [...configDefaults.exclude, 'tests/live/**'],
    globals: true,
    setupFiles: ['tests/setup.ts'],
  },
})
