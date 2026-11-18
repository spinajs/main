import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { studioKeys, useStudioQuery } from './query';

function cache() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useStudioQuery', () => {
  it('answers what the loader resolves, handing it the abort signal of the query', async () => {
    const load = vi.fn((signal: AbortSignal) => Promise.resolve(signal.aborted ? 'aborted' : 'loaded'));
    const { result } = renderHook(() => useStudioQuery(studioKeys.item('probe', 'a'), load), { wrapper: cache() });
    await waitFor(() => expect(result.current.data).toBe('loaded'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reports what the loader rejects with', async () => {
    const { result } = renderHook(() => useStudioQuery(studioKeys.item('probe', 'b'), () => Promise.reject(new Error('boom'))), { wrapper: cache() });
    await waitFor(() => expect(result.current.error).toEqual(new Error('boom')));
  });

  it('stays idle without a loader', () => {
    const { result } = renderHook(() => useStudioQuery<number>(studioKeys.item('probe', 'c'), null), { wrapper: cache() });
    expect(result.current).toMatchObject({ data: undefined, error: null, fetchStatus: 'idle' });
  });

  it('keeps what the last key answered while the next one loads, and drops it when the loader goes away', async () => {
    let answer: (value: string) => void = () => {};
    const slow = () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      });
    const loaders: Record<string, (() => Promise<string>) | null> = { a: () => Promise.resolve('first'), b: slow, c: null };
    const { result, rerender } = renderHook(({ id }: { id: string }) => useStudioQuery(studioKeys.list('probe', id), loaders[id]), { wrapper: cache(), initialProps: { id: 'a' } });
    await waitFor(() => expect(result.current.data).toBe('first'));
    rerender({ id: 'b' });
    expect(result.current).toMatchObject({ data: 'first', isPlaceholderData: true, error: null });
    answer('second');
    await waitFor(() => expect(result.current).toMatchObject({ data: 'second', isPlaceholderData: false }));
    rerender({ id: 'c' });
    expect(result.current.data).toBeUndefined();
  });
});

describe('studioKeys', () => {
  it('keeps a collection apart from one item of the same name', () => {
    expect(studioKeys.list('traces')).toEqual(['studio', 'traces', 'list']);
    expect(studioKeys.item('traces', 't1')).toEqual(['studio', 'traces', 'item', 't1']);
  });
});
