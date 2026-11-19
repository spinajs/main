import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';

const MAX_RETRIES = 2;

/** A refusal or a missing resource (4xx) answers the same on a retry; a network failure or a 5xx may not. */
export const shouldRetry = (failures: number, error: unknown): boolean => !(error instanceof ApiError && error.status < 500) && failures < MAX_RETRIES;

export const createStudioQueryClient = (): QueryClient => new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });

/** `client` is for tests: a fresh cache per render, without retries. */
export function QueryProvider({ client, children }: { client?: QueryClient; children: ReactNode }) {
  const [own] = useState(createStudioQueryClient);
  return <QueryClientProvider client={client ?? own}>{children}</QueryClientProvider>;
}
