/**
 * The error envelope.
 *
 * One shape for every failure, with a stable `code` a caller can branch on
 * rather than parsing prose. Agents will be writing against these routes, and
 * an error they have to regex is an error they will get wrong.
 *
 *     { "error": { "code": "VALIDATION_FAILED", "message": "...",
 *                  "details": {...}, "correlationId": "a1b2c3" } }
 *
 * The correlation id is always present. It is what connects a client-side
 * failure to the server log line holding the stack — which is the only place
 * the stack ever goes. This repository is public and the logs are not.
 */

/**
 * The complete vocabulary. Adding one means adding it here first, so the list
 * stays the documentation rather than something reconstructed by grepping.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  /** A taxonomy rule that exists to keep the metrics computable. */
  TAXONOMY_CONSTRAINT: 409,
  /** The term is referenced by rows that must not lose their meaning. */
  TERM_IN_USE: 409,
  /** A structural taxonomy the UI depends on; its terms are editable, it is not. */
  SYSTEM_TAXONOMY: 409,
  UNPROCESSABLE: 422,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get status(): number {
    return ERROR_CODES[this.code];
  }
}

/** Convenience constructors, so a route reads as the rule it is enforcing. */
export const notFound = (what: string) => new ApiError('NOT_FOUND', `${what} not found`);

export const conflict = (message: string, details?: unknown) =>
  new ApiError('CONFLICT', message, details);

export const taxonomyConstraint = (message: string, details?: unknown) =>
  new ApiError('TAXONOMY_CONSTRAINT', message, details);

export const termInUse = (message: string, details?: unknown) =>
  new ApiError('TERM_IN_USE', message, details);
