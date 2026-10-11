/**
 * Loads the repository-root .env into process.env.
 *
 * Next reads `.env` relative to the app directory, which in this monorepo is
 * `apps/web`. The real file lives at the repository root, next to
 * docker-compose.yml, because the database, the ingestion service and the
 * scripts all share it.
 *
 * Without this the app only works when something else happens to have exported
 * the variables first -- which is exactly the sort of invisible dependency
 * that makes a test suite pass locally and fail everywhere else. (It did: the
 * Playwright webServer started a clean shell and every page 500'd, while the
 * same tests passed against a server started by hand.)
 *
 * Existing values win, so an explicit override on the command line still takes
 * precedence over the file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_ENV = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');

export function loadRootEnv() {
  if (!existsSync(ROOT_ENV)) return;

  for (const line of readFileSync(ROOT_ENV, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes, the way a shell would.
    if (value.length > 1 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);

    if (process.env[key] === undefined) process.env[key] = value;
  }
}
