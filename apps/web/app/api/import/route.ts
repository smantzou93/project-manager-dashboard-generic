import { logger, newCorrelationId, withCorrelation } from '@pmdash/logger';
import { NextResponse, type NextRequest } from 'next/server';

import { ApiError } from '../../../lib/errors';
import { MAX_UPLOAD_BYTES, runImport, type Command } from '../../../lib/ingest';

const log = logger('api');

const COMMANDS: Command[] = ['inspect', 'dry-run', 'import'];

/**
 * POST /api/import
 *
 * multipart/form-data: `file`, `command`, optional `project` and repeated
 * `map` entries.
 *
 * Not handled by `route()` because that helper parses JSON; this takes a file.
 * The error envelope and correlation id are produced the same way so a client
 * cannot tell the difference.
 *
 * `import` is the only command that writes. `inspect` and `dry-run` are safe
 * to call freely — the dry run executes the identical pipeline inside a
 * transaction that is rolled back.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = request.headers.get('x-correlation-id') ?? newCorrelationId();

  return withCorrelation({ correlationId, route: '/api/import' }, async () => {
    try {
      const form = await request.formData();
      // form.get can return a File, and String(file) would quietly become
      // "[object File]" and then fail the includes() check with a confusing
      // message. Check the type rather than coercing.
      const rawCommand = form.get('command');
      const command = (typeof rawCommand === 'string' ? rawCommand : 'inspect') as Command;
      if (!COMMANDS.includes(command)) {
        throw new ApiError('VALIDATION_FAILED', `command must be one of: ${COMMANDS.join(', ')}`);
      }

      const file = form.get('file');
      if (!(file instanceof File)) {
        throw new ApiError('VALIDATION_FAILED', 'No file was uploaded.');
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `That file is ${(file.size / 1e6).toFixed(1)}MB; the limit is ${MAX_UPLOAD_BYTES / 1e6}MB.`,
        );
      }
      // Checked by extension rather than by the browser's content type, which
      // is unreliable: macOS reports CSV as application/vnd.ms-excel.
      if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
        throw new ApiError('VALIDATION_FAILED', 'Expected a .csv file.');
      }

      const project = form.get('project');
      const result = await runImport(
        command,
        { name: file.name, bytes: await file.arrayBuffer() },
        {
          project: typeof project === 'string' && project ? project : undefined,
          map: form.getAll('map').filter((m): m is string => typeof m === 'string'),
        },
      );

      return NextResponse.json(result, { headers: { 'x-correlation-id': correlationId } });
    } catch (err) {
      if (err instanceof ApiError) {
        log.warn('import_rejected', { code: err.code });
        return NextResponse.json(
          { error: { code: err.code, message: err.message, correlationId } },
          { status: err.status, headers: { 'x-correlation-id': correlationId } },
        );
      }
      log.error('import_route_failed', err);
      return NextResponse.json(
        {
          error: {
            code: 'INTERNAL',
            message: 'The upload could not be processed.',
            correlationId,
          },
        },
        { status: 500, headers: { 'x-correlation-id': correlationId } },
      );
    }
  });
}
