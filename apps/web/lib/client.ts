'use client';

/**
 * Typed API client for the browser.
 *
 * Every type here comes from `responses.ts` — the same schemas the OpenAPI
 * document is generated from and the contract tests validate against. So a
 * field the API stops returning is a compile error in the component, not
 * `undefined` on a screen.
 *
 * Server components do not use this: they call the query layer directly,
 * because an HTTP round trip to the same process would be slower for no
 * correctness gain. The contract is shared; the transport does not need to be.
 *
 * The directive is the first line, not buried under this comment. A bundler
 * will not treat the module as client code otherwise, and the symptom is
 * silent: the component renders, hydration never runs, the effect never
 * fires, and the screen simply sits on its loading state with no error.
 */

import type { ApiErrorBody, SavedView, SearchResponse, Taxonomy, Term } from './responses';

/** A failure the API described. Carries the stable code and the trace id. */
export class ApiCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly correlationId: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const envelope = body as ApiErrorBody | null;
    if (envelope?.error) {
      throw new ApiCallError(
        envelope.error.code,
        envelope.error.message,
        envelope.error.correlationId,
        envelope.error.details,
      );
    }
    // No envelope means something failed before the handler — a proxy, or the
    // server being down. Say that rather than pretending it was an API error.
    throw new ApiCallError(
      'INTERNAL',
      `The server returned ${response.status} with no error body.`,
      response.headers.get('x-correlation-id') ?? 'unknown',
    );
  }

  return body as T;
}

export const api = {
  search: (params: URLSearchParams) => call<SearchResponse>(`/search?${params}`),

  taxonomies: (archived = false) =>
    call<{ taxonomies: Taxonomy[] }>(`/taxonomies${archived ? '?archived=true' : ''}`),

  createTerm: (input: {
    taxonomyKey: string;
    slug: string;
    label: string;
    statusCategory?: string | null;
    color?: string | null;
  }) => call<{ term: Term }>('/taxonomies', { method: 'POST', body: JSON.stringify(input) }),

  updateTerm: (id: string, input: Record<string, unknown>) =>
    call<{ term: Term }>(`/terms/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),

  archiveTerm: (id: string) =>
    call<{ archived: true; usageCount: number }>(`/terms/${id}`, { method: 'DELETE' }),

  deleteTerm: (id: string) =>
    call<{ deleted: true }>(`/terms/${id}?hard=true`, { method: 'DELETE' }),

  restoreTerm: (id: string) => call<{ restored: true }>(`/terms/${id}`, { method: 'POST' }),

  termUsage: (id: string) =>
    call<{ usage: { total: number; workItems: number; projects: number } }>(`/terms/${id}`),

  views: () => call<{ views: SavedView[] }>('/views'),

  createView: (input: { name: string; config: unknown }) =>
    call<{ view: SavedView }>('/views', { method: 'POST', body: JSON.stringify(input) }),

  deleteView: (id: string) => call<{ deleted: true }>(`/views/${id}`, { method: 'DELETE' }),
};
