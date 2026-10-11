import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside Next.js, so nothing has loaded .env yet. The file
// lives at the repo root, two levels up from this package.
loadEnv({ path: new URL('../../.env', import.meta.url).pathname });

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Verbose diffs, and a prompt before anything destructive -- this config is
  // also what agents run, and a silent column drop is not recoverable.
  verbose: true,
  strict: true,
});
