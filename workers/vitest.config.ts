import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // These are pure-function tests; anything needing a database or a live
    // service belongs in scripts/ as a self-test, not here.
    testTimeout: 10_000,
  },
})
