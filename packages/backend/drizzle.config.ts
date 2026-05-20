import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema:  './src/db/schema.ts',
  out:     './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://kassa:kassa@localhost:5432/kassa',
  },
  verbose: true,
  strict:  true,
})
