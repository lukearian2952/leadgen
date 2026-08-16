import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Outside node_modules on purpose. Vite's default cache location is
  // node_modules/.vite, which is unwritable whenever the install ran as root —
  // and that failure surfaces as an unrelated-looking EACCES after the tests
  // have already passed.
  cacheDir: '.vitest-cache',
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // These are pure-function tests; anything needing a database or a live
    // service belongs in scripts/ as a self-test, not here.
    testTimeout: 10_000,
  },
})
