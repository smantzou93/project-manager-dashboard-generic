/**
 * Redaction, applied at the serialiser.
 *
 * Deliberately not at each call site. Per-call-site redaction works right up
 * until somebody forgets, and the thing they forget is by definition the thing
 * that then sits in a log file. This repository is public and logs get pasted
 * into issues, so the serialiser is the only place that can be trusted.
 */

/** Keys whose values are replaced wholesale, at any depth. */
const SECRET_KEY =
  /(password|secret|token|api[-_]?key|credential|authorization|cookie|database_url|dsn)/i;

/** A connection string that arrived inside a message rather than as a field. */
const DSN = /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi;

/** Bearer tokens and long opaque strings in free text. */
const BEARER = /(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi;

export const REDACTED = '[redacted]';

/** Depth limit: a cyclic or pathological object must not hang the logger. */
const MAX_DEPTH = 8;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';

  if (typeof value === 'string') {
    return value.replace(DSN, `$1${REDACTED}$2`).replace(BEARER, `$1${REDACTED}`);
  }
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message, depth + 1),
      // Stack stays out of the serialised record by default; callers that
      // genuinely want it pass it explicitly, and it never reaches a client.
      ...(value.cause ? { cause: redact(value.cause, depth + 1) } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}
