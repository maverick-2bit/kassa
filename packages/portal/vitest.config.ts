import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integrationstests brauchen ein echtes PostgreSQL → eigener Lauf via test:integration
    exclude: ['**/node_modules/**', 'tests/integration/**'],
  },
})
