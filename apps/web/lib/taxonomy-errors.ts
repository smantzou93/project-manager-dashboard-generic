import { TaxonomyRuleError } from '@pmdash/db/queries';

import { ApiError } from './errors';

/**
 * Turns a taxonomy rule violation into the right HTTP code.
 *
 * The query layer throws domain errors rather than HTTP ones, so it stays
 * usable from the seed, the CLI and tests. This is the one place that mapping
 * lives, instead of every route restating it.
 */
export function toApiError(err: unknown): unknown {
  if (!(err instanceof TaxonomyRuleError)) return err;

  switch (err.rule) {
    case 'system_taxonomy':
      return new ApiError('SYSTEM_TAXONOMY', err.message, err.details);
    case 'term_in_use':
      return new ApiError('TERM_IN_USE', err.message, err.details);
    case 'workflow_integrity':
      return new ApiError('TAXONOMY_CONSTRAINT', err.message, err.details);
    case 'duplicate_slug':
      return new ApiError('CONFLICT', err.message, err.details);
  }
}
