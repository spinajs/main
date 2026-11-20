import { keepPreviousData, skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query';

export const studioKeys = {
  all: ['studio'] as const,
  capabilities: ['studio', 'capabilities'] as const,
  /** A collection, narrowed by what it was asked with; also the key prefix of a grid source. */
  list: (name: string, ...scope: readonly unknown[]) => ['studio', name, 'list', ...scope] as const,
  item: (name: string, ...id: readonly unknown[]) => ['studio', name, 'item', ...id] as const,
};

/**
 * `load` gets the abort signal of the query; `null` keeps the query idle (a page still waiting for its input) and
 * answers no data. While a new key loads, `data` is still what the last key answered (`isPlaceholderData` says so),
 * so a page keeps its content through a change of filter instead of falling back to its loading state.
 */
export function useStudioQuery<T>(queryKey: readonly unknown[], load: ((signal: AbortSignal) => Promise<T>) | null): UseQueryResult<T> {
  return useQuery<T>({ queryKey, queryFn: load ? ({ signal }) => load(signal) : skipToken, placeholderData: load ? keepPreviousData : undefined });
}
