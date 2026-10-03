import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './lib/cloud/schema.ts',
  out: './drizzle',
});
