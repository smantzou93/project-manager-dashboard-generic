/**
 * Bridge to the Python importer.
 *
 * The web tier does not reimplement any import logic — it runs the same CLI a
 * developer runs, with `--json`, and relays the result. Two implementations of
 * "what does this CSV mean" would drift, and the one people trust would be
 * whichever they looked at last.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { logger } from '@pmdash/logger';

import { ApiError } from './errors';

const run = promisify(execFile);
const log = logger('api');

/** Uploads above this are refused outright rather than read into memory. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Found by walking up for a marker rather than assuming a depth.
 *
 * `next dev apps/web` run from the repository root has cwd at the root, while
 * `npm run dev` inside the workspace has it at apps/web. A fixed
 * `../..` is right in one case and silently points outside the repository in
 * the other — which it did, producing "spawn /Users/me/apps/.../python ENOENT".
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'apps', 'ingestion', 'pyproject.toml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();
const PYTHON = path.join(REPO_ROOT, 'apps', 'ingestion', '.venv', 'bin', 'python');

export type Command = 'inspect' | 'dry-run' | 'import';

/**
 * Writes the upload to a private temp directory and runs the importer on it.
 *
 * The file is never executed, never served, and never written inside the
 * repository. `mkdtemp` gives a fresh 0700 directory per request, so two
 * concurrent uploads cannot see each other's data.
 *
 * Arguments are passed as an array to `execFile`, never interpolated into a
 * shell string — a filename is user input and a shell would treat it as code.
 */
export async function runImport(
  command: Command,
  file: { name: string; bytes: ArrayBuffer },
  options: { project?: string; map?: string[]; maxRejectRatio?: number } = {},
): Promise<unknown> {
  if (file.bytes.byteLength === 0) {
    throw new ApiError('VALIDATION_FAILED', 'The file is empty.');
  }
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `That file is ${(file.bytes.byteLength / 1e6).toFixed(1)}MB; the limit is ${MAX_UPLOAD_BYTES / 1e6}MB.`,
    );
  }

  // Keep only the basename and strip anything that is not plainly a filename.
  // The upload names the file, and a name is not a path.
  const safeName = `${path
    .basename(file.name)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 80)}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'pmdash-upload-'));
  const target = path.join(dir, safeName.endsWith('.csv') ? safeName : `${safeName}.csv`);
  await writeFile(target, Buffer.from(file.bytes));

  const args = ['-m', 'pmdash_ingest', command, target, '--json'];
  if (options.project) args.push('--project', options.project);
  for (const pair of options.map ?? []) args.push('--map', pair);
  if (options.maxRejectRatio !== undefined) {
    args.push('--max-reject-ratio', String(options.maxRejectRatio));
  }

  const started = performance.now();
  try {
    const { stdout } = await run(PYTHON, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, PMD_JSON_LOGS: '1' },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    log.info('import_ran', {
      command,
      duration_ms: Math.round(performance.now() - started),
      bytes: file.bytes.byteLength,
    });
    return JSON.parse(stdout) as unknown;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };

    // The CLI exits non-zero for a *refused* import — too many rejects, a bad
    // mapping — and still prints its JSON report. That is a result to show the
    // user, not a server error, so it is relayed rather than swallowed.
    if (e.stdout?.trim().startsWith('{')) {
      log.warn('import_refused', { command, exit: e.code });
      return JSON.parse(e.stdout) as unknown;
    }

    log.error('import_failed', err, { command });
    if (!(await pythonAvailable())) {
      throw new ApiError(
        'INTERNAL',
        'The Python importer is not installed. Run `npm run ingest:setup`.',
      );
    }
    throw new ApiError(
      'INTERNAL',
      'The importer failed to run. Quote the correlation id when reporting this.',
    );
  }
}

async function pythonAvailable(): Promise<boolean> {
  try {
    await run(PYTHON, ['-c', 'import pmdash_ingest'], { cwd: REPO_ROOT, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
